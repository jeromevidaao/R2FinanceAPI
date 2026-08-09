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
  matchVenmoDescriptions,
  attachLocations,
  resolveLocation,
  enrichmentRecord,
  formatLocation,
  ynabToDollars,
  isVenmoLikeLedger,
  isGenericVenmoLabel,
  parseVenmoPlaidName,
} = require('./plaidMatch');
const merchantLocation = require('./merchantLocation');

/** Top-level DDB fields we stamp / preserve across YNAB re-writes. */
const ENRICH_FIELDS = [
  'plaidTransactionId',
  'plaidMerchantName',
  'plaidName',
  'plaidDescription',
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

/** Map full US state names (and common variants) → 2-letter codes. */
const US_STATE_ABBR = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
};

function usStateAbbr(region) {
  const r = String(region || '').trim();
  if (!r) return '';
  if (/^[A-Za-z]{2}$/.test(r)) return r.toUpperCase();
  return US_STATE_ABBR[r.toLowerCase()] || r;
}

/**
 * US → "City, ST". Outside US → "City, Country".
 * Null/missing country treated as US (Plaid country_codes: ['US']).
 * Falls back to a short address line when city is missing.
 */
function formatLocationDisplay(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const city = String(loc.city || '').trim();
  const regionRaw = String(loc.region || '').trim();
  const countryRaw = String(loc.country || '').trim();
  const address = String(loc.address || '').trim();
  const c = countryRaw.toUpperCase();
  const isUS =
    !c ||
    c === 'US' ||
    c === 'USA' ||
    c === 'UNITED STATES' ||
    c === 'UNITED STATES OF AMERICA';

  if (isUS) {
    const region = usStateAbbr(regionRaw);
    if (city && region) return `${city}, ${region}`;
    if (city) return city;
    if (region) return region;
    if (address) return address;
    return null;
  }
  if (city && countryRaw) return `${city}, ${countryRaw}`;
  if (city) return city;
  if (countryRaw) return countryRaw;
  if (address) return address;
  return null;
}

