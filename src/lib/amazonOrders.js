'use strict';

/**
 * Amazon order enrichment for R2Finance.
 *
 * Chrome extension scrapes amazon.com (logged-in session) once a day and
 * POSTs orders here. We store them in DDB and match bank/Plaid descriptors
 * like "AMAZON MKTPL*LR52S7I73" / "Amazon.com*RN0L04R61" to order items + URL.
 */

// Lazy-load AWS/DDB so pure helpers stay unit-testable without side effects.
function ddb() {
  return require('./ddb');
}
const { ledgerPlanId } = require('./config');
const { parseImportPayeeName } = require('./displayPayee');

const ORDER_SK_PREFIX = 'AMAZON#ORDER#';
const META_SK = 'AMAZON#META';
/** Date window for amount-based matching (bank lag / Amazon charge delay). */
const DATE_WINDOW_DAYS = 5;

function orderSk(orderNumber) {
  return `${ORDER_SK_PREFIX}${String(orderNumber).trim()}`;
}

function orderUrlFor(orderNumber, domain = 'www.amazon.com') {
  const id = encodeURIComponent(String(orderNumber).trim());
  const host = String(domain || 'www.amazon.com').replace(/^https?:\/\//, '');
  // Modern Amazon order-details URL (legacy /gp/your-account/… still works).
  return `https://${host}/your-orders/order-details?orderID=${id}`;
}

/**
 * Extract short charge / marketplace ref from bank payee strings.
 *   AMAZON MKTPL*LR52S7I73  → LR52S7I73
 *   Amazon.com*RN0L04R61    → RN0L04R61
 *   AMZN Mktp US*AB12C3D4E  → AB12C3D4E
 */
function extractAmazonChargeRef(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  const patterns = [
    /(?:AMAZON|AMZN)[^*\n]{0,40}\*([A-Z0-9]{5,14})\b/i,
    /Amazon\.com\*([A-Z0-9]{5,14})\b/i,
    /Amazon\.co\.jp\*([A-Z0-9]{5,14})\b/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** True when payee/import/plaid looks like an Amazon retail charge (not salary). */
function isAmazonRetailBlob(text) {
  if (!text) return false;
  const s = String(text);
  if (/salary|stock|reimburse|payroll|dividend/i.test(s)) return false;
  return (
    /AMAZON\s*MKTPL/i.test(s) ||
    /AMZN\s*Mktp/i.test(s) ||
    /Amazon\.com\*/i.test(s) ||
    /AMAZON\.COM\*/i.test(s) ||
    /AMZN\.COM/i.test(s) ||
    /\bAMAZON\b/i.test(s) ||
    /\bAMZN\b/i.test(s)
  );
}

function isAmazonRetailTxn(t) {
  const parts = [
    t.payeeName,
    t.importPayeeName,
    t.plaidMerchantName,
    t.payload?.payee_name,
    t.payload?.import_payee_name,
  ];
  return parts.some((p) => isAmazonRetailBlob(p));
}

/** Parse "$12.34" / "12.34 USD" / 12.34 → absolute milliunits. */
function parseMoneyToMilli(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(Math.abs(value) * 1000);
  }
  const s = String(value).replace(/,/g, '').trim();
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  return Math.round(Math.abs(Number(m[0])) * 1000);
}

function dateDiffDays(a, b) {
  if (!a || !b) return Infinity;
  const ta = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

function normalizeOrderDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // e.g. "January 5, 2026" / "Jan 5, 2026"
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

function summarizeItems(items, max = 3) {
  const list = (items || [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (!list.length) return null;
  const head = list.slice(0, max);
  const extra = list.length - head.length;
  let s = head.join(', ');
  if (extra > 0) s += ` (+${extra} more)`;
  // Keep inbox lines readable.
  if (s.length > 140) s = `${s.slice(0, 137)}…`;
  return s;
}

/**
 * Normalize delivery place for payee lines: "Portland, ME".
 * Accepts shipCity + shipState, or a preformatted shipLocation.
 */
function formatShipLocation(city, state, preformatted) {
  if (preformatted != null && String(preformatted).trim()) {
    const pre = String(preformatted).trim().replace(/\s+/g, ' ');
    // Only trust short "City, ST" preformatted values — not full streets.
    if (pre.length <= 40 && !/\d/.test(pre)) return pre;
  }
  const c = city != null ? String(city).trim().replace(/\s+/g, ' ') : '';
  const st = state != null ? String(state).trim().toUpperCase() : '';
  if (c && st && c.length <= 32 && !/\d/.test(c)) return `${c}, ${st}`;
  if (c && c.length <= 32 && !/\d/.test(c)) return c;
  if (st && /^[A-Z]{2}$/.test(st)) return st;
  return null;
}

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(
    ' ',
  ),
);

/**
 * Heal scrapes that put the whole address into shipCity
 * e.g. "Richard Mondor 53 PINE ST APT 1F PORTLAND ME" → Portland, ME
 */
function titleCaseCity(city) {
  return String(city)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function healShipCityState(cityBlob, stateHint) {
  const s = String(cityBlob || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const noise =
    /^(st|ave|avenue|street|road|rd|blvd|ln|dr|way|apt|suite|ste|ne|nw|se|sw|n|s|e|w|to)$/i;

  // Prefer last single-word city before a US state: "... PORTLAND ME"
  let last = null;
  for (const m of s.matchAll(
    /\b([A-Za-z][A-Za-z.'\-]{2,24})\s+([A-Z]{2})(?:\s+\d{5})?(?=\s|$)/gi,
  )) {
    const city = m[1].trim();
    const st = m[2].toUpperCase();
    if (!US_STATES.has(st) || noise.test(city) || /\d/.test(city)) continue;
    last = { shipCity: titleCaseCity(city), shipState: st };
  }
  if (last) return last;

  // Comma form
  const m = s.match(/\b([A-Za-z][A-Za-z.'\-\s]{1,28}?),?\s*([A-Z]{2})\s*$/i);
  if (m && US_STATES.has(m[2].toUpperCase()) && !/\d/.test(m[1])) {
    const words = m[1]
      .replace(/,/g, '')
      .trim()
      .split(/\s+/)
      .filter((w) => w && !noise.test(w));
    const city = words.slice(-2).join(' ');
    if (city.length >= 2 && city.length <= 32) {
      return { shipCity: titleCaseCity(city), shipState: m[2].toUpperCase() };
    }
  }

  if (
    stateHint &&
    US_STATES.has(String(stateHint).toUpperCase()) &&
    s.length <= 32 &&
    !/\d/.test(s) &&
    !noise.test(s)
  ) {
    return {
      shipCity: titleCaseCity(s),
      shipState: String(stateHint).toUpperCase(),
    };
  }
  return null;
}

function normalizeIncomingOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const orderNumber = String(
    raw.orderNumber || raw.order_id || raw.orderId || '',
  ).trim();
  if (!orderNumber) return null;
  const junkItem =
    /^(amazon\s+(secured|business|store|visa|mastercard|prime)\s*card|ending in\s*\d{4}|visa|mastercard|american express|discover)$/i;
  const items = Array.isArray(raw.items)
    ? raw.items
        .map((x) => String(x || '').trim())
        .filter((t) => t && t.length >= 3 && t.length <= 300 && !junkItem.test(t))
        .slice(0, 40)
    : [];
  const domain = raw.domain || raw.amazonDomain || 'www.amazon.com';
  const orderUrl =
    (raw.orderUrl || raw.order_url || '').trim() ||
    orderUrlFor(orderNumber, domain);
  const junkRef =
    /^(GARDEN|WINDOW|LENGTH|AMAZON|AMZN|METHODS|PAYMENT|TOTAL|ORDER|SHIPPING|RETURNED|REFUNDED|CARD|VISA|MASTER)$/i;
  const chargeRefs = Array.isArray(raw.chargeRefs || raw.paymentRefs)
    ? (raw.chargeRefs || raw.paymentRefs)
        .map((r) => String(r || '').trim().toUpperCase())
        .filter(
          (r) =>
            r &&
            r.length >= 5 &&
            r.length <= 14 &&
            !junkRef.test(r) &&
            /\d/.test(r),
        )
    : [];
  // Also accept a single chargeRef on the order.
  if (raw.chargeRef) {
    const r = String(raw.chargeRef).trim().toUpperCase();
    if (r && !junkRef.test(r) && /\d/.test(r)) chargeRefs.push(r);
  }
  const grandTotalMilli =
    raw.grandTotalMilli != null
      ? Math.abs(Number(raw.grandTotalMilli))
      : parseMoneyToMilli(raw.grandTotal ?? raw.total ?? raw.amount);
  const shipCityRaw =
    raw.shipCity || raw.shippingCity || raw.deliveryCity || null;
  const shipStateRaw =
    raw.shipState || raw.shippingState || raw.deliveryState || null;
  // Prefer structured city/state; heal bad scrapes like full address lines.
  let shipCity =
    shipCityRaw != null ? String(shipCityRaw).trim().replace(/\s+/g, ' ') : null;
  let shipState =
    shipStateRaw != null
      ? String(shipStateRaw).trim().toUpperCase()
      : null;
  if (shipState && shipState.length > 2) {
    shipState = shipState.slice(0, 2);
  }
  // If city looks like a full street address, re-extract trailing City ST.
  if (shipCity && (shipCity.length > 28 || /\d/.test(shipCity) || !shipState)) {
    const healed = healShipCityState(shipCity, shipState);
    if (healed) {
      shipCity = healed.shipCity;
      shipState = healed.shipState;
    } else if (shipCity.length > 28 || /\d/.test(shipCity)) {
      shipCity = null;
    }
  }
  if (shipCity && !shipCity.length) shipCity = null;
  if (shipState && !/^[A-Z]{2}$/.test(shipState)) shipState = null;
  const shipLocation = formatShipLocation(
    shipCity,
    shipState,
    raw.shipLocation || raw.shippingLocation || raw.deliveryLocation,
  );
  return {
    orderNumber,
    orderDate: normalizeOrderDate(raw.orderDate || raw.date || raw.order_date),
    grandTotalMilli:
      grandTotalMilli != null && Number.isFinite(grandTotalMilli)
        ? grandTotalMilli
        : null,
    items,
    itemsSummary: summarizeItems(items) || raw.itemsSummary || null,
    orderUrl,
    chargeRefs: [...new Set(chargeRefs)],
    domain: String(domain).replace(/^https?:\/\//, ''),
    currency: raw.currency || 'USD',
    shipCity: shipCity || null,
    shipState: shipState || null,
    shipLocation:
      formatShipLocation(shipCity, shipState, shipLocation) || null,
  };
}

async function listStoredOrders(planId = ledgerPlanId) {
  const db = ddb();
  const rows = await db.queryPk(db.planPk(planId), ORDER_SK_PREFIX);
  return rows
    .filter((r) => !r.deleted)
    .map((r) => ({
      orderNumber: r.orderNumber,
      orderDate: r.orderDate || null,
      grandTotalMilli: r.grandTotalMilli ?? null,
      items: r.items || [],
      itemsSummary: r.itemsSummary || summarizeItems(r.items),
      orderUrl: r.orderUrl || orderUrlFor(r.orderNumber, r.domain),
      chargeRefs: r.chargeRefs || [],
      domain: r.domain || 'www.amazon.com',
      shipCity: r.shipCity || null,
      shipState: r.shipState || null,
      shipLocation:
        r.shipLocation ||
        formatShipLocation(r.shipCity, r.shipState) ||
        null,
      updatedAt: r.updatedAt || 0,
    }));
}

/**
 * Upsert scraped orders and re-match ledger Amazon charges.
 * @returns {{ upserted: number, matched: number, orders: number }}
 */
async function upsertOrders(ordersInput, { planId = ledgerPlanId } = {}) {
  const list = Array.isArray(ordersInput) ? ordersInput : [];
  const now = Date.now();
  const items = [];
  for (const raw of list) {
    const o = normalizeIncomingOrder(raw);
    if (!o) continue;
    items.push({
      pk: `PLAN#${planId}`,
      sk: orderSk(o.orderNumber),
      entityType: 'amazon_order',
      orderNumber: o.orderNumber,
      orderDate: o.orderDate,
      grandTotalMilli: o.grandTotalMilli,
      items: o.items,
      itemsSummary: o.itemsSummary,
      orderUrl: o.orderUrl,
      chargeRefs: o.chargeRefs,
      domain: o.domain,
      currency: o.currency,
      shipCity: o.shipCity,
      shipState: o.shipState,
      shipLocation: o.shipLocation,
      updatedAt: now,
      deleted: false,
    });
  }
  const db = ddb();
  if (items.length) {
    // Rewrite pk with real plan helper (ddb may not be loaded at normalize time).
    for (const it of items) {
      it.pk = db.planPk(planId);
    }
    await db.batchWrite(items);
  }
  await db.putItem({
    pk: db.planPk(planId),
    sk: META_SK,
    entityType: 'amazon_meta',
    lastSyncAt: now,
    lastOrderCount: items.length,
    updatedAt: now,
  });

  const match = await matchAndStampTransactions({ planId });
  return {
    upserted: items.length,
    matched: match.matched,
    considered: match.considered,
    orders: items.length,
    lastSyncAt: now,
  };
}

function txnChargeRef(t) {
  const blobs = [
    t.payeeName,
    t.importPayeeName,
    t.plaidMerchantName,
    t.payload?.payee_name,
    parseImportPayeeName(t.payload?.import_payee_name),
    t.payload?.import_payee_name,
  ];
  for (const b of blobs) {
    const ref = extractAmazonChargeRef(b);
    if (ref) return ref;
  }
  return null;
}

function buildRefIndex(orders) {
  const byRef = new Map();
  for (const o of orders) {
    for (const r of o.chargeRefs || []) {
      if (!byRef.has(r)) byRef.set(r, []);
      byRef.get(r).push(o);
    }
  }
  return byRef;
}

/**
 * Pick best order for a ledger txn.
 *
 * Charge refs like LR52S7I73 are often shared across many Amazon charges
 * (same terminal / descriptor), so we never match on ref alone — amount must
 * agree (±1¢). Prefer unique amount within date window otherwise.
 */
function matchOrderForTxn(t, orders, byRef) {
  const amt = Math.abs(Number(t.amount ?? t.payload?.amount ?? 0));
  const txnDate = t.date || t.payload?.date;
  const ref = txnChargeRef(t);

  if (ref && byRef.has(ref) && amt) {
    const cands = byRef.get(ref).filter((o) => {
      if (o.grandTotalMilli == null) return false;
      return Math.abs(o.grandTotalMilli - amt) <= 10;
    });
    if (cands.length === 1) {
      return { order: cands[0], method: 'charge_ref' };
    }
    if (cands.length > 1) {
      let best = null;
      let bestScore = Infinity;
      for (const o of cands) {
        const d = dateDiffDays(txnDate, o.orderDate);
        if (d > DATE_WINDOW_DAYS) continue;
        if (d < bestScore) {
          bestScore = d;
          best = o;
        }
      }
      if (best != null && bestScore < Infinity) {
        // Unique best date among amount-matched ref hits
        const ties = cands.filter(
          (o) => dateDiffDays(txnDate, o.orderDate) === bestScore,
        );
        const nums = new Set(ties.map((o) => o.orderNumber));
        if (nums.size === 1) {
          return { order: best, method: 'charge_ref' };
        }
      }
    }
  }

  if (!amt) return null;
  /** @type {{ order: object, score: number }[]} */
  const scored = [];
  for (const o of orders) {
    if (o.grandTotalMilli == null) continue;
    // Exact milli match, or within 1 cent (rounding).
    if (Math.abs(o.grandTotalMilli - amt) > 10) continue;
    const d = dateDiffDays(txnDate, o.orderDate);
    if (d > DATE_WINDOW_DAYS) continue;
    scored.push({ order: o, score: d });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.score - b.score);
  // Require uniqueness at best score to avoid wrong multi-order days.
  const best = scored[0];
  const ties = scored.filter((s) => s.score === best.score);
  if (ties.length > 1) {
    const nums = new Set(ties.map((x) => x.order.orderNumber));
    if (nums.size > 1) return null;
  }
  return { order: best.order, method: 'amount_date' };
}

function stampFieldsFromOrder(order, method) {
  const shipLocation =
    order.shipLocation ||
    formatShipLocation(order.shipCity, order.shipState) ||
    null;
  return {
    amazonOrderNumber: order.orderNumber,
    amazonOrderUrl: order.orderUrl || orderUrlFor(order.orderNumber, order.domain),
    amazonItems: order.items || [],
    amazonItemsSummary:
      order.itemsSummary || summarizeItems(order.items) || null,
    amazonShipCity: order.shipCity || null,
    amazonShipState: order.shipState || null,
    amazonShipLocation: shipLocation,
    amazonMatchedAt: Date.now(),
    amazonMatchMethod: method,
  };
}

/**
 * Walk TXN# rows that look like Amazon retail and stamp matches.
 * Only writes when match changes (or force).
 */
async function matchAndStampTransactions({
  planId = ledgerPlanId,
  force = false,
} = {}) {
  const orders = await listStoredOrders(planId);
  if (!orders.length) {
    return { matched: 0, considered: 0, orders: 0 };
  }
  const byRef = buildRefIndex(orders);
  const db = ddb();
  const txns = await db.queryPk(db.planPk(planId), 'TXN#');
  let considered = 0;
  let matched = 0;
  const writes = [];

  for (const raw of txns) {
    if (raw.deleted) continue;
    if (!isAmazonRetailTxn(raw)) continue;
    // Skip non-spend noise (large credits often salary/reimbursement already filtered).
    considered += 1;
    const hit = matchOrderForTxn(raw, orders, byRef);
    if (!hit) continue;
    const stamp = stampFieldsFromOrder(hit.order, hit.method);
    // Skip write when already stamped with same order + items + ship (unless force).
    if (
      !force &&
      raw.amazonOrderNumber === stamp.amazonOrderNumber &&
      raw.amazonOrderUrl === stamp.amazonOrderUrl &&
      raw.amazonItemsSummary === stamp.amazonItemsSummary &&
      (raw.amazonShipLocation || null) === (stamp.amazonShipLocation || null)
    ) {
      continue;
    }
    matched += 1;
    writes.push({
      ...raw,
      ...stamp,
      updatedAt: Date.now(),
    });
  }

  if (writes.length) {
    await db.batchWrite(writes);
  }
  return { matched, considered, orders: orders.length, stamped: writes.length };
}

/**
 * Attach amazon* fields onto a mapped client txn (from DDB row).
 */
function attachAmazonFields(mapped, ddbRow) {
  if (!mapped || !ddbRow) return mapped;
  if (ddbRow.amazonOrderNumber) {
    mapped.amazonOrderNumber = ddbRow.amazonOrderNumber;
  }
  if (ddbRow.amazonOrderUrl) mapped.amazonOrderUrl = ddbRow.amazonOrderUrl;
  if (Array.isArray(ddbRow.amazonItems) && ddbRow.amazonItems.length) {
    mapped.amazonItems = ddbRow.amazonItems;
  }
  if (ddbRow.amazonItemsSummary) {
    mapped.amazonItemsSummary = ddbRow.amazonItemsSummary;
  }
  if (ddbRow.amazonShipCity) mapped.amazonShipCity = ddbRow.amazonShipCity;
  if (ddbRow.amazonShipState) mapped.amazonShipState = ddbRow.amazonShipState;
  if (ddbRow.amazonShipLocation) {
    mapped.amazonShipLocation = ddbRow.amazonShipLocation;
  } else {
    const loc = formatShipLocation(
      ddbRow.amazonShipCity,
      ddbRow.amazonShipState,
    );
    if (loc) mapped.amazonShipLocation = loc;
  }
  if (ddbRow.amazonMatchMethod) {
    mapped.amazonMatchMethod = ddbRow.amazonMatchMethod;
  }
  return mapped;
}

/**
 * Append item titles + delivery city/state to a display payee label.
 *   "AMAZON MKTPL*LR52S7I73" → "AMAZON MKTPL*LR52S7I73 — USB-C Cable · Portland, ME"
 */
function enhanceDisplayPayee(base, amazon) {
  if (!amazon) return base;
  const summary =
    amazon.amazonItemsSummary ||
    summarizeItems(amazon.amazonItems) ||
    null;
  const loc =
    amazon.amazonShipLocation ||
    formatShipLocation(amazon.amazonShipCity, amazon.amazonShipState) ||
    null;
  if (!summary && !loc) return base;
  const label = (base && String(base).trim()) || 'Amazon';
  const hasSummary = summary && label.includes(summary);
  const hasLoc = loc && label.includes(loc);
  if (hasSummary && (hasLoc || !loc)) return label;
  if (hasLoc && !summary) return label;
  // Already enhanced with items (re-render): append location only.
  if (/ — /.test(label) && /amazon/i.test(label)) {
    if (loc && !label.includes(loc)) return `${label} · ${loc}`;
    return label;
  }
  if (summary && loc) return `${label} — ${summary} · ${loc}`;
  if (summary) return `${label} — ${summary}`;
  return `${label} · ${loc}`;
}

async function getMeta(planId = ledgerPlanId) {
  const db = ddb();
  return (await db.getItem(db.planPk(planId), META_SK)) || null;
}

module.exports = {
  ORDER_SK_PREFIX,
  META_SK,
  orderSk,
  orderUrlFor,
  extractAmazonChargeRef,
  isAmazonRetailBlob,
  isAmazonRetailTxn,
  parseMoneyToMilli,
  summarizeItems,
  formatShipLocation,
  healShipCityState,
  normalizeIncomingOrder,
  listStoredOrders,
  upsertOrders,
  matchAndStampTransactions,
  attachAmazonFields,
  enhanceDisplayPayee,
  getMeta,
  matchOrderForTxn,
  txnChargeRef,
};
