'use strict';

/**
 * Bank connectors (Plaid).
 *
 * Phase 1 — establish access only:
 *  - Store Plaid item access_token in SSM SecureString (/r2finance/connectors/*)
 *  - API keys in SSM /r2finance/plaid (never git)
 *  - Store non-secret connection metadata in DDB (CONNECTOR#…)
 *  - Probe live accounts/balances via Plaid
 *  - Do NOT write bank transactions into DDB TXN# / ledger rows
 */

const crypto = require('crypto');
const ddb = require('./ddb');
const ssm = require('./ssm');
const plaid = require('./plaid');
const {
  boaItemSsmParam,
  chaseItemSsmParam,
  ledgerPlanId,
} = require('./config');

/**
 * Plaid forbids emails/PII in user.client_user_id — use a stable hash instead.
 */
function plaidClientUserId(email) {
  const raw = String(email || 'r2finance')
    .trim()
    .toLowerCase();
  return crypto.createHash('sha256').update(`r2finance:${raw}`).digest('hex').slice(0, 32);
}

/** Supported bank connectors (access-only). */
const BANKS = {
  boa: {
    id: 'boa',
    name: 'Bank of America',
    institutionId: plaid.BOA_INSTITUTION_ID,
    sk: 'CONNECTOR#BOA',
    /** SSM SecureString path for Plaid item access_token — never in git. */
    ssmParam: boaItemSsmParam,
    short: 'BoA',
  },
  chase: {
    id: 'chase',
    name: 'Chase',
    institutionId: plaid.CHASE_INSTITUTION_ID,
    sk: 'CONNECTOR#CHASE',
    ssmParam: chaseItemSsmParam,
    short: 'Chase',
  },
};

function resolveBank(bankId) {
  const key = String(bankId || '')
    .trim()
    .toLowerCase();
  const bank = BANKS[key];
  if (!bank) {
    const err = new Error(
      `Unknown connector "${bankId}". Supported: ${Object.keys(BANKS).join(', ')}`,
    );
    err.status = 404;
    err.code = 'unknown_connector';
    throw err;
  }
  return bank;
}

function metaKey(bank, planId = ledgerPlanId) {
  return { pk: ddb.planPk(planId), sk: bank.sk };
}

async function getMeta(bank, planId = ledgerPlanId) {
  return ddb.getItem(ddb.planPk(planId), bank.sk);
}

async function getAccessToken(bank) {
  const j = await ssm.getParameterJson(bank.ssmParam, {
    decrypt: true,
    useCache: false,
  });
  if (!j) return null;
  return (j.access_token || j.accessToken || '').trim() || null;
}

function mapAccount(a) {
  return {
    accountId: a.account_id,
    name: a.name || a.official_name || 'Account',
    officialName: a.official_name || null,
    mask: a.mask || null,
    type: a.type || null,
    subtype: a.subtype || null,
    balances: {
      available: a.balances?.available ?? null,
      current: a.balances?.current ?? null,
      limit: a.balances?.limit ?? null,
      isoCurrencyCode: a.balances?.iso_currency_code || 'USD',
    },
  };
}

/**
 * Status for UI — never returns access_token.
 */
async function status(bankId, planId = ledgerPlanId) {
  const bank = resolveBank(bankId);
  const configured = await plaid.isConfigured();
  const meta = await getMeta(bank, planId);
  const hasToken = !!(await getAccessToken(bank));
  const connected = !!(meta?.connected && hasToken);

  return {
    connectorId: bank.id,
    provider: 'plaid',
    institution: bank.name,
    institutionId: meta?.institutionId || bank.institutionId,
    configured,
    connected,
    itemId: meta?.itemId || null,
    connectedAt: meta?.connectedAt || null,
    connectedBy: meta?.connectedBy || null,
    institutionName: meta?.institutionName || bank.name,
    accountCount: meta?.accountCount ?? null,
    accountsPreview: meta?.accountsPreview || [],
    note:
      'Access only — bank transactions are not written to the R2Finance DDB ledger yet.',
  };
}

async function listStatus(planId = ledgerPlanId) {
  const connectors = [];
  for (const id of Object.keys(BANKS)) {
    connectors.push(await status(id, planId));
  }
  return { connectors };
}

/**
 * Exchange Plaid public_token → access_token; store secrets + meta.
 * Does not import transactions into DDB.
 */
