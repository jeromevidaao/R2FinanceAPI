'use strict';

/**
 * Durable merchant → location cache (DDB MERCHANT#*) + helpers.
 *
 * Multi-city safety: if the same merchant_entity / name has been seen in
 * more than one city, we mark it ambiguous and do not inherit a single pin
 * (Starbucks in San Jose must not paint Seattle Starbucks).
 *
 * Sources:
 *  - Plaid direct pins (window)
 *  - Already-stamped TXN# rows
 *  - Optional Nominatim geocode results (cached forever under MERCHANT#)
 */

const ddb = require('./ddb');
const { ledgerPlanId } = require('./config');
const {
  normName,
  formatLocation,
  hasUsableLocation,
} = require('./plaidMatch');

const SK_ENTITY = 'MERCHANT#E#';
const SK_NAME = 'MERCHANT#N#';

/** National / multi-city brands — never bare-geocode without a city prior. */
const MULTI_CITY_BRANDS = new Set(
  [
    'starbucks',
    'mcdonalds',
    'mcdonald',
    '7 eleven',
    '7eleven',
    'chipotle',
    'subway',
    'walgreens',
    'cvs',
    'target',
    'walmart',
    'costco',
    'safeway',
    'whole foods',
    'trader joes',
    'shell',
    'chevron',
    'exxon',
    'bp',
    'arco',
    'uber',
    'uber eats',
    'lyft',
    'doordash',
    'grubhub',
    'amazon',
    'apple',
    'google',
    'tesla',
    'tesla supercharger',
    'airbnb',
    'marriott',
    'hilton',
    'hyatt',
    'best buy',
    'home depot',
    'lowes',
    'dunkin',
    'peets',
    'peet coffee',
    'dutch bros',
    'taco bell',
    'wendys',
    'burger king',
    'kfc',
    'pizza hut',
    'dominos',
    'papa johns',
    'five guys',
    'in n out',
    'chick fil a',
    'panera',
    'sweetgreen',
    'cava',
  ].map((s) => normName(s)),
);

function cityKey(loc) {
  if (!loc) return '';
  const city = String(loc.city || '')
    .toLowerCase()
    .trim();
  const region = String(loc.region || '')
    .toLowerCase()
    .trim();
  if (!city && !region) return '';
  return `${city}|${region}`;
}

/**
 * Soft key for merchant name cache: drop store #, LLC/Inc, long digit tails.
 */
