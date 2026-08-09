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
 * Multi-city aware (ambiguous merchants are not inherited).
 * Implementation lives in merchantLocation.js.
 */
function buildMerchantLocationCache(plaidTxns) {
  // Lazy require avoids circular deps (merchantLocation → plaidMatch).
  return require('./merchantLocation').buildMerchantLocationCache(plaidTxns);
}

/**
 * Resolve a cache entry whether it is the legacy simple shape or multi-city.
 * Returns null when ambiguous (multi-city brand with >1 city).
 */
function cacheHit(entry) {
  if (!entry || !entry.location) return null;
  if (entry.ambiguous) return null;
  if (entry.cities && entry.cities.size > 1) return null;
  return entry;
}

/**
 * Location cascade for a matched Plaid txn.
 * @returns {{ location, source: 'plaid_direct'|'merchant_entity'|'merchant_name'|'geocode'|'geocode_candidate'|null, geocodeQuery? }}
 */
function resolveLocation(plaidTxn, cache, { offerGeocode = true } = {}) {
  const direct = formatLocation(plaidTxn.location);
  if (direct) {
    return { location: direct, source: 'plaid_direct', confidence: 1 };
  }

  const merchantLoc = require('./merchantLocation');

  // Prefer multi-city-safe lookups when available.
  const entityHit =
    merchantLoc.lookupEntity(cache, plaidTxn.merchant_entity_id) ||
    cacheHit(
      plaidTxn.merchant_entity_id
        ? cache?.byEntity?.get(plaidTxn.merchant_entity_id)
        : null,
    );
  if (entityHit?.location) {
    return {
      location: entityHit.location,
      source: 'merchant_entity',
      confidence: 0.85,
      inheritedFromTxnId: entityHit.sourceTxnId,
    };
  }

  const name = plaidTxn.merchant_name || plaidTxn.name;
  const nameHit =
    merchantLoc.lookupName(cache, name) ||
    cacheHit(cache?.byName?.get(normName(name))) ||
    cacheHit(cache?.byName?.get(merchantLoc.merchantNameKey(name)));
  if (nameHit?.location) {
    return {
      location: nameHit.location,
      source: 'merchant_name',
      confidence: 0.65,
      inheritedFromTxnId: nameHit.sourceTxnId,
    };
  }

  // Online / ACH rarely have a store pin — don't geocode those.
  const channel = plaidTxn.payment_channel || '';
  const isPhysical =
    channel === 'in store' ||
    (!channel && !/ACH|PPD|WEB|PAYMENT|ORIG CO/i.test(plaidTxn.name || ''));

  if (offerGeocode && isPhysical && name) {
    const q = [name, plaidTxn.location?.city].filter(Boolean).join(', ');
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
  const rawName =
    matchWithLocation.plaid.name ||
    matchWithLocation.plaid.merchant_name ||
    null;
  const parsed = parseVenmoPlaidName(rawName);
  const merchantOrName =
    matchWithLocation.plaid.merchant_name ||
    matchWithLocation.plaid.name ||
    null;
  // Prefer "Person - note" for Venmo-style names so UI can show description.
  const displayName =
    (parsed && parsed.display) || merchantOrName || null;
  return {
    plaidTransactionId: matchWithLocation.plaid.transaction_id,
    plaidMerchantName: displayName,
    plaidName: rawName,
    plaidDescription: parsed ? parsed.display : null,
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

/** True when bank/import payee is a generic Venmo ACH label (no real person/note). */
function isGenericVenmoLabel(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^venmo$/i.test(s)) return true;
  if (/^venmo\b/i.test(s) && /payment|cashout|des:|web id|ppd|orig/i.test(s)) {
    return true;
  }
  return false;
}

/** Ledger row looks like a Venmo bank feed (payee / import / plaid stamp). */
function isVenmoLikeLedger(row) {
  const blob = [
    row.payeeName,
    row.importPayeeName,
    row.memo,
    row.plaidMerchantName,
  ]
    .filter(Boolean)
    .join(' ');
  return /\bvenmo\b/i.test(blob);
}

/**
 * Parse Plaid Venmo `name` into counterparty + note.
 * Examples:
 *   Richard Mondor "City bags" → { name, note, display: "Richard Mondor - City bags" }
 *   Fire wood → { name: "Fire wood", note: null, display: "Fire wood" }
 *   Standard transfer → { name: "Standard transfer", note: null, display: "Standard transfer" }
 */
function parseVenmoPlaidName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Person "note" (straight or curly quotes)
  const m = s.match(/^(.+?)\s+["“](.+?)["”]\s*$/);
  if (m) {
    const name = m[1].trim();
    const note = m[2].trim();
    if (name && note) {
      return { name, note, display: `${name} - ${note}` };
    }
  }
  // "note" only
  const onlyNote = s.match(/^["“](.+?)["”]\s*$/);
  if (onlyNote) {
    const note = onlyNote[1].trim();
    return { name: null, note, display: note };
  }
  return { name: s, note: null, display: s };
}

/**
 * Cross-match bank "Venmo" ledger rows to the Venmo Personal Plaid item.
 * Bank ACH only says "Venmo"; the note lives on the Venmo connector
 * (e.g. Richard Mondor "City bags"). Match by amount + date only (masks differ).
 *
 * @param {Array} ledgerRows  same shape as matchLedgerToPlaid
 * @param {Array} plaidTxns
 * @param {Map|Object} plaidAccountById  account_id → { mask, name, bankId }
 * @param {{ maxDays?: number, minConfidence?: number }} opts
 * @returns {Map<string, object>} ynabId → match result (same shape as matchLedgerToPlaid)
 */
function matchVenmoDescriptions(
  ledgerRows,
  plaidTxns,
  plaidAccountById,
  opts = {},
) {
  const maxDays = opts.maxDays ?? 2;
  const getAcct = (id) => {
    if (!plaidAccountById) return null;
    if (plaidAccountById instanceof Map) return plaidAccountById.get(id);
    return plaidAccountById[id];
  };

  const venmoPlaid = (plaidTxns || []).filter((pt) => {
    const acct = getAcct(pt.account_id);
    if (acct?.bankId === 'venmo') return true;
    // Fallback: institution not on account map — detect by name shape / category
    const cat = (pt.category || []).join(' ').toLowerCase();
    if (cat.includes('venmo')) return true;
    const n = String(pt.name || '');
    if (/"/.test(n) || /“/.test(n)) return true;
    return false;
  });

  // Prefer rows that look like Venmo; if bankId filter found none, try all for venmo-like ledger
  const candidates = (ledgerRows || []).filter(isVenmoLikeLedger);
  const usedPlaid = new Set();
  const matches = new Map();

  // Greedy: exact day first, rarer amounts first
  const ordered = [...candidates].sort((a, b) => {
    const aa = Math.abs(ynabToDollars(a.amount));
    const bb = Math.abs(ynabToDollars(b.amount));
    return aa - bb || String(a.date).localeCompare(String(b.date));
  });

  for (const L of ordered) {
    const cands = [];
    for (const pt of venmoPlaid) {
      if (usedPlaid.has(pt.transaction_id)) continue;
      const amt = amountsAlign(L.amount, pt.amount);
      if (!amt.ok) continue;
      const { days, field } = bestDateDelta(L.date, pt);
      if (days > maxDays) continue;
      // Prefer person "note" over bare Standard transfer when both align
      const parsed = parseVenmoPlaidName(pt.name);
      const richness =
        parsed?.note ? 2 : /standard\s+transfer/i.test(pt.name || '') ? 0 : 1;
      cands.push({ pt, days, field, richness, amt });
    }
    if (!cands.length) continue;
    cands.sort(
      (a, b) =>
        a.days - b.days ||
        b.richness - a.richness ||
        (a.pt.pending ? 1 : 0) - (b.pt.pending ? 1 : 0),
    );
    const best = cands[0];
    usedPlaid.add(best.pt.transaction_id);
    const rawName = best.pt.name || best.pt.merchant_name || null;
    const parsed = parseVenmoPlaidName(rawName);
    const confidence =
      best.days === 0 ? 0.94 : best.days <= 1 ? 0.88 : 0.78;
    matches.set(L.ynabId, {
      ynabId: L.ynabId,
      tier: best.days === 0 ? 'V0' : best.days <= 1 ? 'V1' : 'V2',
      confidence,
      dateDeltaDays: Math.round(best.days * 10) / 10,
      dateField: best.field,
      nameScore: 1,
      venmoDescription: true,
      plaid: {
        transaction_id: best.pt.transaction_id,
        account_id: best.pt.account_id,
        accountMask: null,
        accountName: 'Venmo',
        date: best.pt.date,
        authorized_date: best.pt.authorized_date || null,
        amount: best.pt.amount,
        name: rawName,
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
      parsed,
    });
  }

  return matches;
}

/**
 * Human label for UI: "Person - note" from stamped enrich fields.
 */
function formatVenmoDescriptionLabel({
  plaidDescription,
  plaidName,
  plaidMerchantName,
} = {}) {
  if (plaidDescription && String(plaidDescription).trim()) {
    return String(plaidDescription).trim();
  }
  for (const candidate of [plaidName, plaidMerchantName]) {
    const parsed = parseVenmoPlaidName(candidate);
    if (parsed?.display && !isGenericVenmoLabel(parsed.display)) {
      return parsed.display;
    }
  }
  return null;
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
  isGenericVenmoLabel,
  isVenmoLikeLedger,
  parseVenmoPlaidName,
  matchVenmoDescriptions,
  formatVenmoDescriptionLabel,
};
