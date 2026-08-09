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
  return `https://${host}/gp/your-account/order-details?orderID=${id}`;
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

function normalizeIncomingOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const orderNumber = String(
    raw.orderNumber || raw.order_id || raw.orderId || '',
  ).trim();
  if (!orderNumber) return null;
  const items = Array.isArray(raw.items)
    ? raw.items.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40)
    : [];
  const domain = raw.domain || raw.amazonDomain || 'www.amazon.com';
  const orderUrl =
    (raw.orderUrl || raw.order_url || '').trim() ||
    orderUrlFor(orderNumber, domain);
  const chargeRefs = Array.isArray(raw.chargeRefs || raw.paymentRefs)
    ? (raw.chargeRefs || raw.paymentRefs)
        .map((r) => String(r || '').trim().toUpperCase())
        .filter(Boolean)
    : [];
  // Also accept a single chargeRef on the order.
  if (raw.chargeRef) {
    chargeRefs.push(String(raw.chargeRef).trim().toUpperCase());
  }
  const grandTotalMilli =
    raw.grandTotalMilli != null
      ? Math.abs(Number(raw.grandTotalMilli))
      : parseMoneyToMilli(raw.grandTotal ?? raw.total ?? raw.amount);
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
 * Prefer charge-ref hit; else unique amount within date window.
 */
function matchOrderForTxn(t, orders, byRef) {
  const ref = txnChargeRef(t);
  if (ref && byRef.has(ref)) {
    const cands = byRef.get(ref);
    if (cands.length === 1) {
      return { order: cands[0], method: 'charge_ref' };
    }
    // Disambiguate by amount/date among ref hits.
    const amt = Math.abs(Number(t.amount ?? t.payload?.amount ?? 0));
    let best = null;
    let bestScore = Infinity;
    for (const o of cands) {
      const d = dateDiffDays(t.date || t.payload?.date, o.orderDate);
      const amountGap =
        o.grandTotalMilli != null ? Math.abs(o.grandTotalMilli - amt) : 5000;
      const score = d * 1000 + amountGap;
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (best) return { order: best, method: 'charge_ref' };
  }

  const amt = Math.abs(Number(t.amount ?? t.payload?.amount ?? 0));
  if (!amt) return null;
  const txnDate = t.date || t.payload?.date;
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
    // Same day + same amount: still attach if only one order (already filtered).
    // Multiple different orders same amount/day → skip.
    const nums = new Set(ties.map((t) => t.order.orderNumber));
    if (nums.size > 1) return null;
  }
  return { order: best.order, method: 'amount_date' };
}

function stampFieldsFromOrder(order, method) {
  return {
    amazonOrderNumber: order.orderNumber,
    amazonOrderUrl: order.orderUrl || orderUrlFor(order.orderNumber, order.domain),
    amazonItems: order.items || [],
    amazonItemsSummary:
      order.itemsSummary || summarizeItems(order.items) || null,
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
    // Skip write when already stamped with same order + items (unless force).
    if (
      !force &&
      raw.amazonOrderNumber === stamp.amazonOrderNumber &&
      raw.amazonOrderUrl === stamp.amazonOrderUrl &&
      raw.amazonItemsSummary === stamp.amazonItemsSummary
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
  if (ddbRow.amazonMatchMethod) {
    mapped.amazonMatchMethod = ddbRow.amazonMatchMethod;
  }
  return mapped;
}

/**
 * Append item titles to a display payee label.
 *   "AMAZON MKTPL*LR52S7I73" → "AMAZON MKTPL*LR52S7I73 — USB-C Cable, …"
 */
function enhanceDisplayPayee(base, amazon) {
  if (!amazon) return base;
  const summary =
    amazon.amazonItemsSummary ||
    summarizeItems(amazon.amazonItems) ||
    null;
  if (!summary) return base;
  const label = (base && String(base).trim()) || 'Amazon';
  if (label.includes(summary)) return label;
  // Avoid double-append on re-render.
  if (/ — /.test(label) && /amazon/i.test(label)) return label;
  return `${label} — ${summary}`;
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