function merchantNameKey(name) {
  let n = normName(name);
  if (!n) return '';
  n = n
    .replace(/\b(store|st|#)\s*\d+\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b(llc|inc|corp|co|ltd|limited|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}

function isMultiCityBrand(name) {
  const key = merchantNameKey(name) || normName(name);
  if (!key) return false;
  if (MULTI_CITY_BRANDS.has(key)) return true;
  // prefix match for "starbucks store 123"
  for (const b of MULTI_CITY_BRANDS) {
    if (key === b || key.startsWith(`${b} `) || key.includes(` ${b} `)) return true;
  }
  return false;
}

function emptyCache() {
  return { byEntity: new Map(), byName: new Map() };
}

/**
 * Merge a usable location into an in-memory cache entry (entity or name).
 * Marks ambiguous when two distinct city keys appear.
 */
function mergeIntoBucket(map, key, loc, meta = {}) {
  if (!key || !loc) return;
  const ck = cityKey(loc);
  const prev = map.get(key);
  if (!prev) {
    map.set(key, {
      location: loc,
      sourceTxnId: meta.sourceTxnId || null,
      merchant: meta.merchant || null,
      cities: ck ? new Set([ck]) : new Set(),
      ambiguous: false,
      source: meta.source || 'plaid',
    });
    return;
  }
  if (ck) prev.cities.add(ck);
  if (prev.cities.size > 1) {
    prev.ambiguous = true;
    // Keep most recent location for reference but do not inherit.
    prev.location = loc;
    prev.sourceTxnId = meta.sourceTxnId || prev.sourceTxnId;
  } else if (!prev.ambiguous) {
    // Prefer pin with city+region over sparse.
    const better =
      (loc.city && loc.region && !(prev.location?.city && prev.location?.region)) ||
      (loc.lat != null && prev.location?.lat == null);
    if (better || !prev.location) {
      prev.location = loc;
      prev.sourceTxnId = meta.sourceTxnId || prev.sourceTxnId;
    }
  }
  if (meta.merchant) prev.merchant = meta.merchant;
}

function ingestPlaidTxn(cache, t) {
  const loc = formatLocation(t.location);
  if (!loc) return false;
  const merchant = t.merchant_name || t.name || null;
  const meta = {
    sourceTxnId: t.transaction_id,
    merchant,
    source: 'plaid',
  };
  if (t.merchant_entity_id) {
    mergeIntoBucket(cache.byEntity, t.merchant_entity_id, loc, meta);
  }
  const nk = merchantNameKey(merchant);
  if (nk) mergeIntoBucket(cache.byName, nk, loc, meta);
  return true;
}

function ingestFormatted(cache, { entityId, name, location, sourceTxnId, source }) {
  const loc = formatLocation(location) || (hasUsableLocation(location) ? location : null);
  if (!loc) return false;
  const meta = { sourceTxnId, merchant: name, source: source || 'ddb' };
  if (entityId) mergeIntoBucket(cache.byEntity, entityId, loc, meta);
  const nk = merchantNameKey(name);
  if (nk) mergeIntoBucket(cache.byName, nk, loc, meta);
  return true;
}

/**
 * Build cache from a Plaid history dump (in-memory only).
 * Multi-city aware (unlike the original single-hit Map).
 */
function buildMerchantLocationCache(plaidTxns) {
  const cache = emptyCache();
  for (const t of plaidTxns || []) ingestPlaidTxn(cache, t);
  return cache;
}

/** Merge b into a (mutates a). */
function mergeCaches(a, b) {
  if (!b) return a || emptyCache();
  if (!a) return b;
  for (const [k, v] of b.byEntity || []) {
    if (v.location) {
      mergeIntoBucket(a.byEntity, k, v.location, {
        sourceTxnId: v.sourceTxnId,
        merchant: v.merchant,
        source: v.source,
      });
      // If b already ambiguous, force
      if (v.ambiguous) {
        const e = a.byEntity.get(k);
        if (e) e.ambiguous = true;
      }
    }
    if (v.cities) {
      const e = a.byEntity.get(k);
      if (e) {
        for (const c of v.cities) e.cities.add(c);
        if (e.cities.size > 1) e.ambiguous = true;
      }
    }
  }
  for (const [k, v] of b.byName || []) {
    if (v.location) {
      mergeIntoBucket(a.byName, k, v.location, {
        sourceTxnId: v.sourceTxnId,
        merchant: v.merchant,
        source: v.source,
      });
      if (v.ambiguous) {
        const e = a.byName.get(k);
        if (e) e.ambiguous = true;
      }
    }
    if (v.cities) {
      const e = a.byName.get(k);
      if (e) {
        for (const c of v.cities) e.cities.add(c);
        if (e.cities.size > 1) e.ambiguous = true;
      }
    }
  }
  return a;
}

function entryToLookup(entry) {
  if (!entry || entry.ambiguous || !entry.location) return null;
  return {
    location: entry.location,
    sourceTxnId: entry.sourceTxnId,
    merchant: entry.merchant,
    ambiguous: false,
  };
}

/**
 * Lookup for resolveLocation. Returns null if ambiguous or missing.
 */
function lookupEntity(cache, entityId) {
  if (!cache?.byEntity || !entityId) return null;
  return entryToLookup(cache.byEntity.get(entityId));
}

function lookupName(cache, name) {
  if (!cache?.byName || !name) return null;
  const key = merchantNameKey(name) || normName(name);
  if (!key) return null;
  let hit = entryToLookup(cache.byName.get(key));
  if (hit) return hit;
  // Soft: try shorter key without trailing tokens of length 1–2
  return null;
}

/**
 * Load durable MERCHANT#* rows for the plan into a cache.
 */
async function loadMerchantCacheFromDdb(planId = ledgerPlanId) {
  const cache = emptyCache();
  const rows = await ddb.queryPk(ddb.planPk(planId), 'MERCHANT#');
  for (const row of rows) {
    if (!row.location) continue;
    const sk = String(row.sk || '');
    const loc = row.location;
    const meta = {
      sourceTxnId: row.sourceTxnId || null,
      merchant: row.merchant || row.name || null,
      source: row.source || 'ddb',
    };
    if (sk.startsWith(SK_ENTITY)) {
      const id = sk.slice(SK_ENTITY.length);
      mergeIntoBucket(cache.byEntity, id, loc, meta);
      if (row.ambiguous) {
        const e = cache.byEntity.get(id);
        if (e) e.ambiguous = true;
      }
      if (Array.isArray(row.cityKeys)) {
        const e = cache.byEntity.get(id);
        if (e) {
          for (const c of row.cityKeys) e.cities.add(c);
          if (e.cities.size > 1) e.ambiguous = true;
        }
      }
    } else if (sk.startsWith(SK_NAME)) {
      const id = sk.slice(SK_NAME.length);
      mergeIntoBucket(cache.byName, id, loc, meta);
      if (row.ambiguous) {
        const e = cache.byName.get(id);
        if (e) e.ambiguous = true;
      }
      if (Array.isArray(row.cityKeys)) {
        const e = cache.byName.get(id);
        if (e) {
          for (const c of row.cityKeys) e.cities.add(c);
          if (e.cities.size > 1) e.ambiguous = true;
        }
      }
    }
  }
  return { cache, rowCount: rows.length };
}

/**
 * Harvest location pins already on TXN# rows into the in-memory cache.
 */
function harvestTxnLocations(cache, txnRows) {
  let n = 0;
  for (const t of txnRows || []) {
    const loc = t.location;
    if (!loc || !hasUsableLocation(loc)) continue;
    const ok = ingestFormatted(cache, {
      entityId: t.plaidMerchantEntityId || null,
      name: t.plaidMerchantName || null,
      location: loc,
      sourceTxnId: t.plaidTransactionId || t.ynabId || null,
      source: t.locationSource || 'txn',
    });
    if (ok) n += 1;
  }
  return n;
}

/**
 * Persist non-ambiguous + ambiguous merchant entries (so multi-city is remembered).
 */
async function persistMerchantCache(cache, planId = ledgerPlanId) {
  const pk = ddb.planPk(planId);
  const now = Date.now();
  const items = [];

  function push(skPrefix, key, entry) {
    if (!key || !entry?.location) return;
    items.push({
      pk,
      sk: `${skPrefix}${key}`,
      entityType: 'merchant_location',
      location: entry.location,
      locationDisplay: entry.locationDisplay || null,
      merchant: entry.merchant || null,
      sourceTxnId: entry.sourceTxnId || null,
      source: entry.source || 'plaid',
      ambiguous: !!entry.ambiguous,
      cityKeys: entry.cities ? [...entry.cities] : [],
      updatedAt: now,
    });
  }

  for (const [k, v] of cache.byEntity || []) push(SK_ENTITY, k, v);
  for (const [k, v] of cache.byName || []) push(SK_NAME, k, v);

  if (items.length) await ddb.batchWrite(items);
  return { written: items.length };
}

/**
 * User city priors from a location cache (most common cities first).
 * Used to bias geocode queries toward where this household actually spends.
 */
function userCityPriors(cache, limit = 5) {
  const counts = new Map(); // cityKey -> { city, region, country, n }
  function tally(entry) {
    if (!entry?.location?.city) return;
    const loc = entry.location;
    const ck = cityKey(loc);
    if (!ck) return;
    const prev = counts.get(ck) || {
      city: loc.city,
      region: loc.region || null,
      country: loc.country || null,
      n: 0,
    };
    prev.n += 1;
    counts.set(ck, prev);
  }
  for (const e of (cache.byEntity || []).values()) tally(e);
  for (const e of (cache.byName || []).values()) tally(e);
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((x) => ({
      city: x.city,
      region: x.region,
      country: x.country,
      weight: x.n,
    }));
}

/**
 * Nominatim (OSM) geocode — rate-limited, personal-use User-Agent.
 * Returns formatLocation-shaped object or null.
 */
async function geocodeNominatim(query, { signal } = {}) {
  const q = String(query || '').trim();
  if (!q || q.length < 3) return null;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'R2Finance/1.0 (personal finance; contact: finance.i-liquid.be)',
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) return null;
  const arr = await res.json();
  const hit = Array.isArray(arr) ? arr[0] : null;
  if (!hit) return null;
  const addr = hit.address || {};
  const city =
    addr.city ||
    addr.town ||
    addr.village ||
    addr.hamlet ||
    addr.municipality ||
    addr.suburb ||
    null;
  const region = addr.state || addr.region || null;
  const country = addr.country_code
    ? String(addr.country_code).toUpperCase()
    : addr.country || null;
  const loc = formatLocation({
    address: hit.display_name?.split(',')[0] || null,
    city,
    region,
    postal_code: addr.postcode || null,
    country,
    lat: hit.lat != null ? Number(hit.lat) : null,
    lon: hit.lon != null ? Number(hit.lon) : null,
  });
  return loc;
}

/**
 * Build geocode query list for a physical merchant.
 * Returns [] when we should not geocode (online / national brand with no city).
 */
function geocodeQueriesForMerchant(plaidTxn, cityPriors = []) {
  const channel = plaidTxn.payment_channel || '';
  const name = plaidTxn.merchant_name || plaidTxn.name;
  if (!name) return [];
  if (channel === 'online' || channel === 'other') return [];
  // ACH-like names
  if (/ACH|PPD|WEB|PAYMENT|ORIG CO|PAYROLL|VENMO|ZELLE/i.test(plaidTxn.name || '')) {
    return [];
  }
  const isPhysical =
    channel === 'in store' ||
    (!channel && !/ACH|PPD|WEB|PAYMENT|ORIG CO/i.test(plaidTxn.name || ''));
  if (!isPhysical) return [];

  const queries = [];
  const cityHint = plaidTxn.location?.city;
  const regionHint = plaidTxn.location?.region;
  if (cityHint) {
    queries.push(
      [name, cityHint, regionHint].filter(Boolean).join(', '),
    );
  }

  const multi = isMultiCityBrand(name);
  if (multi && !cityHint && !cityPriors.length) {
    return []; // never bare-geocode Starbucks globally
  }

  for (const p of cityPriors) {
    const q = [name, p.city, p.region].filter(Boolean).join(', ');
    if (!queries.includes(q)) queries.push(q);
    if (queries.length >= 4) break;
  }

  // Local-only merchants: one bare query as last resort (Nominatim often needs city)
  if (!multi && !queries.length) {
    queries.push(name);
  }

  return queries;
}

/**
 * Run geocode for candidates; mutate cache + return map plaidTxnId → location.
 * maxQueries caps Nominatim calls per enrich run (default 12).
 */
async function geocodeCandidates(candidates, cityPriors, { maxQueries = 12 } = {}) {
  const results = new Map(); // plaid transaction_id → { location, query }
  let used = 0;
  for (const c of candidates) {
    if (used >= maxQueries) break;
    const plaid = c.rawPlaid || c.plaid || c;
    const id = plaid.transaction_id || c.plaidTransactionId;
    if (!id || results.has(id)) continue;
    const queries = geocodeQueriesForMerchant(plaid, cityPriors);
    if (!queries.length) continue;
    for (const q of queries) {
      if (used >= maxQueries) break;
      used += 1;
      try {
        // Nominatim usage policy: max 1 req/sec
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, used === 1 ? 0 : 1100));
        // eslint-disable-next-line no-await-in-loop
        const loc = await geocodeNominatim(q);
        if (loc && (loc.city || loc.lat != null)) {
          results.set(id, { location: loc, query: q, merchant: plaid.merchant_name || plaid.name });
          // seed cache
          break;
        }
      } catch (e) {
        console.warn('geocode failed', q, e.message);
      }
    }
  }
  return { results, queriesUsed: used };
}

module.exports = {
  SK_ENTITY,
  SK_NAME,
  MULTI_CITY_BRANDS,
  cityKey,
  merchantNameKey,
  isMultiCityBrand,
  emptyCache,
  buildMerchantLocationCache,
  mergeCaches,
  mergeIntoBucket,
  ingestPlaidTxn,
  ingestFormatted,
  lookupEntity,
  lookupName,
  loadMerchantCacheFromDdb,
  harvestTxnLocations,
  persistMerchantCache,
  userCityPriors,
  geocodeNominatim,
  geocodeQueriesForMerchant,
  geocodeCandidates,
};
