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
  nameScore,
  formatLocation,
  hasUsableLocation,
} = require('./plaidMatch');

/** Street line has a house/route number — not a bare POI business name. */
function isStreetLikeAddress(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/.test(t)) return false;
  return /\d/.test(t);
}

/**
 * Soft relatedness for payee vs geocoded POI label.
 * Rejects "Don's Cafe" ↔ "Sister's cafe" (only generic "cafe" overlap).
 */
function placeNameRelated(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const score = nameScore(a, b);
  if (score >= 0.5) return true;
  // Distinctive non-generic token must match (avoid cafe/coffee-only hits).
  const generic = new Set([
    'cafe',
    'coffee',
    'restaurant',
    'bar',
    'grill',
    'kitchen',
    'bistro',
    'shop',
    'store',
    'market',
    'food',
  ]);
  const A = new Set(na.split(' ').filter((w) => w.length > 2));
  const B = new Set(nb.split(' ').filter((w) => w.length > 2));
  for (const t of A) {
    if (B.has(t) && !generic.has(t)) return true;
  }
  return false;
}

/**
 * Drop geocoded POI names that do not match the merchant (keep city/region).
 * Street addresses always kept. Prevents Maps queries like
 * "Don's Cafe Sister's cafe, Bellevue, WA".
 */
function sanitizeGeocodedLocation(loc, merchantName) {
  if (!loc || typeof loc !== 'object') return null;
  const addr = String(loc.address || '').trim();
  if (!addr || isStreetLikeAddress(addr)) {
    return formatLocation(loc) || loc;
  }
  if (!merchantName || placeNameRelated(merchantName, addr)) {
    // Matching POI name — keep as label (or strip to avoid payee dup; keep for cache).
    return formatLocation(loc) || loc;
  }
  // Wrong business name in address field — keep geo only.
  const cleaned = {
    address: null,
    city: loc.city || null,
    region: loc.region || null,
    postal_code: loc.postal_code || null,
    country: loc.country || null,
    lat: loc.lat ?? null,
    lon: loc.lon ?? null,
    store_number: loc.store_number || null,
  };
  if (!hasUsableLocation(cleaned)) return null;
  return formatLocation(cleaned) || cleaned;
}

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
 * Uses every cityKey on multi-city merchants (not just the last pin).
 */
function userCityPriors(cache, limit = 6) {
  const counts = new Map(); // city lower → { city, region, country, n }
  function add(city, region, country, w = 1) {
    if (!city) return;
    const k = String(city).toLowerCase().trim();
    if (!k) return;
    const prev = counts.get(k) || {
      city: String(city).trim(),
      region: region || null,
      country: country || null,
      n: 0,
    };
    prev.n += w;
    // Prefer entries that include a region
    if (!prev.region && region) prev.region = region;
    counts.set(k, prev);
  }
  function tally(entry) {
    if (entry?.cities && entry.cities.size) {
      for (const ck of entry.cities) {
        const [city, region] = String(ck).split('|');
        if (city) add(city, region || null, null, 1);
      }
      return;
    }
    if (entry?.location?.city) {
      add(entry.location.city, entry.location.region, entry.location.country, 1);
    }
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

function cityMatchesPrior(locCity, priorCity) {
  const a = normName(locCity);
  const b = normName(priorCity);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Prefer a geocode hit that matches household priors and/or an explicit place hint.
 * @param {{ city?: string, country?: string }|null} placeHint
 */
function pickAcceptedLocation(candidates, priors, placeHint = null) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return null;

  if (placeHint?.country) {
    const want = String(placeHint.country).toUpperCase();
    const foreign = list.filter((loc) => {
      const c = String(loc.country || '').toUpperCase();
      return c === want || c.startsWith(want);
    });
    if (placeHint.city) {
      const byCity = foreign.find((loc) => cityMatchesPrior(loc.city, placeHint.city));
      if (byCity) return byCity;
    }
    if (foreign.length) return foreign[0];
    return null; // do not fall back to US home priors for foreign-hinted merchants
  }

  if (!priors?.length) return list[0];
  for (const loc of list) {
    // Prefer US / empty country for home priors
    const c = String(loc.country || '').toUpperCase();
    if (c && c !== 'US' && c !== 'USA' && c !== 'UNITED STATES') continue;
    if (priors.some((p) => cityMatchesPrior(loc.city, p.city))) return loc;
  }
  // No prior match — reject (avoids Korea for "Cafe Seattle" style noise)
  return null;
}

/**
 * Nominatim (OSM) geocode — personal-use User-Agent.
 * Returns up to `limit` formatLocation-shaped objects.
 */
async function geocodeNominatim(query, { signal, limit = 3 } = {}) {
  const q = String(query || '').trim();
  if (!q || q.length < 3) return [];
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'R2Finance/1.0 (personal finance; contact: finance.i-liquid.be)',
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) return [];
  const arr = await res.json();
  if (!Array.isArray(arr)) return [];
  return arr
    .map((hit) => {
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
      // Prefer real street line over POI display-name head (often a wrong business).
      const street = [addr.house_number, addr.road || addr.pedestrian || addr.footway]
        .filter(Boolean)
        .join(' ')
        .trim();
      const poiLabel = hit.name || hit.display_name?.split(',')[0] || null;
      return formatLocation({
        address: street || poiLabel || null,
        city,
        region,
        postal_code: addr.postcode || null,
        country,
        lat: hit.lat != null ? Number(hit.lat) : null,
        lon: hit.lon != null ? Number(hit.lon) : null,
      });
    })
    .filter(Boolean);
}

/**
 * Photon (Komoot) — often better for POI names Nominatim misses.
 * No key required; be gentle on rate.
 */
async function geocodePhoton(query, { signal, limit = 3 } = {}) {
  const q = String(query || '').trim();
  if (!q || q.length < 3) return [];
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) return [];
  const body = await res.json();
  const feats = body.features || [];
  return feats
    .map((f) => {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates; // [lon, lat]
      const city = p.city || p.locality || p.district || null;
      const region = p.state || p.county || null;
      const country = p.countrycode
        ? String(p.countrycode).toUpperCase()
        : p.country || null;
      // Prefer street over POI name (name often mismatches the card merchant).
      const street = [p.housenumber, p.street].filter(Boolean).join(' ').trim();
      return formatLocation({
        address: street || p.name || null,
        city,
        region,
        postal_code: p.postcode || null,
        country,
        lat: coords ? Number(coords[1]) : null,
        lon: coords ? Number(coords[0]) : null,
      });
    })
    .filter(Boolean);
}

