'use strict';

/**
 * Stamp ledger TXN# rows with Plaid match + location (and related fields).
 * Used after YNAB pull for new spending, and for inbox needs-attention backfill.
 */

const ddb = require('./ddb');
const plaid = require('./plaid');
const connectors = require('./connectors');
const ssm = require('./ssm');
const auth = require('./auth');
const { ledgerPlanId } = require('./config');
const {
  extractMask,
  buildMerchantLocationCache,
  matchLedgerToPlaid,
  attachLocations,
  enrichmentRecord,
  formatLocation,
  ynabToDollars,
} = require('./plaidMatch');

/** Top-level DDB fields we stamp / preserve across YNAB re-writes. */
const ENRICH_FIELDS = [
  'plaidTransactionId',
  'plaidMerchantName',
  'plaidMerchantEntityId',
  'plaidPaymentChannel',
  'plaidPfc',
  'plaidWebsite',
  'matchTier',
  'matchConfidence',
  'location',
  'locationSource',
  'locationConfidence',
  'locationDisplay',
  'enrichedAt',
];

function pickEnrichment(row) {
  if (!row || typeof row !== 'object') return {};
  const out = {};
  for (const k of ENRICH_FIELDS) {
    if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  }
  return out;
}

/**
 * US → "City, ST". Outside US → "City, Country".
 * Null/missing country treated as US (Plaid country_codes: ['US']).
 */
function formatLocationDisplay(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const city = String(loc.city || '').trim();
  const region = String(loc.region || '').trim();
  const countryRaw = String(loc.country || '').trim();
  const c = countryRaw.toUpperCase();
  const isUS =
    !c ||
    c === 'US' ||
    c === 'USA' ||
    c === 'UNITED STATES' ||
    c === 'UNITED STATES OF AMERICA';

  if (isUS) {
    if (city && region) return `${city}, ${region}`;
    if (city) return city;
    if (region) return region;
    return null;
  }
  if (city && countryRaw) return `${city}, ${countryRaw}`;
  if (city) return city;
  if (countryRaw) return countryRaw;
  return null;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load access tokens + account previews for every household user × bank
 * that is connected.
 */
async function loadConnectedPlaidItems() {
  const emails = auth.ALLOWED_EMAILS || [auth.ALLOWED_EMAIL];
  const bankIds = Object.keys(connectors.BANKS || {});
  const items = [];

  for (const email of emails) {
    for (const bankId of bankIds) {
      let bank;
      try {
        bank = connectors.resolveBank(bankId);
      } catch {
        continue;
      }
      // Skip investments-only for transaction match (Vanguard)
      if ((bank.products || []).includes('investments') && !(bank.products || []).includes('transactions')) {
        continue;
      }
      const meta = await ddb.getItem(`USER#${email}`, bank.bankSk);
      if (!meta?.connected) continue;
      const tokenJson = await ssm.getParameterJson(
        connectors.itemSsmParam(bank, email),
        { decrypt: true, useCache: false },
      );
      const accessToken = (tokenJson?.access_token || '').trim();
      if (!accessToken) continue;
      items.push({
        email,
        bankId: bank.id,
        bankName: bank.name,
        accessToken,
        accountsPreview: meta.accountsPreview || [],
      });
    }
  }
  return items;
}

async function fetchPlaidWindow(accessToken, startDate, endDate) {
  try {
    const res = await plaid.plaidPost('/transactions/get', {
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count: 500,
        offset: 0,
        include_personal_finance_category: true,
        include_original_description: true,
      },
    });
    let txns = res.transactions || [];
    // Paginate if needed
    let total = res.total_transactions ?? txns.length;
    let offset = txns.length;
    while (offset < total && offset < 2000) {
      const more = await plaid.plaidPost('/transactions/get', {
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: {
          count: 500,
          offset,
          include_personal_finance_category: true,
          include_original_description: true,
        },
      });
      const batch = more.transactions || [];
      if (!batch.length) break;
      txns = txns.concat(batch);
      offset += batch.length;
      total = more.total_transactions ?? total;
    }
    return { transactions: txns, accounts: res.accounts || [] };
  } catch (e) {
    // Fall back to sync if get fails
    console.warn('plaid transactions/get failed', e.message);
    const all = [];
    let cursor;
    let more = true;
    let guard = 0;
    while (more && guard < 25) {
      guard += 1;
      const body = { access_token: accessToken, count: 500 };
      if (cursor) body.cursor = cursor;
      const r = await plaid.plaidPost('/transactions/sync', body);
      all.push(...(r.added || []), ...(r.modified || []));
      cursor = r.next_cursor;
      more = !!r.has_more;
    }
    return {
      transactions: all.filter((t) => {
        const d = t.date || t.authorized_date;
        return d && d >= startDate && d <= endDate;
      }),
      accounts: [],
    };
  }
}