async function exchangeAndStore(bankId, { publicToken, email, metadata }) {
  const bank = resolveBank(bankId);
  if (!publicToken) {
    const err = new Error('publicToken required');
    err.status = 400;
    throw err;
  }

  const exchanged = await plaid.exchangePublicToken(publicToken);
  const accessToken = exchanged.access_token;
  const itemId = exchanged.item_id;

  let accounts = [];
  let institutionId =
    metadata?.institution?.institution_id || bank.institutionId;
  let institutionName = metadata?.institution?.name || bank.name;

  try {
    const acctRes = await plaid.getAccounts(accessToken);
    accounts = (acctRes.accounts || []).map(mapAccount);
    if (acctRes.item?.institution_id) {
      institutionId = acctRes.item.institution_id;
    }
  } catch (e) {
    console.warn('accounts/get after exchange failed', e.message);
  }

  try {
    if (institutionId) {
      const inst = await plaid.getInstitution(institutionId);
      if (inst.institution?.name) institutionName = inst.institution.name;
    }
  } catch {
    /* optional */
  }

  await ssm.putParameterJson(
    bank.ssmParam,
    {
      access_token: accessToken,
      item_id: itemId,
      institution_id: institutionId,
      connector_id: bank.id,
      updatedAt: new Date().toISOString(),
    },
    { description: `R2Finance ${bank.name} Plaid item access token` },
  );

  const now = Date.now();
  const preview = accounts.map((a) => ({
    accountId: a.accountId,
    name: a.name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
  }));

  await ddb.putItem({
    ...metaKey(bank),
    entityType: 'CONNECTOR',
    connectorId: bank.id,
    provider: 'plaid',
    connected: true,
    itemId,
    institutionId,
    institutionName,
    accountCount: accounts.length,
    accountsPreview: preview,
    connectedAt: now,
    connectedBy: email || null,
    importTransactionsToDdb: false,
    updatedAt: now,
  });

  return {
    ok: true,
    connected: true,
    connectorId: bank.id,
    itemId,
    institutionId,
    institutionName,
    accounts,
    importTransactionsToDdb: false,
  };
}

/**
 * Live probe of accounts via Plaid (not from DDB ledger).
 */
async function probeAccounts(bankId, planId = ledgerPlanId) {
  const bank = resolveBank(bankId);
  const accessToken = await getAccessToken(bank);
  if (!accessToken) {
    const err = new Error(`${bank.name} not connected`);
    err.status = 404;
    err.code = 'not_connected';
    throw err;
  }

  const acctRes = await plaid.getAccounts(accessToken);
  const accounts = (acctRes.accounts || []).map(mapAccount);
  const meta = await getMeta(bank, planId);

  if (meta) {
    await ddb.putItem({
      ...meta,
      accountCount: accounts.length,
      accountsPreview: accounts.map((a) => ({
        accountId: a.accountId,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
      })),
      lastProbedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return {
    ok: true,
    connectorId: bank.id,
    institutionName: meta?.institutionName || bank.name,
    itemId: meta?.itemId || acctRes.item?.item_id || null,
    accounts,
    importTransactionsToDdb: false,
    source: 'plaid_live',
  };
}

async function disconnect(bankId, planId = ledgerPlanId) {
  const bank = resolveBank(bankId);
  const accessToken = await getAccessToken(bank);
  if (accessToken) {
    try {
      await plaid.removeItem(accessToken);
    } catch (e) {
      console.warn('plaid item/remove', e.message);
    }
  }
  try {
    await ssm.deleteParameter(bank.ssmParam);
  } catch (e) {
    console.warn(`delete ${bank.id} item SSM param`, e.message);
  }

  const existing = await getMeta(bank, planId);
  if (existing) {
    await ddb.putItem({
      ...existing,
      connected: false,
      itemId: null,
      accountCount: 0,
      accountsPreview: [],
      disconnectedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return { ok: true, connected: false, connectorId: bank.id };
}

async function createLinkToken(bankId, { email } = {}) {
  const bank = resolveBank(bankId);
  return plaid.createLinkToken({
    clientUserId: plaidClientUserId(email),
    institutionId: bank.institutionId,
    bankKey: bank.id,
  });
}

module.exports = {
  BANKS,
  resolveBank,
  status,
  listStatus,
  exchangeAndStore,
  probeAccounts,
  disconnect,
  createLinkToken,
  CONNECTOR_SK_BOA: BANKS.boa.sk,
  CONNECTOR_SK_CHASE: BANKS.chase.sk,
};