/** Try Nominatim then Photon; accept only prior-matching cities when priors given. */
async function geocodeQuery(query, priors = [], { signal, placeHint = null } = {}) {
  let hits = await geocodeNominatim(query, { signal, limit: 3 });
  let accepted = pickAcceptedLocation(hits, priors, placeHint);
  if (accepted) return accepted;
  hits = await geocodePhoton(query, { signal, limit: 5 });
  accepted = pickAcceptedLocation(hits, priors, placeHint);
  return accepted;
}

/** Soft name variants to improve POI hit rate (Cafe ↔ Coffee, strip The). */
function merchantQueryVariants(name) {
  const base = String(name || '').trim();
  if (!base) return [];
  const out = [base];
  const alt = base
    .replace(/\bCafe\b/gi, 'Coffee')
    .replace(/\bCoffee\b/gi, 'Cafe');
  if (alt !== base) out.push(alt);
  const noThe = base.replace(/^the\s+/i, '');
  if (noThe !== base) out.push(noThe);
  return [...new Set(out)];
}

/**
 * Detect travel / foreign place hints in the merchant string so we do not
 * pin "Singapore Food Street" to Bellevue via household priors.
 */
function placeHintFromName(name) {
  const s = String(name || '');
  const rules = [
    { re: /\bsingapore\b/i, city: 'Singapore', country: 'SG' },
    // Common SG chains that omit "Singapore" in the card descriptor
    { re: /\bjumbo seafood\b/i, city: 'Singapore', country: 'SG' },
    { re: /\btokyo\b|\bosaka\b|\bkyoto\b|\bjapan\b|\bhaneda\b|\bginza\b/i, country: 'JP' },
    { re: /\bvietnam\b|\bhanoi\b|\bho chi minh\b|\bsaigon\b|\bda nang\b|\btam coc\b/i, country: 'VN' },
    { re: /\bseoul\b|\bkorea\b/i, country: 'KR' },
    { re: /\bbangkok\b|\bthailand\b/i, country: 'TH' },
    { re: /\bparis\b|\bfrance\b/i, country: 'FR' },
    { re: /\blondon\b|\buk\b|\bunited kingdom\b/i, country: 'GB' },
    { re: /\bphu quoc\b/i, city: 'Phu Quoc', country: 'VN' },
  ];
  for (const r of rules) {
    if (r.re.test(s)) return { city: r.city || null, country: r.country || null };
  }
  return null;
}

/**
 * Build geocode query list for a physical merchant.
 * Returns [] when we should not geocode (online / national brand with no city).
 */