/**
 * Build combined Plaid pool + account mask map from all connected items.
 */
async function loadPlaidPool({ days = 60 } = {}) {
  const startDate = isoDaysAgo(days);
  const endDate = todayIso();
  const connected = await loadConnectedPlaidItems();
  if (!connected.length) {
    return {
      plaidTxns: [],
      plaidAccountById: new Map(),
      chaseMasks: new Set(),
      locationCache: { byEntity: new Map(), byName: new Map() },
      connected: [],
      startDate,
      endDate,
    };
  }

  const plaidTxns = [];
  const plaidAccountById = new Map();
  const masks = new Set();
  const historyForCache = [];

  for (const item of connected) {
    for (const a of item.accountsPreview || []) {
      if (a.accountId) {
        plaidAccountById.set(a.accountId, {
          mask: a.mask,
          name: a.name,
          bankId: item.bankId,
        });
      }
      if (a.mask) masks.add(a.mask);
    }
    try {
      const { transactions, accounts } = await fetchPlaidWindow(
        item.accessToken,
        startDate,
        endDate,
      );
      for (const a of accounts) {
        const mask = a.mask || null;
        if (a.account_id) {
          plaidAccountById.set(a.account_id, {
            mask,
            name: a.name || a.official_name,
            bankId: item.bankId,
          });
        }
        if (mask) masks.add(mask);
      }
      for (const t of transactions) {
        plaidTxns.push(t);
        historyForCache.push(t);
      }
    } catch (e) {
      console.warn(
        `plaid fetch failed ${item.bankId} ${item.email}:`,
        e.message,
      );
    }
  }

  const locationCache = buildMerchantLocationCache(historyForCache);
  return {
    plaidTxns,
    plaidAccountById,
    masks,
    locationCache,
    connected: connected.map((c) => ({
      email: c.email,
      bankId: c.bankId,
      accounts: (c.accountsPreview || []).length,
    })),
    startDate,
    endDate,
  };
}