/** Plaid PFC is often an object — store a short string for UI. */
function formatPfc(pfc) {
  if (!pfc) return null;
  if (typeof pfc === 'string') return pfc;
  if (typeof pfc === 'object') {
    return pfc.primary || pfc.detailed || null;
  }
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
 *
 * @param {{ days?: number, cacheDays?: number }} opts
 *  - days: match window for ledger ↔ Plaid
 *  - cacheDays: longer window used only to harvest location pins (default max(days, 180))
 */
async function loadPlaidPool({ days = 60, cacheDays } = {}) {
  const matchDays = days;
  const locDays = Math.max(cacheDays || 180, matchDays);
  const matchStart = isoDaysAgo(matchDays);
  const cacheStart = isoDaysAgo(locDays);
  const endDate = todayIso();
  const connected = await loadConnectedPlaidItems();
  if (!connected.length) {
    return {
      plaidTxns: [],
      plaidAccountById: new Map(),
      chaseMasks: new Set(),
      locationCache: merchantLocation.emptyCache(),
      connected: [],
      startDate: matchStart,
      endDate,
      cacheStart,
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
      // One longer fetch — use full window for cache, filter for match pool.
      const { transactions, accounts } = await fetchPlaidWindow(
        item.accessToken,
        cacheStart,
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
        historyForCache.push(t);
        const d = t.date || t.authorized_date;
        if (d && d >= matchStart) plaidTxns.push(t);
      }
    } catch (e) {
      console.warn(
        `plaid fetch failed ${item.bankId} ${item.email}:`,
        e.message,
      );
    }
  }

  // Layer: durable DDB MERCHANT# → harvested TXN pins → current Plaid window.
  let locationCache = merchantLocation.emptyCache();
  try {
    const durable = await merchantLocation.loadMerchantCacheFromDdb();
    locationCache = merchantLocation.mergeCaches(locationCache, durable.cache);
  } catch (e) {
    console.warn('loadMerchantCacheFromDdb', e.message);
  }

  // Existing TXN pins (any age) — long-lived household memory.
  try {
    const existingTxns = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'TXN#');
    merchantLocation.harvestTxnLocations(locationCache, existingTxns);
  } catch (e) {
    console.warn('harvestTxnLocations', e.message);
  }

  const windowCache = buildMerchantLocationCache(historyForCache);
  locationCache = merchantLocation.mergeCaches(locationCache, windowCache);

  return {
    plaidTxns,
    plaidById: new Map(plaidTxns.map((t) => [t.transaction_id, t])),
    // Full history for location re-attach of older matched ids still in window
    plaidByIdAll: new Map(historyForCache.map((t) => [t.transaction_id, t])),
    plaidAccountById,
    masks,
    locationCache,
    historyForCache,
    connected: connected.map((c) => ({
      email: c.email,
      bankId: c.bankId,
      accounts: (c.accountsPreview || []).length,
    })),
    startDate: matchStart,
    endDate,
    cacheStart,
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
    plaidName: base.plaidName || null,
    plaidDescription: base.plaidDescription || null,
    plaidMerchantEntityId: base.plaidMerchantEntityId || null,
    plaidPaymentChannel: base.plaidPaymentChannel || null,
    plaidPfc: formatPfc(matchWithLoc.plaid?.personal_finance_category),
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

function enrichmentFromResolved(plaidTxn, resolved, existingMatch = {}) {
  const location = resolved.location
    ? formatLocation(resolved.location) || resolved.location
    : null;
  return {
    plaidTransactionId:
      existingMatch.plaidTransactionId || plaidTxn.transaction_id,
    plaidMerchantName:
      existingMatch.plaidMerchantName ||
      plaidTxn.merchant_name ||
      plaidTxn.name ||
      null,
    plaidMerchantEntityId:
      existingMatch.plaidMerchantEntityId ||
      plaidTxn.merchant_entity_id ||
      null,
    plaidPaymentChannel:
      existingMatch.plaidPaymentChannel || plaidTxn.payment_channel || null,
    plaidPfc:
      existingMatch.plaidPfc ||
      formatPfc(plaidTxn.personal_finance_category),
    plaidWebsite: existingMatch.plaidWebsite || plaidTxn.website || null,
    matchTier: existingMatch.matchTier || null,
    matchConfidence: existingMatch.matchConfidence ?? null,
    location,
    locationSource: resolved.source || null,
    locationConfidence: resolved.confidence || 0,
    locationDisplay: formatLocationDisplay(location),
    enrichedAt: new Date().toISOString(),
  };
}

/**
 * Geocode geocode_candidates, seed cache, re-resolve.
 * @returns number of rows that gained a location
 */
async function applyGeocodePass(locatedRows, locationCache, { maxQueries = 12 } = {}) {
  const candidates = locatedRows.filter(
    (r) => r.locationSource === 'geocode_candidate' && !r.location,
  );
  if (!candidates.length) {
    return { geocoded: 0, queriesUsed: 0 };
  }
  // Need raw plaid on rows — attachLocations strips rawPlaid; recover from plaid field
  const withRaw = candidates.map((r) => ({
    ...r,
    rawPlaid: r.plaid || r.rawPlaid,
  }));
  const priors = merchantLocation.userCityPriors(locationCache, 5);
  const { results, queriesUsed } = await merchantLocation.geocodeCandidates(
    withRaw,
    priors,
    { maxQueries },
  );
  let geocoded = 0;
  for (const row of locatedRows) {
    const id = row.plaid?.transaction_id || row.plaidTransactionId;
    if (!id || !results.has(id)) continue;
    const hit = results.get(id);
    row.location = hit.location;
    row.locationSource = 'geocode';
    row.locationConfidence = 0.55;
    row.geocodeQuery = hit.query;
    geocoded += 1;
    merchantLocation.ingestFormatted(locationCache, {
      entityId: row.plaid?.merchant_entity_id || null,
      name: hit.merchant,
      location: hit.location,
      sourceTxnId: id,
      source: 'geocode',
    });
  }
  return { geocoded, queriesUsed, priors };
}

/**
 * Build a synthetic Plaid-like object from already-stamped TXN enrichment
 * so we can re-resolve location without another Plaid round-trip.
 */
function syntheticPlaidFromTxn(t) {
  return {
    transaction_id: t.plaidTransactionId,
    merchant_name: t.plaidMerchantName || null,
    name: t.plaidMerchantName || t.payload?.import_payee_name || null,
    merchant_entity_id: t.plaidMerchantEntityId || null,
    payment_channel: t.plaidPaymentChannel || null,
    location: t.location || {},
    personal_finance_category: t.plaidPfc || null,
    website: t.plaidWebsite || null,
  };
}

/**
 * Re-resolve location for rows that already have plaidTransactionId but no pin.
 * Prefers live Plaid row when present; falls back to stamped merchant fields.
 */
function relocateExistingMatches(ddbRows, pool) {
  const out = [];
  const byId = pool?.plaidByIdAll || pool?.plaidById || new Map();
  const cache = pool?.locationCache || merchantLocation.emptyCache();
  for (const t of ddbRows) {
    if (!t?.plaidTransactionId) continue;
    if (t.locationDisplay || (t.location && formatLocationDisplay(t.location))) {
      continue;
    }
    const plaidTxn = byId.get(t.plaidTransactionId) || syntheticPlaidFromTxn(t);
    const resolved = resolveLocation(plaidTxn, cache, {
      offerGeocode: true,
    });
    out.push({ row: t, plaidTxn, resolved });
  }
  return out;
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
  const runGeocode = opts.runGeocode !== false;
  const maxGeocode = opts.maxGeocode ?? 12;

  let candidates = ddbRows.filter((t) => t && !t.deleted);
  if (onlyMissing) {
    candidates = candidates.filter((t) => {
      if (!t.plaidTransactionId) return true;
      // Already matched bank ACH as "Venmo" — still try Venmo Personal note.
      if (t.plaidDescription && !isGenericVenmoLabel(t.plaidDescription)) {
        return false;
      }
      const p = t.payload || {};
      const probe = {
        payeeName: p.payee_name || null,
        importPayeeName: p.import_payee_name || t.importPayeeName || null,
        memo: t.memo ?? p.memo ?? null,
        plaidMerchantName: t.plaidMerchantName || null,
      };
      return (
        isVenmoLikeLedger(probe) &&
        (isGenericVenmoLabel(t.plaidMerchantName) || !t.plaidDescription)
      );
    });
  }
  if (spendingOnly) {
    candidates = candidates.filter((t) => {
      const amt = t.amount ?? t.payload?.amount;
      return amt != null;
    });
  }
  if (!candidates.length) {
    return { attempted: 0, matched: 0, withLocation: 0, skipped: ddbRows.length };
  }

  const pool = await loadPlaidPool({ days, cacheDays: opts.cacheDays || 180 });
  if (!pool.plaidTxns.length && !(pool.historyForCache || []).length) {
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

  // Bank-mask rows for standard Plaid match + Venmo-like rows (often mask-less
  // BoA aliases) for Venmo Personal description overlay.
  const ledgerRows = [];
  const venmoLedgerRows = [];
  const rowByYnab = new Map();
  for (const t of candidates) {
    const L = ledgerRowFromDdb(t, acctMap, payeeMap);
    // Carry existing stamp so isVenmoLikeLedger sees plaidMerchantName=Venmo
    L.plaidMerchantName = t.plaidMerchantName || null;
    if (!L.ynabId || !L.date || L.amount == null) continue;
    if (L.transferAccountId) continue;
    const onMask = L.accountMask && pool.masks.has(L.accountMask);
    const venmoLike = isVenmoLikeLedger(L);
    if (!onMask && !venmoLike) continue;
    rowByYnab.set(L.ynabId, t);
    if (onMask) ledgerRows.push(L);
    if (venmoLike) venmoLedgerRows.push(L);
  }

  if (!ledgerRows.length && !venmoLedgerRows.length) {
    return {
      attempted: candidates.length,
      matched: 0,
      withLocation: 0,
      note: 'no_rows_on_connected_masks',
      masks: [...pool.masks],
      connected: pool.connected,
    };
  }

  const matchResult = ledgerRows.length
    ? matchLedgerToPlaid(
        ledgerRows,
        pool.plaidTxns,
        pool.plaidAccountById,
      )
    : {
        matches: new Map(),
        tierCounts: {},
        matched: 0,
        total: 0,
        rate: 0,
      };

  // Overlay: bank "Venmo" ACH → Venmo Personal note (Person "memo").
  // Prefer this description even when bank Plaid already matched as "Venmo".
  const venmoMatches = matchVenmoDescriptions(
    venmoLedgerRows.length ? venmoLedgerRows : ledgerRows,
    pool.plaidTxns,
    pool.plaidAccountById,
    { maxDays: 2 },
  );
  for (const [ynabId, vm] of venmoMatches) {
    const existing = matchResult.matches.get(ynabId);
    const existingName =
      existing?.plaid?.merchant_name || existing?.plaid?.name || '';
    const shouldUpgrade =
      !existing ||
      isGenericVenmoLabel(existingName) ||
      isGenericVenmoLabel(rowByYnab.get(ynabId)?.plaidMerchantName);
    if (shouldUpgrade) {
      matchResult.matches.set(ynabId, vm);
    }
  }
  if (venmoMatches.size) {
    matchResult.tierCounts = matchResult.tierCounts || {};
    matchResult.tierCounts.venmoDesc = venmoMatches.size;
    matchResult.matched = matchResult.matches.size;
  }

  // offerGeocode true → mark candidates; we may fill via Nominatim below
  const located = attachLocations(matchResult, pool.locationCache, {
    offerGeocode: true,
  });

  let geoStats = { geocoded: 0, queriesUsed: 0 };
  if (runGeocode) {
    geoStats = await applyGeocodePass(located.rows, pool.locationCache, {
      maxQueries: maxGeocode,
    });
  }

  // Seed durable cache from every plaid_direct / geocode pin we now know
  for (const m of located.rows) {
    if (!m.location) continue;
    merchantLocation.ingestFormatted(pool.locationCache, {
      entityId: m.plaid?.merchant_entity_id || null,
      name: m.plaid?.merchant_name || m.plaid?.name,
      location: m.location,
      sourceTxnId: m.plaid?.transaction_id,
      source: m.locationSource || 'plaid',
    });
  }

  let matched = 0;
  let withLocation = 0;
  let venmoDescribed = 0;
  const now = Date.now();
  const writes = [];

  for (const m of located.rows) {
    const existing = rowByYnab.get(m.ynabId);
    if (!existing) continue;
    const enrich = enrichmentFromMatch(m);
    // Strip nulls so DDB does not store typed-NULL attributes
    const clean = {};
    for (const [k, v] of Object.entries(enrich)) {
      if (v !== undefined && v !== null) clean[k] = v;
    }
    const item = {
      ...existing,
      ...clean,
      updatedAt: now,
    };
    writes.push(item);
    matched += 1;
    if (clean.locationDisplay || clean.location) withLocation += 1;
    if (clean.plaidDescription && !isGenericVenmoLabel(clean.plaidDescription)) {
      venmoDescribed += 1;
    }
  }

  if (writes.length) await ddb.batchWrite(writes);

  // Persist merchant pins for next pull (cheap, cumulative coverage).
  let merchantPersisted = 0;
  try {
    const p = await merchantLocation.persistMerchantCache(pool.locationCache);
    merchantPersisted = p.written;
  } catch (e) {
    console.warn('persistMerchantCache', e.message);
  }

  return {
    attempted: Math.max(ledgerRows.length, venmoLedgerRows.length),
    matched,
    withLocation,
    venmoDescribed,
    geocoded: geoStats.geocoded || 0,
    geocodeQueries: geoStats.queriesUsed || 0,
    merchantPersisted,
    bySource: located.bySource,
    tierCounts: matchResult.tierCounts,
    plaidTxnCount: pool.plaidTxns.length,
    connected: pool.connected,
    window: {
      start: pool.startDate,
      end: pool.endDate,
      cacheStart: pool.cacheStart,
    },
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
    if (!t.plaidTransactionId) return true;
    // Upgrade generic bank "Venmo" stamps with Personal connector notes.
    if (t.plaidDescription && !isGenericVenmoLabel(t.plaidDescription)) {
      return false;
    }
    const p = t.payload || {};
    const probe = {
      payeeName: p.payee_name || null,
      importPayeeName: p.import_payee_name || t.importPayeeName || null,
      memo: t.memo ?? p.memo ?? null,
      plaidMerchantName: t.plaidMerchantName || null,
    };
    return (
      isVenmoLikeLedger(probe) &&
      (isGenericVenmoLabel(t.plaidMerchantName) || !t.plaidDescription)
    );
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
 * Single Plaid pool load: match missing ids + relocate already-matched + geocode.
 */
async function enrichInboxNeedsAttention({ days = 90, runGeocode = true } = {}) {
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

  // Prefer one enrichTxnRows pass for unmatched (builds pool, matches, geocodes, persists).
  const missing = rows.filter((t) => !t.plaidTransactionId);
  const result = await enrichTxnRows(missing, {
    days,
    onlyMissing: true,
    spendingOnly: false,
    runGeocode,
    maxGeocode: runGeocode ? 16 : 0,
    cacheDays: 180,
  });

  // Reload rows after first pass so newly matched are excluded from relocate.
  const fresh = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'TXN#');
  const byId = new Map();
  for (const t of fresh) {
    const id = t.ynabId || String(t.sk || '').replace(/^TXN#/, '');
    if (ids.has(id)) byId.set(id, t);
  }
  const needLoc = [...byId.values()].filter(
    (t) =>
      t.plaidTransactionId &&
      !t.locationDisplay &&
      !(t.location && formatLocationDisplay(t.location)),
  );

  let relocated = 0;
  let relocatedGeocoded = 0;
  if (needLoc.length) {
    try {
      // No second Plaid fetch — durable MERCHANT# + harvested TXN pins + synthetic fields.
      let locationCache = merchantLocation.emptyCache();
      try {
        const durable = await merchantLocation.loadMerchantCacheFromDdb();
        locationCache = merchantLocation.mergeCaches(locationCache, durable.cache);
      } catch (e) {
        console.warn('loadMerchantCache relocate', e.message);
      }
      merchantLocation.harvestTxnLocations(locationCache, fresh);

      const pool = { locationCache, plaidById: new Map(), plaidByIdAll: new Map() };
      const pending = relocateExistingMatches(needLoc, pool);

      const geoCandidates = pending
        .filter((p) => p.resolved.source === 'geocode_candidate' && !p.resolved.location)
        .map((p) => ({
          plaid: p.plaidTxn,
          rawPlaid: p.plaidTxn,
          plaidTransactionId: p.plaidTxn.transaction_id,
        }));
      if (runGeocode && geoCandidates.length) {
        const priors = merchantLocation.userCityPriors(locationCache, 5);
        // Keep budget small on the relocate pass (first pass already geocoded).
        const { results } = await merchantLocation.geocodeCandidates(
          geoCandidates,
          priors,
          { maxQueries: 16 },
        );
        for (const p of pending) {
          const id = p.plaidTxn.transaction_id;
          if (results.has(id) && !p.resolved.location) {
            const hit = results.get(id);
            p.resolved = {
              location: hit.location,
              source: 'geocode',
              confidence: 0.55,
              geocodeQuery: hit.query,
            };
            relocatedGeocoded += 1;
            merchantLocation.ingestFormatted(locationCache, {
              entityId: p.plaidTxn.merchant_entity_id,
              name: hit.merchant,
              location: hit.location,
              sourceTxnId: id,
              source: 'geocode',
            });
          }
        }
      }

      const now = Date.now();
      const writes = [];
      for (const p of pending) {
        if (!p.resolved.location) continue;
        const enrich = enrichmentFromResolved(p.plaidTxn, p.resolved, {
          plaidTransactionId: p.row.plaidTransactionId,
          plaidMerchantName: p.row.plaidMerchantName,
          plaidMerchantEntityId: p.row.plaidMerchantEntityId,
          plaidPaymentChannel: p.row.plaidPaymentChannel,
          plaidPfc: p.row.plaidPfc,
          matchTier: p.row.matchTier,
          matchConfidence: p.row.matchConfidence,
        });
        const clean = {};
        for (const [k, v] of Object.entries(enrich)) {
          if (v !== undefined && v !== null) clean[k] = v;
        }
        writes.push({ ...p.row, ...clean, updatedAt: now });
        relocated += 1;
      }
      if (writes.length) await ddb.batchWrite(writes);
      try {
        await merchantLocation.persistMerchantCache(locationCache);
      } catch (e) {
        console.warn('persistMerchantCache relocate', e.message);
      }
    } catch (e) {
      console.warn('relocateExistingMatches', e.message);
    }
  }

  return {
    scope: 'inbox',
    inboxCount: ids.size,
    ...result,
    alreadyEnriched: rows.length - missing.length,
    needLoc: needLoc.length,
    relocated,
    relocatedGeocoded,
    withLocation: (result.withLocation || 0) + relocated,
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
  formatPfc,
  loadConnectedPlaidItems,
  loadPlaidPool,
  enrichTxnRows,
  enrichNewSpending,
  enrichInboxNeedsAttention,
  enrichAfterPull,
  enrichmentFromMatch,
  enrichmentFromResolved,
  relocateExistingMatches,
  applyGeocodePass,
};
