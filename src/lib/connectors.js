'use strict';

/**
 * Bank connectors (Plaid) — per-user, keyed by email.
 *
 * Phase 1 — establish access only:
 *  - One independent connection per (email × bank)
 *    e.g. Jerome BoA + Ngoc BoA = 2 separate Items
 *  - Plaid access_token in SSM SecureString:
 *      /r2finance/connectors/{userKey}/{bankId}
 *  - Metadata in DDB:
 *      pk=USER#{email}  sk=CONNECTOR#{BANK}
 *  - API keys in SSM /r2finance/plaid (never git)
 *  - Do NOT write bank transactions into DDB TXN# / ledger rows
 */

const crypto = require('crypto');
const ddb = require('./ddb');
const ssm = require('./ssm');
const plaid = require('./plaid');
const auth = require('./auth');
const { ledgerPlanId } = require('./config');

/**
 * Plaid forbids emails/PII in user.client_user_id — use a stable hash.
 */
function plaidClientUserId(email) {
  const raw = normalizeEmail(email) || 'r2finance';
  return crypto
    .createHash('sha256')
    .update(`r2finance:${raw}`)
    .digest('hex')
    .slice(0, 32);
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/** Opaque user key for SSM paths (no email/PII in parameter names). */
function userKey(email) {
  return crypto
    .createHash('sha256')
    .update(`r2u:${normalizeEmail(email)}`)
    .digest('hex')
    .slice(0, 16);
}

function requireEmail(email) {
  const e = normalizeEmail(email);
  if (!e) {
    const err = new Error('email required for connector');
    err.status = 400;
    throw err;
  }
  return e;
}

/** Supported bank types (generic catalog). */
const BANKS = {
  boa: {
    id: 'boa',
    name: 'Bank of America',
    institutionId: plaid.BOA_INSTITUTION_ID,
    bankSk: 'CONNECTOR#BOA',
    short: 'BoA',
    products: ['transactions'],
  },
  chase: {
    id: 'chase',
    name: 'Chase',
    institutionId: plaid.CHASE_INSTITUTION_ID,
    bankSk: 'CONNECTOR#CHASE',
    short: 'Chase',
    products: ['transactions'],
  },
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    institutionId: plaid.VANGUARD_INSTITUTION_ID,
    bankSk: 'CONNECTOR#VANGUARD',
    short: 'VG',
    products: ['investments'],
  },
  venmo: {
    id: 'venmo',
    name: 'Venmo',
    institutionId: plaid.VENMO_INSTITUTION_ID,
    bankSk: 'CONNECTOR#VENMO',
    short: 'Venmo',
    products: ['transactions'],
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

function userPk(email) {
  return `USER#${normalizeEmail(email)}`;
}

function metaKey(bank, email) {
  return { pk: userPk(email), sk: bank.bankSk };
}

/** Per-user SSM path for item access_token. */
function itemSsmParam(bank, email) {
  return `/r2finance/connectors/${userKey(email)}/${bank.id}`;
}

/** Legacy plan-level paths (pre multi-user) — migration only. */
function legacyPlanSsmParam(bankId) {
  return `/r2finance/connectors/${bankId}`;
}

function legacyPlanMetaSk(bank) {
  return bank.bankSk;
}

async function getMeta(bank, email) {
  return ddb.getItem(userPk(email), bank.bankSk);
}

async function getAccessToken(bank, email) {
  const j = await ssm.getParameterJson(itemSsmParam(bank, email), {
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
 * Compact row stored on CONNECTOR meta (DDB). Includes Plaid balances so
 * Accounts UI can load capital without a live Plaid call.
 * Plaid products remain transactions-only; balances come from accounts/get
 * when we connect or when the client explicitly refreshes.
 */
function toAccountPreview(a) {
  const bal = a.balances || {};
  return {
    accountId: a.accountId,
    name: a.name,
    officialName: a.officialName || null,
    mask: a.mask ?? null,
    type: a.type ?? null,
    subtype: a.subtype ?? null,
    available: bal.available ?? null,
    current: bal.current ?? null,
    limit: bal.limit ?? null,
    isoCurrencyCode: bal.isoCurrencyCode || 'USD',
  };
}

/** Prefer Plaid available; fall back to current for display / capital. */
function displayBalance(preview) {
  if (preview == null) return null;
  if (preview.available != null && !Number.isNaN(Number(preview.available))) {
    return Number(preview.available);
  }
  if (preview.current != null && !Number.isNaN(Number(preview.current))) {
    return Number(preview.current);
  }
  return null;
}

function isCreditType(type, subtype) {
  const t = String(type || '').toLowerCase();
  const s = String(subtype || '').toLowerCase();
  return t === 'credit' || s === 'credit card' || s === 'paypal';
}

/**
 * One-time migration: plan-level CONNECTOR#* → USER#email when this email owns it.
 * Safe to call on every status/list (no-op if already migrated).
 */
async function migrateLegacyForUser(email) {
  const e = normalizeEmail(email);
  if (!e) return { migrated: [] };
  const migrated = [];

  for (const bank of Object.values(BANKS)) {
    const existing = await getMeta(bank, e);
    if (existing?.connected && existing?.itemId) continue;

    const legacy = await ddb.getItem(
      ddb.planPk(ledgerPlanId),
      legacyPlanMetaSk(bank),
    );
    if (!legacy?.connected) continue;

    // Only adopt legacy rows owned by this email (or unowned → first admin)
    const owner = normalizeEmail(legacy.connectedBy || '');
    const isAdmin = e === normalizeEmail(auth.ALLOWED_EMAIL);
    if (owner && owner !== e) continue;
    if (!owner && !isAdmin) continue;

    // Prefer per-user SSM; fall back to legacy plan-level param
    let tokenJson = await ssm.getParameterJson(itemSsmParam(bank, e), {
      decrypt: true,
      useCache: false,
    });
    if (!tokenJson?.access_token) {
      tokenJson = await ssm.getParameterJson(legacyPlanSsmParam(bank.id), {
        decrypt: true,
        useCache: false,
      });
      if (tokenJson?.access_token) {
        await ssm.putParameterJson(
          itemSsmParam(bank, e),
          {
            ...tokenJson,
            email: e,
            connector_id: bank.id,
            migratedFrom: legacyPlanSsmParam(bank.id),
            updatedAt: new Date().toISOString(),
          },
          {
            description: `R2Finance ${bank.name} item for ${e} (migrated)`,
          },
        );
      }
    }

    await ddb.putItem({
      ...metaKey(bank, e),
      entityType: 'CONNECTOR',
      connectorId: bank.id,
      provider: 'plaid',
      email: e,
      userKey: userKey(e),
      connected: true,
      itemId: legacy.itemId || tokenJson?.item_id || null,
      institutionId: legacy.institutionId || null,
      institutionName: legacy.institutionName || bank.name,
      accountCount: legacy.accountCount ?? 0,
      accountsPreview: legacy.accountsPreview || [],
      connectedAt: legacy.connectedAt || Date.now(),
      connectedBy: e,
      importTransactionsToDdb: false,
      migratedFrom: `PLAN#${ledgerPlanId}/${bank.bankSk}`,
      updatedAt: Date.now(),
    });
    migrated.push(bank.id);
  }
  return { migrated };
}

/**
 * Status for one bank for one user — never returns access_token.
 */
async function status(bankId, { email } = {}) {
  const e = requireEmail(email);
  await migrateLegacyForUser(e);
  const bank = resolveBank(bankId);
  const configured = await plaid.isConfigured();
  const meta = await getMeta(bank, e);
  const hasToken = !!(await getAccessToken(bank, e));
  const connected = !!(meta?.connected && hasToken);

  const accountsPreview = meta?.accountsPreview || [];
  return {
    connectorId: bank.id,
    email: e,
    userKey: userKey(e),
    provider: 'plaid',
    institution: bank.name,
    institutionId: meta?.institutionId || bank.institutionId,
    configured,
    connected,
    itemId: meta?.itemId || null,
    connectedAt: meta?.connectedAt || null,
    connectedBy: meta?.connectedBy || e,
    institutionName: meta?.institutionName || bank.name,
    accountCount: meta?.accountCount ?? accountsPreview.length ?? null,
    accountsPreview,
    lastBalancesAt: meta?.lastBalancesAt || meta?.lastProbedAt || null,
    note:
      'Accounts UI reads connector cache (balances). Plaid is for transaction match + balance refresh only.',
  };
}

/** Banks for the signed-in user only. */
async function listStatus({ email } = {}) {
  const e = requireEmail(email);
  await migrateLegacyForUser(e);
  const connectors = [];
  for (const id of Object.keys(BANKS)) {
    connectors.push(await status(id, { email: e }));
  }
  return { email: e, connectors };
}

/**
 * Household overview: every allowed email × every bank (status only).
 * Used so each person can see who has what linked.
 */
async function listHousehold({ email } = {}) {
  const requester = requireEmail(email);
  const users = auth.ALLOWED_EMAILS || [requester];
  const byUser = [];
  for (const u of users) {
    const connectors = [];
    for (const id of Object.keys(BANKS)) {
      // migrate only for requester's legacy; others already user-scoped
      if (normalizeEmail(u) === requester) await migrateLegacyForUser(u);
      const bank = resolveBank(id);
      const configured = await plaid.isConfigured();
      const meta = await getMeta(bank, u);
      const hasToken = !!(await getAccessToken(bank, u));
      const accountsPreview = meta?.accountsPreview || [];
      connectors.push({
        connectorId: bank.id,
        email: normalizeEmail(u),
        institution: bank.name,
        institutionName: meta?.institutionName || bank.name,
        configured,
        connected: !!(meta?.connected && hasToken),
        accountCount: meta?.accountCount ?? accountsPreview.length ?? null,
        connectedAt: meta?.connectedAt || null,
        itemId: meta?.itemId || null,
        accountsPreview,
        lastBalancesAt: meta?.lastBalancesAt || meta?.lastProbedAt || null,
      });
    }
    byUser.push({ email: normalizeEmail(u), connectors });
  }
  return { requester, users: byUser };
}

/**
 * Exchange Plaid public_token → access_token; store under this email.
 */
async function exchangeAndStore(bankId, { publicToken, email, metadata }) {
  const e = requireEmail(email);
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
  } catch (err) {
    console.warn('accounts/get after exchange failed', err.message);
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
    itemSsmParam(bank, e),
    {
      access_token: accessToken,
      item_id: itemId,
      institution_id: institutionId,
      connector_id: bank.id,
      email: e,
      userKey: userKey(e),
      updatedAt: new Date().toISOString(),
    },
    { description: `R2Finance ${bank.name} Plaid item for user` },
  );

  const now = Date.now();
  const preview = accounts.map(toAccountPreview);

  await ddb.putItem({
    ...metaKey(bank, e),
    entityType: 'CONNECTOR',
    connectorId: bank.id,
    provider: 'plaid',
    email: e,
    userKey: userKey(e),
    connected: true,
    itemId,
    institutionId,
    institutionName,
    accountCount: accounts.length,
    accountsPreview: preview,
    lastBalancesAt: now,
    lastProbedAt: now,
    connectedAt: now,
    connectedBy: e,
    importTransactionsToDdb: false,
    updatedAt: now,
  });

  return {
    ok: true,
    connected: true,
    connectorId: bank.id,
    email: e,
    itemId,
    institutionId,
    institutionName,
    accounts,
    importTransactionsToDdb: false,
  };
}

async function probeAccounts(bankId, { email } = {}) {
  const e = requireEmail(email);
  await migrateLegacyForUser(e);
  const bank = resolveBank(bankId);
  const accessToken = await getAccessToken(bank, e);
  if (!accessToken) {
    const err = new Error(`${bank.name} not connected for ${e}`);
    err.status = 404;
    err.code = 'not_connected';
    throw err;
  }

  const acctRes = await plaid.getAccounts(accessToken);
  const accounts = (acctRes.accounts || []).map(mapAccount);
  const meta = await getMeta(bank, e);
  const now = Date.now();
  const preview = accounts.map(toAccountPreview);

  if (meta) {
    await ddb.putItem({
      ...meta,
      accountCount: accounts.length,
      accountsPreview: preview,
      lastBalancesAt: now,
      lastProbedAt: now,
      updatedAt: now,
    });
  }

  return {
    ok: true,
    connectorId: bank.id,
    email: e,
    institutionName: meta?.institutionName || bank.name,
    itemId: meta?.itemId || acctRes.item?.item_id || null,
    accounts,
    accountsPreview: preview,
    lastBalancesAt: now,
    importTransactionsToDdb: false,
    source: 'plaid_live',
  };
}

/**
 * Cached accounts for Accounts UI — no live Plaid call.
 * Falls back to empty when never connected / never probed.
 */
async function cachedAccounts(bankId, { email } = {}) {
  const e = requireEmail(email);
  await migrateLegacyForUser(e);
  const bank = resolveBank(bankId);
  const meta = await getMeta(bank, e);
  const accessToken = await getAccessToken(bank, e);
  const connected = !!(meta?.connected && accessToken);
  const preview = meta?.accountsPreview || [];

  return {
    ok: true,
    connectorId: bank.id,
    email: e,
    institutionName: meta?.institutionName || bank.name,
    itemId: meta?.itemId || null,
    connected,
    accounts: preview.map((p) => ({
      accountId: p.accountId,
      name: p.name,
      officialName: p.officialName || null,
      mask: p.mask ?? null,
      type: p.type ?? null,
      subtype: p.subtype ?? null,
      balances: {
        available: p.available ?? null,
        current: p.current ?? null,
        limit: p.limit ?? null,
        isoCurrencyCode: p.isoCurrencyCode || 'USD',
      },
    })),
    accountsPreview: preview,
    lastBalancesAt: meta?.lastBalancesAt || meta?.lastProbedAt || null,
    importTransactionsToDdb: false,
    source: 'connector_cache',
  };
}

/**
 * Refresh Plaid balances for every connected bank of this user and
 * write them onto CONNECTOR meta (Accounts reads the cache next).
 */
async function refreshAllBalances({ email } = {}) {
  const e = requireEmail(email);
  await migrateLegacyForUser(e);
  const results = [];
  for (const id of Object.keys(BANKS)) {
    const bank = resolveBank(id);
    const accessToken = await getAccessToken(bank, e);
    const meta = await getMeta(bank, e);
    if (!meta?.connected || !accessToken) {
      results.push({
        connectorId: id,
        skipped: true,
        reason: 'not_connected',
      });
      continue;
    }
    try {
      const probed = await probeAccounts(id, { email: e });
      results.push({
        connectorId: id,
        ok: true,
        accountCount: probed.accounts?.length ?? 0,
        lastBalancesAt: probed.lastBalancesAt,
      });
    } catch (err) {
      results.push({
        connectorId: id,
        ok: false,
        error: err.message || String(err),
      });
    }
  }
  return {
    ok: true,
    email: e,
    refreshedAt: Date.now(),
    results,
  };
}

async function disconnect(bankId, { email } = {}) {
  const e = requireEmail(email);
  const bank = resolveBank(bankId);
  const accessToken = await getAccessToken(bank, e);
  if (accessToken) {
    try {
      await plaid.removeItem(accessToken);
    } catch (err) {
      console.warn('plaid item/remove', err.message);
    }
  }
  try {
    await ssm.deleteParameter(itemSsmParam(bank, e));
  } catch (err) {
    console.warn(`delete ${bank.id} item SSM`, err.message);
  }

  const existing = await getMeta(bank, e);
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

  return { ok: true, connected: false, connectorId: bank.id, email: e };
}

async function createLinkToken(bankId, { email } = {}) {
  const e = requireEmail(email);
  const bank = resolveBank(bankId);
  return plaid.createLinkToken({
    clientUserId: plaidClientUserId(e),
    institutionId: bank.institutionId,
    bankKey: bank.id,
    products: bank.products || ['transactions'],
  });
}

module.exports = {
  BANKS,
  resolveBank,
  userKey,
  plaidClientUserId,
  itemSsmParam,
  status,
  listStatus,
  listHousehold,
  exchangeAndStore,
  probeAccounts,
  cachedAccounts,
  refreshAllBalances,
  toAccountPreview,
  displayBalance,
  isCreditType,
  disconnect,
  createLinkToken,
  migrateLegacyForUser,
};