function ledgerRowFromDdb(t, acctMap, payeeMap) {
  const p = t.payload || {};
  const accountId = t.accountId || p.account_id;
  const acct = acctMap.get(accountId) || {
    name: p.account_name,
    mask: extractMask(p.account_name),
  };
  const payeeId = t.payeeId || p.payee_id;
  return {
    ynabId: t.ynabId || String(t.sk || '').replace(/^TXN#/, ''),
    sk: t.sk,
    raw: t,
    date: t.date || p.date,
    amount: t.amount ?? p.amount,
    accountMask: acct.mask || extractMask(acct.name),
    accountName: acct.name,
    payeeName: payeeMap.get(payeeId) || p.payee_name || null,
    importPayeeName: p.import_payee_name || null,
    memo: t.memo ?? p.memo ?? null,
    transferAccountId: p.transfer_account_id || t.transferAccountId || null,
  };
}

function enrichmentFromMatch(matchWithLoc) {
  const base = enrichmentRecord(matchWithLoc);
  const loc = matchWithLoc.location
    ? formatLocation(matchWithLoc.location) || matchWithLoc.location
    : null;
  // Normalize location object shape
  const location = loc
    ? {
        address: loc.address || null,
        city: loc.city || null,
        region: loc.region || null,
        postal_code: loc.postal_code || null,
        country: loc.country || null,
        lat: loc.lat ?? null,
        lon: loc.lon ?? null,
        store_number: loc.store_number || null,
        text: loc.text || null,
      }
    : null;

  return {
    plaidTransactionId: base.plaidTransactionId,
    plaidMerchantName: base.plaidMerchantName || null,
    plaidMerchantEntityId: base.plaidMerchantEntityId || null,
    plaidPaymentChannel: base.plaidPaymentChannel || null,
    plaidPfc: matchWithLoc.plaid?.personal_finance_category || null,
    plaidWebsite: matchWithLoc.plaid?.website || null,
    matchTier: base.matchTier,
    matchConfidence: base.matchConfidence,
    location,
    locationSource: base.locationSource || null,
    locationConfidence: base.locationConfidence || 0,
    locationDisplay: formatLocationDisplay(location),
    enrichedAt: base.matchedAt,
  };
}

/**
 * Enrich a list of DDB TXN rows in place (putItem merge).
 * @param {object[]} ddbRows full TXN items
 * @param {object} opts
 */
async function enrichTxnRows(ddbRows, opts = {}) {
  const days = opts.days || 60;
  const onlyMissing = opts.onlyMissing !== false;
  const spendingOnly = opts.spendingOnly !== false;

  let candidates = ddbRows.filter((t) => t && !t.deleted);
  if (onlyMissing) {
    candidates = candidates.filter((t) => !t.plaidTransactionId);
  }
  if (spendingOnly) {
    // Outflows (and small inflows like refunds still useful — keep all signed)
    candidates = candidates.filter((t) => {
      const amt = t.amount ?? t.payload?.amount;
      return amt != null;
    });
  }
  if (!candidates.length) {
    return { attempted: 0, matched: 0, withLocation: 0, skipped: ddbRows.length };
  }

  const pool = await loadPlaidPool({ days });
  if (!pool.plaidTxns.length) {
    return {
      attempted: candidates.length,
      matched: 0,
      withLocation: 0,
      error: 'no_plaid_transactions',
      connected: pool.connected,
    };
  }

  // Account + payee maps
  const accts = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'ACCT#');
  const acctMap = new Map();
  for (const a of accts) {
    const id =
      a.ynabId || a.payload?.id || String(a.sk || '').replace(/^ACCT#/, '');
    acctMap.set(id, {
      name: a.name || a.payload?.name,
      mask: extractMask(a.name || a.payload?.name),
    });
  }
  const payees = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'PAYEE#');
  const payeeMap = new Map();
  for (const p of payees) {
    const id = p.ynabId || String(p.sk || '').replace(/^PAYEE#/, '');
    payeeMap.set(id, p.name || p.payload?.name || null);
  }

  // Only rows on connected bank masks
  const ledgerRows = [];
  const rowByYnab = new Map();
  for (const t of candidates) {
    const L = ledgerRowFromDdb(t, acctMap, payeeMap);
    if (!L.ynabId || !L.date || L.amount == null) continue;
    if (L.transferAccountId) continue;
    if (!L.accountMask || !pool.masks.has(L.accountMask)) continue;
    ledgerRows.push(L);
    rowByYnab.set(L.ynabId, t);
  }

  if (!ledgerRows.length) {
    return {
      attempted: candidates.length,
      matched: 0,
      withLocation: 0,
      note: 'no_rows_on_connected_masks',
      masks: [...pool.masks],
      connected: pool.connected,
    };
  }

  const matchResult = matchLedgerToPlaid(
    ledgerRows,
    pool.plaidTxns,
    pool.plaidAccountById,
  );
  const located = attachLocations(matchResult, pool.locationCache, {
    offerGeocode: false, // only stamp real location data for now
  });

  let matched = 0;
  let withLocation = 0;
  const now = Date.now();
  const writes = [];

  for (const m of located.rows) {
    const existing = rowByYnab.get(m.ynabId);
    if (!existing) continue;
    const enrich = enrichmentFromMatch(m);
    // Always stamp match info even without location
    const item = {
      ...existing,
      ...enrich,
      updatedAt: now,
    };
    writes.push(item);
    matched += 1;
    if (enrich.locationDisplay || enrich.location) withLocation += 1;
  }

  // batchWrite 25 at a time
  if (writes.length) await ddb.batchWrite(writes);

  return {
    attempted: ledgerRows.length,
    matched,
    withLocation,
    tierCounts: matchResult.tierCounts,
    plaidTxnCount: pool.plaidTxns.length,
    connected: pool.connected,
    window: { start: pool.startDate, end: pool.endDate },
  };
}

/**
 * New/recent spending missing enrichment (after YNAB pull).
 */
async function enrichNewSpending({ days = 45 } = {}) {
  const start = isoDaysAgo(days);
  const all = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'TXN#');
  const recent = all.filter((t) => {
    if (t.deleted) return false;
    const date = t.date || t.payload?.date;
    if (!date || date < start) return false;
    const amt = t.amount ?? t.payload?.amount;
    // Prefer outflows for "spending"; still enrich refunds/inflows on same masks
    if (amt == null) return false;
    return !t.plaidTransactionId;
  });
  const result = await enrichTxnRows(recent, {
    days: days + 5,
    onlyMissing: true,
    spendingOnly: false,
  });
  return { scope: 'new_spending', ...result, candidateRows: recent.length };
}

