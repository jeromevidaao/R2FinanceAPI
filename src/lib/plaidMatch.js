'use strict';

/**
 * Correlate R2Finance / YNAB ledger transactions with Plaid bank txns,
 * then attach location via a cascade (direct → merchant cache → optional geocode).
 *
 * Design notes (Chase POC, 45d window):
 *  - Hard filter: same account last-4 (YNAB account name mask ↔ Plaid mask)
 *  - Amount: YNAB milliunits / 1000 vs Plaid dollars (spend = opposite sign)
 *  - Date: prefer authorized_date, then posted date; most hits are exact day
 *  - Tiers T0–T3 for confidence; greedy 1:1 on rarer amounts first
 *  - Location is sparse on Plaid (~3–4% even in-store) — never gate the match on it
 */

function ynabToDollars(milli) {
  return Number(milli) / 1000;
}

function extractMask(name) {
  const m = String(name || '').match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(s) {
  return new Set(
    normName(s)
      .split(' ')
      .filter((w) => w.length > 2),
  );
}

/** Jaccard on tokens; substring boost. */
function nameScore(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  const union = new Set([...A, ...B]).size;
  return union ? hit / union : 0;
}

function daysBetweenAbs(d1, d2) {
  const a = Date.parse(d1);
  const b = Date.parse(d2);
  if (Number.isNaN(a) || Number.isNaN(b)) return 99;
  return Math.abs(a - b) / 86400000;
}

function hasUsableLocation(loc) {
  if (!loc || typeof loc !== 'object') return false;
  if (loc.address || loc.city) return true;
  if (loc.lat != null && loc.lon != null && !(loc.lat === 0 && loc.lon === 0)) {
    return true;
  }
  return false;
}

function formatLocation(loc) {
  if (!hasUsableLocation(loc)) return null;
  const parts = [loc.address, loc.city, loc.region, loc.postal_code, loc.country].filter(
    Boolean,
  );
  return {
    address: loc.address || null,
    city: loc.city || null,
    region: loc.region || null,
    postal_code: loc.postal_code || null,
    country: loc.country || null,
    lat: loc.lat != null && loc.lat !== 0 ? loc.lat : null,
    lon: loc.lon != null && loc.lon !== 0 ? loc.lon : null,
    store_number: loc.store_number || null,
    text: parts.length ? parts.join(', ') : null,
  };
}

/**
 * Build merchant → location cache from a Plaid history dump.
 * Prefer entity_id; fall back to normalized merchant name.
 */
function buildMerchantLocationCache(plaidTxns) {
  const byEntity = new Map();
  const byName = new Map();
  for (const t of plaidTxns || []) {
    const loc = formatLocation(t.location);
    if (!loc) continue;
    if (t.merchant_entity_id && !byEntity.has(t.merchant_entity_id)) {
      byEntity.set(t.merchant_entity_id, {
        location: loc,
        sourceTxnId: t.transaction_id,
        merchant: t.merchant_name || t.name,
      });
    }
    const key = normName(t.merchant_name || t.name);
    if (key && !byName.has(key)) {
      byName.set(key, {
        location: loc,
        sourceTxnId: t.transaction_id,
        merchant: t.merchant_name || t.name,
      });
    }
  }
  return { byEntity, byName };
}

/**
 * Location cascade for a matched Plaid txn.
 * @returns {{ location, source: 'plaid_direct'|'merchant_entity'|'merchant_name'|'geocode_candidate'|null, geocodeQuery? }}
 */
function resolveLocation(plaidTxn, cache, { offerGeocode = true } = {}) {
  const direct = formatLocation(plaidTxn.location);
  if (direct) {
    return { location: direct, source: 'plaid_direct', confidence: 1 };
  }

  if (plaidTxn.merchant_entity_id && cache?.byEntity?.has(plaidTxn.merchant_entity_id)) {
    const hit = cache.byEntity.get(plaidTxn.merchant_entity_id);
    return {
      location: hit.location,
      source: 'merchant_entity',
      confidence: 0.85,
      inheritedFromTxnId: hit.sourceTxnId,
    };
  }

  const nameKey = normName(plaidTxn.merchant_name || plaidTxn.name);
  if (nameKey && cache?.byName?.has(nameKey)) {
    const hit = cache.byName.get(nameKey);
    return {
      location: hit.location,
      source: 'merchant_name',
      confidence: 0.65,
      inheritedFromTxnId: hit.sourceTxnId,
    };
  }

  // Online / ACH rarely have a store pin — don't geocode those.
  const channel = plaidTxn.payment_channel || '';
  const isPhysical =
    channel === 'in store' ||
    (!channel && !/ACH|PPD|WEB|PAYMENT|ORIG CO/i.test(plaidTxn.name || ''));

  if (offerGeocode && isPhysical && (plaidTxn.merchant_name || plaidTxn.name)) {
    const q = [plaidTxn.merchant_name || plaidTxn.name, plaidTxn.location?.city]
      .filter(Boolean)
      .join(', ');
    return {
      location: null,
      source: 'geocode_candidate',
      confidence: 0,
      geocodeQuery: q,
      payment_channel: channel || null,
    };
  }

  return { location: null, source: null, confidence: 0 };
}

/**
 * Amount equal under YNAB/Plaid sign conventions.
 * Spend: YNAB negative, Plaid positive. Inflow: opposite.
 */
function amountsAlign(ynabMilli, plaidAmount) {
  const y = ynabToDollars(ynabMilli);
  const p = Number(plaidAmount);
  const opposite = Math.abs(y + p) < 0.015;
  const same = Math.abs(y - p) < 0.015;
  return { ok: opposite || same, opposite, y, p };
}

function bestDateDelta(ledgerDate, plaidTxn) {
  const dPost = daysBetweenAbs(ledgerDate, plaidTxn.date);
  const dAuth = plaidTxn.authorized_date
    ? daysBetweenAbs(ledgerDate, plaidTxn.authorized_date)
    : null;
  if (dAuth != null && dAuth <= dPost) {
    return { days: dAuth, field: 'authorized_date' };
  }
  return { days: dPost, field: 'date' };
}

/**
 * Tiered candidates for one ledger row against Plaid list (same-mask only).
 * T0: amount + date exact (auth or posted)
 * T1: amount + date ≤ 1d
 * T2: amount + date ≤ 3d + name ≥ 0.25
 * T3: amount + date ≤ 4d (unique only preferred by caller)
 */
function scoreCandidate(ledger, plaidTxn, plaidMask) {
  if (ledger.accountMask && plaidMask && ledger.accountMask !== plaidMask) {
    return null;
  }
  const amt = amountsAlign(ledger.amount, plaidTxn.amount);
  if (!amt.ok) return null;

  const { days, field } = bestDateDelta(ledger.date, plaidTxn);
  if (days > 4) return null;

  const ledgerName =
    ledger.payeeName || ledger.importPayeeName || ledger.memo || '';
  const plaidName =
    plaidTxn.merchant_name || plaidTxn.name || plaidTxn.original_description || '';
  const ns = nameScore(ledgerName, plaidName);

  let tier = null;
  if (days === 0) tier = 'T0';
  else if (days <= 1) tier = 'T1';
  else if (days <= 3 && ns >= 0.25) tier = 'T2';
  else if (days <= 4) tier = 'T3';
  else return null;

  // Confidence: T0 high; name and non-pending boost
  let confidence =
    tier === 'T0' ? 0.92 : tier === 'T1' ? 0.8 : tier === 'T2' ? 0.7 : 0.55;
  confidence += Math.min(0.08, ns * 0.08);
  if (plaidTxn.pending) confidence -= 0.03;
  if (ledger.accountMask && plaidMask === ledger.accountMask) confidence += 0.02;
  confidence = Math.max(0, Math.min(0.99, confidence));

  return {
    tier,
    confidence,
    dateDeltaDays: Math.round(days * 10) / 10,
    dateField: field,
    nameScore: Math.round(ns * 100) / 100,
    amountOpposite: amt.opposite,
    pending: !!plaidTxn.pending,
  };
}

/**
 * Greedy 1:1 match. Prefer rare (account, amount) keys so collisions resolve well.
 *
 * @param {Array} ledgerRows  { ynabId, date, amount, accountMask, payeeName?, importPayeeName?, memo? }
 * @param {Array} plaidTxns   raw Plaid transactions
 * @param {Map|Object} plaidAccountById  account_id → { mask, name }
 * @param {{ minConfidence?: number }} opts
 */
function matchLedgerToPlaid(ledgerRows, plaidTxns, plaidAccountById, opts = {}) {
  const minConfidence = opts.minConfidence ?? 0.55;
  const getAcct = (id) => {
    if (!plaidAccountById) return null;
    if (plaidAccountById instanceof Map) return plaidAccountById.get(id);
    return plaidAccountById[id];
  };

  const amtKeyCount = new Map();
  for (const L of ledgerRows) {
    const k = `${L.accountMask}|${Math.round(Math.abs(ynabToDollars(L.amount)) * 100)}`;
    amtKeyCount.set(k, (amtKeyCount.get(k) || 0) + 1);
  }

  const ordered = [...ledgerRows].sort((a, b) => {
    const ka = `${a.accountMask}|${Math.round(Math.abs(ynabToDollars(a.amount)) * 100)}`;
    const kb = `${b.accountMask}|${Math.round(Math.abs(ynabToDollars(b.amount)) * 100)}`;
    return (
      (amtKeyCount.get(ka) || 0) - (amtKeyCount.get(kb) || 0) ||
      String(a.date).localeCompare(String(b.date))
    );
  });

  const usedPlaid = new Set();
  const matches = new Map(); // ynabId → result
  const tierCounts = { T0: 0, T1: 0, T2: 0, T3: 0 };

  for (const L of ordered) {
    const cands = [];
    for (const pt of plaidTxns) {
      if (usedPlaid.has(pt.transaction_id)) continue;
      const acct = getAcct(pt.account_id);
      const scored = scoreCandidate(L, pt, acct?.mask || null);
      if (!scored || scored.confidence < minConfidence) continue;
      // T3 only if unique candidate at this amount+mask window
      cands.push({ pt, acct, ...scored });
    }
    if (!cands.length) continue;

    // Prefer better tier, then name, then non-pending
    const rank = { T0: 0, T1: 1, T2: 2, T3: 3 };
    cands.sort(
      (a, b) =>
        rank[a.tier] - rank[b.tier] ||
        b.confidence - a.confidence ||
        b.nameScore - a.nameScore ||
        a.pending - b.pending,
    );

    // Ambiguity guard: if top two T0 with near-equal name and same amount day, skip weak
    const best = cands[0];
    if (
      best.tier === 'T3' &&
      cands.filter((c) => c.tier === 'T3').length > 1 &&
      best.nameScore < 0.2
    ) {
      continue;
    }

    usedPlaid.add(best.pt.transaction_id);
    tierCounts[best.tier] = (tierCounts[best.tier] || 0) + 1;
    matches.set(L.ynabId, {
      ynabId: L.ynabId,
      tier: best.tier,
      confidence: Math.round(best.confidence * 1000) / 1000,
      dateDeltaDays: best.dateDeltaDays,
      dateField: best.dateField,
      nameScore: best.nameScore,
      plaid: {
        transaction_id: best.pt.transaction_id,
        account_id: best.pt.account_id,
        accountMask: best.acct?.mask || null,
        accountName: best.acct?.name || null,
        date: best.pt.date,
        authorized_date: best.pt.authorized_date || null,
        amount: best.pt.amount,
        name: best.pt.name,
        merchant_name: best.pt.merchant_name || null,
        merchant_entity_id: best.pt.merchant_entity_id || null,
        pending: !!best.pt.pending,
        pending_transaction_id: best.pt.pending_transaction_id || null,
        payment_channel: best.pt.payment_channel || null,
        personal_finance_category:
          best.pt.personal_finance_category?.primary || null,
        website: best.pt.website || null,
      },
      rawPlaid: best.pt,
    });
  }

  return {
    matches,
    tierCounts,
    matched: matches.size,
    total: ledgerRows.length,
    rate: ledgerRows.length ? matches.size / ledgerRows.length : 0,
  };
}

/**
 * After match: attach location cascade for each match.
 */
function attachLocations(matchResult, locationCache, opts = {}) {
  const out = [];
  let bySource = {
    plaid_direct: 0,
    merchant_entity: 0,
    merchant_name: 0,
    geocode_candidate: 0,
    none: 0,
  };

  for (const m of matchResult.matches.values()) {
    const resolved = resolveLocation(m.rawPlaid, locationCache, opts);
    if (resolved.source === 'plaid_direct') bySource.plaid_direct += 1;
    else if (resolved.source === 'merchant_entity') bySource.merchant_entity += 1;
    else if (resolved.source === 'merchant_name') bySource.merchant_name += 1;
    else if (resolved.source === 'geocode_candidate') bySource.geocode_candidate += 1;
    else bySource.none += 1;

    const { rawPlaid, ...rest } = m;
    out.push({
      ...rest,
      location: resolved.location,
      locationSource: resolved.source,
      locationConfidence: resolved.confidence,
      geocodeQuery: resolved.geocodeQuery || null,
      inheritedFromTxnId: resolved.inheritedFromTxnId || null,
    });
  }

  const withLocation = out.filter((r) => r.location).length;
  return {
    rows: out,
    bySource,
    withLocation,
    withLocationRate: out.length ? withLocation / out.length : 0,
    geocodeCandidates: out.filter((r) => r.locationSource === 'geocode_candidate')
      .length,
  };
}

/**
 * Suggested DDB enrichment shape (do not overwrite YNAB payload).
 * Store as optional top-level fields on TXN# or a side entity ENRICH#TXN#id.
 */
function enrichmentRecord(matchWithLocation) {
  return {
    plaidTransactionId: matchWithLocation.plaid.transaction_id,
    plaidMerchantName:
      matchWithLocation.plaid.merchant_name || matchWithLocation.plaid.name,
    plaidMerchantEntityId: matchWithLocation.plaid.merchant_entity_id,
    plaidPaymentChannel: matchWithLocation.plaid.payment_channel,
    matchTier: matchWithLocation.tier,
    matchConfidence: matchWithLocation.confidence,
    location: matchWithLocation.location,
    locationSource: matchWithLocation.locationSource,
    locationConfidence: matchWithLocation.locationConfidence,
    matchedAt: new Date().toISOString(),
  };
}

module.exports = {
  ynabToDollars,
  extractMask,
  normName,
  nameScore,
  hasUsableLocation,
  formatLocation,
  buildMerchantLocationCache,
  resolveLocation,
  scoreCandidate,
  matchLedgerToPlaid,
  attachLocations,
  enrichmentRecord,
  amountsAlign,
};