function geocodeQueriesForMerchant(plaidTxn, cityPriors = []) {
  const channel = plaidTxn.payment_channel || '';
  const name = plaidTxn.merchant_name || plaidTxn.name;
  if (!name) return [];
  if (channel === 'online') return [];
  // ACH / card payments / peer transfer
  if (
    /ACH|PPD|WEB|PAYMENT TO |ORIG CO|PAYROLL|VENMO|ZELLE|WIRE/i.test(
      plaidTxn.name || name || '',
    )
  ) {
    return [];
  }
  // payment_channel "other" is often Airbnb/transfer — only allow if looks like a store
  if (channel === 'other') return [];
  const isPhysical =
    channel === 'in store' ||
    (!channel && !/ACH|PPD|WEB|PAYMENT|ORIG CO/i.test(plaidTxn.name || ''));
  if (!isPhysical) return [];

  // Rideshare / delivery apps — no fixed pin worth showing
  if (
    /\b(uber|lyft|doordash|grubhub|postmates|grab|foodpanda|gojek)\b/i.test(
      name,
    )
  ) {
    return [];
  }

  const names = merchantQueryVariants(name);
  const queries = [];
  const cityHint = plaidTxn.location?.city;
  const regionHint = plaidTxn.location?.region;
  const placeHint = placeHintFromName(name);

  // Travel / foreign merchants: only query with the place hint (skip home priors)
  if (placeHint?.country) {
    for (const n of names) {
      const q = [n, placeHint.city, placeHint.country].filter(Boolean).join(', ');
      if (!queries.includes(q)) queries.push(q);
    }
    return queries;
  }

  if (cityHint) {
    for (const n of names) {
      queries.push([n, cityHint, regionHint].filter(Boolean).join(', '));
    }
  }

  const multi = isMultiCityBrand(name);
  if (multi && !cityHint && !cityPriors.length) {
    return []; // never bare-geocode Starbucks globally
  }

  for (const p of cityPriors) {
    for (const n of names) {
      const q = [n, p.city, p.region].filter(Boolean).join(', ');
      if (!queries.includes(q)) queries.push(q);
    }
    if (queries.length >= 8) break;
  }

  // Local-only merchants: bare query last (Photon may still hit; we require prior match)
  if (!multi && cityPriors.length) {
    for (const n of names) {
      if (!queries.includes(n)) queries.push(n);
    }
  }

  return queries;
}

/**
 * Run geocode for candidates; return map plaidTxnId → location.
 * maxQueries caps external calls per enrich run (default 14).
 */
async function geocodeCandidates(candidates, cityPriors, { maxQueries = 14 } = {}) {
  const results = new Map(); // plaid transaction_id → { location, query }
  let used = 0;
  // Prefer unique merchants first (one success seeds cache for siblings)
  const seenMerchant = new Set();
  const ordered = [...candidates].sort((a, b) => {
    const na = (a.rawPlaid || a.plaid || a).merchant_name || '';
    const nb = (b.rawPlaid || b.plaid || b).merchant_name || '';
    return na.localeCompare(nb);
  });

  for (const c of ordered) {
    if (used >= maxQueries) break;
    const plaid = c.rawPlaid || c.plaid || c;
    const id = plaid.transaction_id || c.plaidTransactionId;
    if (!id || results.has(id)) continue;
    const mkey = merchantNameKey(plaid.merchant_name || plaid.name);
    // If we already geocoded this merchant name this run, reuse
    if (mkey && seenMerchant.has(mkey)) {
      const prev = [...results.values()].find(
        (r) => merchantNameKey(r.merchant) === mkey,
      );
      if (prev) {
        results.set(id, { ...prev });
        continue;
      }
    }
    const queries = geocodeQueriesForMerchant(plaid, cityPriors);
    if (!queries.length) continue;
    const placeHint = placeHintFromName(plaid.merchant_name || plaid.name);
    for (const q of queries) {
      if (used >= maxQueries) break;
      used += 1;
      try {
        // ~1 req/sec across providers
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, used === 1 ? 0 : 900));
        // eslint-disable-next-line no-await-in-loop
        const rawLoc = await geocodeQuery(q, cityPriors, { placeHint });
        const merchant = plaid.merchant_name || plaid.name;
        // Strip mismatched POI names (Sister's cafe for Don's Cafe) — keep city.
        const loc = sanitizeGeocodedLocation(rawLoc, merchant);
        if (loc && (loc.city || loc.lat != null)) {
          results.set(id, {
            location: loc,
            query: q,
            merchant,
          });
          if (mkey) seenMerchant.add(mkey);
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
  cityMatchesPrior,
  pickAcceptedLocation,
  isStreetLikeAddress,
  placeNameRelated,
  sanitizeGeocodedLocation,
  geocodeNominatim,
  geocodePhoton,
  geocodeQuery,
  geocodeQueriesForMerchant,
  geocodeCandidates,
  merchantQueryVariants,
  placeHintFromName,
};
