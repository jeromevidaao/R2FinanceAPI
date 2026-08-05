'use strict';

/**
 * Bank connectors (Plaid).
 *
 * Phase 1 — establish access only:
 *  - Store Plaid item access_token in Secrets Manager
 *  - Store non-secret connection metadata in DDB (CONNECTOR#…)
 *  - Probe live accounts/balances via Plaid
 *  - Do NOT write bank transactions into DDB TXN# / ledger rows
 */

const ddb = require('./ddb');
const secrets = require('./secrets');
const plaid = require('./plaid');
const {
  boaItemSecretId,
  ledgerPlanId,
} = require('./config');

const CONNECTOR_SK = 'CONNECTOR#BOA';

function metaKey(planId = ledgerPlanId) {
  return { pk: ddb.planPk(planId), sk: CONNECTOR_SK };
}

async function getMeta(planId = ledgerPlanId) {
  return ddb.getItem(ddb.planPk(planId), CONNECTOR_SK);
}

async function getAccessToken() {
  try {
    const j = await secrets.getSecretJson(boaItemSecretId, { cache: false });
    return (j.access_token || j.accessToken || '').trim() || null;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return null;
    throw e;
  }
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
async function status(planId = ledgerPlanId) {
  const configured = await plaid.isConfigured();
  const meta = await getMeta(planId);
  const hasToken = !!(await getAccessToken());
  const connected = !!(meta?.connected && hasToken);

  return {
    provider: 'plaid',
    institution: 'Bank of America',
    institutionId: meta?.institutionId || plaid.BOA_INSTITUTION_ID,
    configured,
    connected,
    itemId: meta?.itemId || null,
    connectedAt: meta?.connectedAt || null,
    connectedBy: meta?.connectedBy || null,
    institutionName: meta?.institutionName || 'Bank of America',
    accountCount: meta?.accountCount ?? null,
    accountsPreview: meta?.accountsPreview || [],
    note:
      'Access only — bank transactions are not written to the R2Finance DDB ledger yet.',
  };
}

/**
 * Exchange Plaid public_token → access_token; store secrets + meta.
 * Does not import transactions into DDB.
 */
async function exchangeAndStore({ publicToken, email, metadata }) {
  if (!publicToken) {
    const err = new Error('publicToken required');
    err.status = 400;
    throw err;
  }

  const exchanged = await plaid.exchangePublicToken(publicToken);
  const accessToken = exchanged.access_token;
  const itemId = exchanged.item_id;

  let accounts = [];
  let institutionId = metadata?.institution?.institution_id || plaid.BOA_INSTITUTION_ID;
  let institutionName =
    metadata?.institution?.name || 'Bank of America';

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

  await secrets.putSecretJson(
    boaItemSecretId,
    {
      access_token: accessToken,
      item_id: itemId,
      institution_id: institutionId,
      updatedAt: new Date().toISOString(),
    },
    { description: 'R2Finance Bank of America Plaid item access token' },
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
    ...metaKey(),
    entityType: 'CONNECTOR',
    connectorId: 'boa',
    provider: 'plaid',
    connected: true,
    itemId,
    institutionId,
    institutionName,
    accountCount: accounts.length,
    accountsPreview: preview,
    connectedAt: now,
    connectedBy: email || null,
    // Explicit: no DDB ledger transaction import in this phase
    importTransactionsToDdb: false,
    updatedAt: now,
  });

  return {
    ok: true,
    connected: true,
    itemId,
    institutionId,
    institutionName,
    accounts,
    importTransactionsToDdb: false,
  };
}

/**
 * Live probe of BoA accounts via Plaid (not from DDB ledger).
 */
async function probeAccounts(planId = ledgerPlanId) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    const err = new Error('Bank of America not connected');
    err.status = 404;
    err.code = 'not_connected';
    throw err;
  }

  const acctRes = await plaid.getAccounts(accessToken);
  const accounts = (acctRes.accounts || []).map(mapAccount);
  const meta = await getMeta(planId);

  // Refresh preview metadata only (still no TXN# writes)
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
    institutionName: meta?.institutionName || 'Bank of America',
    itemId: meta?.itemId || acctRes.item?.item_id || null,
    accounts,
    importTransactionsToDdb: false,
    source: 'plaid_live',
  };
}

async function disconnect(planId = ledgerPlanId) {
  const accessToken = await getAccessToken();
  if (accessToken) {
    try {
      await plaid.removeItem(accessToken);
    } catch (e) {
      console.warn('plaid item/remove', e.message);
    }
  }
  try {
    await secrets.deleteSecret(boaItemSecretId);
  } catch (e) {
    console.warn('delete boa item secret', e.message);
  }

  const existing = await getMeta(planId);
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

  return { ok: true, connected: false };
}

async function createLinkToken({ email }) {
  return plaid.createBoaLinkToken({
    clientUserId: email || 'r2finance',
  });
}

module.exports = {
  status,
  exchangeAndStore,
  probeAccounts,
  disconnect,
  createLinkToken,
  CONNECTOR_SK,
};