/**
 * Inbox needs-attention (unapproved + uncategorized on-budget).
 */
async function enrichInboxNeedsAttention({ days = 90 } = {}) {
  const sync = require('./sync');
  const inbox = await sync.listInbox();
  const ids = new Set((inbox.transactions || []).map((t) => t.ynabId).filter(Boolean));
  if (!ids.size) {
    return { scope: 'inbox', attempted: 0, matched: 0, withLocation: 0, inboxCount: 0 };
  }
  const all = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'TXN#');
  const rows = all.filter((t) => {
    if (t.deleted) return false;
    const id = t.ynabId || String(t.sk || '').replace(/^TXN#/, '');
    return ids.has(id);
  });
  // Include already-matched without location? Re-match only missing plaid id.
  // If already has plaid id but no locationDisplay, try re-attach from pool.
  const missing = rows.filter((t) => !t.plaidTransactionId);
  const result = await enrichTxnRows(missing, {
    days,
    onlyMissing: true,
    spendingOnly: false,
  });

  // Second pass: rows with match but no locationDisplay — re-resolve location only
  const needLoc = rows.filter(
    (t) => t.plaidTransactionId && !t.locationDisplay && !t.location,
  );
  // Skip heavy re-fetch for needLoc if none — location cascade already ran on match.
  void needLoc;

  return {
    scope: 'inbox',
    inboxCount: ids.size,
    ...result,
    alreadyEnriched: rows.length - missing.length,
  };
}

/**
 * Combined: new spending + inbox. Safe to call from pull tick.
 */
async function enrichAfterPull(opts = {}) {
  const started = Date.now();
  let neu = null;
  let inbox = null;
  try {
    neu = await enrichNewSpending({ days: opts.days || 45 });
  } catch (e) {
    neu = { error: e.message };
    console.warn('enrichNewSpending', e.message);
  }
  try {
    inbox = await enrichInboxNeedsAttention({ days: opts.inboxDays || 90 });
  } catch (e) {
    inbox = { error: e.message };
    console.warn('enrichInboxNeedsAttention', e.message);
  }
  return {
    ok: true,
    ms: Date.now() - started,
    newSpending: neu,
    inbox,
  };
}

module.exports = {
  ENRICH_FIELDS,
  pickEnrichment,
  formatLocationDisplay,
  loadConnectedPlaidItems,
  loadPlaidPool,
  enrichTxnRows,
  enrichNewSpending,
  enrichInboxNeedsAttention,
  enrichAfterPull,
  enrichmentFromMatch,
};
