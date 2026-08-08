'use strict';

const crypto = require('crypto');
const ynab = require('./ynab');
const ddb = require('./ddb');
const { ledgerPlanId } = require('./config');
const { colorForCategory } = require('./categoryColors');
const { pickEnrichment } = require('./plaidEnrich');
const {
  parseImportPayeeName,
  resolveDisplayPayee,
} = require('./displayPayee');

/** Load existing category colors so re-import / delta never drifts user or assigned colors. */
async function loadCategoryColorMap(planId) {
  const cats = await ddb.queryPk(ddb.planPk(planId), 'CAT#');
  const map = new Map();
  for (const c of cats) {
    if (c.ynabId && c.color) map.set(c.ynabId, c.color);
  }
  return map;
}

/**
 * Categories soft-deleted in R2Finance (YNAB API has no documented DELETE for
 * categories). Survives YNAB full/delta rewrites until YNAB itself marks deleted.
 */
async function loadCategoryUserDeletedMap(planId) {
  const cats = await ddb.queryPk(ddb.planPk(planId), 'CAT#');
  const map = new Map();
  for (const c of cats) {
    const id = c.ynabId || String(c.sk || '').replace(/^CAT#/, '');
    if (id && c.userDeleted) map.set(id, true);
  }
  return map;
}

function isSystemCategoryGroupName(name) {
  const g = String(name || '')
    .trim()
    .toLowerCase();
  return (
    g === 'internal master category' ||
    g === 'credit card payments' ||
    g === 'hidden categories'
  );
}

function isSystemCategoryName(name) {
  const c = String(name || '')
    .trim()
    .toLowerCase();
  if (!c) return false;
  if (c === 'uncategorized') return true;
  if (c.includes('ready to assign')) return true;
  return false;
}

function mapCategory(c) {
  return {
    ynabId: c.ynabId,
    name: c.name,
    categoryGroupId: c.categoryGroupId ?? null,
    hidden: c.hidden ?? false,
    color: c.color || null,
    deleted: !!c.deleted,
  };
}

async function resolveYnabPlanId() {
  const meta = await ddb.getItem(ddb.planPk(), 'META');
  const id = meta?.ynabPlanId || meta?.payload?.ynabPlanId;
  if (!id) {
    const err = new Error('no ynabPlanId — run full import first');
    err.status = 400;
    throw err;
  }
  return id;
}

/**
 * Extra fields for CAT# upsert from YNAB pull, preserving color + userDeleted.
 */
function categoryPullExtra(c, groupId, colorMap, userDeletedMap) {
  const base = categoryColorExtra(c, groupId, colorMap);
  const userDeleted = !c.deleted && userDeletedMap.has(c.id);
  if (userDeleted) {
    return {
      ...base,
      deleted: true,
      userDeleted: true,
      hidden: true,
    };
  }
  if (c.deleted) {
    return { ...base, deleted: true, userDeleted: false };
  }
  return { ...base, userDeleted: false };
}

/**
 * Account nicknames (aliases) live on ACCT# and must survive YNAB full/delta
 * rewrites — same pattern as category colors.
 *
 * YNAB has no separate "alias" field — only account `name` (GET /plans/…/accounts).
 * R2 pre-seeds `alias` from that name; once the user saves a custom nickname
 * (`aliasUserSet`), we keep their value and never overwrite from YNAB.
 *
 * Map value: { alias: string|null, userSet: boolean }
 */
function isAliasUserSet(row) {
  if (!row) return false;
  if (row.aliasUserSet === true) return true;
  if (row.aliasUserSet === false) return false;
  // Legacy rows (before aliasUserSet): any stored alias counts as user-set
  // so we never clobber nicknames that were already saved.
  return !!(row.alias && String(row.alias).trim());
}

async function loadAccountAliasMap(planId) {
  const accts = await ddb.queryPk(ddb.planPk(planId), 'ACCT#');
  const map = new Map();
  for (const a of accts) {
    const id = a.ynabId || String(a.sk || '').replace(/^ACCT#/, '');
    if (!id) continue;
    const alias =
      a.alias != null && String(a.alias).trim()
        ? String(a.alias).trim()
        : null;
    map.set(id, { alias, userSet: isAliasUserSet(a) });
  }
  return map;
}

/**
 * Resolve R2 alias for a YNAB account row during pull.
 * - User-set nickname → keep as-is (independent of YNAB renames).
 * - Otherwise → seed/mirror from YNAB account name.
 * Pure; exported for unit tests.
 */
function resolveAccountAliasForPull(ynabAccount, aliasEntry) {
  const ynabName = String(ynabAccount?.name || '').trim().slice(0, 80) || null;
  if (aliasEntry?.userSet) {
    return {
      alias: aliasEntry.alias || null,
      aliasUserSet: true,
    };
  }
  return {
    alias: ynabName,
    aliasUserSet: false,
  };
}

/** Last-4 from YNAB account name (often ends with card/account digits). */
function extractAccountMask(name) {
  const m = String(name || '').match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

function accountExtra(a, aliasMap) {
  const resolved = resolveAccountAliasForPull(a, aliasMap.get(a.id));
  const extra = {
    name: a.name,
    type: a.type,
    onBudget: a.on_budget,
    balance: a.balance,
    closed: a.closed,
    deleted: !!a.deleted,
    aliasUserSet: resolved.aliasUserSet,
  };
  if (resolved.alias) extra.alias = resolved.alias;
  return extra;
}

function mapAccount(i) {
  const name = i.name || i.payload?.name || '';
  const alias =
    i.alias != null && String(i.alias).trim()
      ? String(i.alias).trim()
      : null;
  return {
    ynabId: i.ynabId,
    name,
    type: i.type || i.payload?.type || 'checking',
    balance: i.balance ?? i.payload?.balance ?? 0,
    onBudget: i.onBudget ?? i.payload?.on_budget ?? true,
    closed: !!(i.closed ?? i.payload?.closed ?? false),
    note: i.payload?.note ?? null,
    transferPayeeId: i.payload?.transfer_payee_id ?? null,
    /**
     * Display nickname (R2Finance-only). Seeded from YNAB account name until
     * the user saves a custom value (aliasUserSet).
     */
    alias: alias || null,
    /** true when the user saved a custom nickname (do not overwrite from YNAB). */
    aliasUserSet: isAliasUserSet(i) && !!alias,
    /** Last-4 digits when present in the YNAB account name. */
    mask: extractAccountMask(name),
    deleted: !!i.deleted,
    updatedAt: i.updatedAt || 0,
  };
}

function categoryColorExtra(c, groupId, colorMap) {
  const color = colorForCategory({
    name: c.name,
    ynabId: c.id,
    existingColor: colorMap.get(c.id),
  });
  return {
    name: c.name,
    categoryGroupId: c.category_group_id || groupId,
    hidden: c.hidden,
    deleted: !!c.deleted,
    color,
  };
}

function uuid() {
  return crypto.randomUUID();
}

function entityItem({
  planId,
  sk,
  entityType,
  ynabId,
  payload,
  syncStatus = 'SYNCED',
  extra = {},
}) {
  const now = Date.now();
  const item = {
    pk: ddb.planPk(planId),
    sk,
    entityType,
    ynabId: ynabId || undefined,
    syncStatus,
    updatedAt: now,
    payload,
    ...extra,
  };
  if (syncStatus === 'PENDING_PUSH') {
    item.gsi2pk = 'PENDING_PUSH';
    item.gsi2sk = `${String(now).padStart(15, '0')}#${sk}`;
  }
  return item;
}

/**
 * Soft-delete a YNAB transaction row in DDB (match counterpart or true delete).
 * When YNAB matches an import to a user/transfer txn, the import id vanishes
 * from the live list (404) while the survivor keeps matched_transaction_id.
 * Without this tombstone, inbox double-counts both sides.
 */
function tombstoneTxnItem(planId, ynabId, accountId, reason = 'matched_or_missing') {
  if (!ynabId) return null;
  return entityItem({
    planId,
    sk: `TXN#${ynabId}`,
    entityType: 'transaction',
    ynabId,
    payload: {
      id: ynabId,
      deleted: true,
      account_id: accountId || null,
      _tombstone: reason,
    },
    extra: {
      deleted: true,
      approved: true,
      accountId: accountId || undefined,
    },
  });
}

/**
 * For each YNAB txn that references a match, tombstone the counterpart id.
 *
 * Normal case: matched import id is gone from YNAB (404) → soft-delete in DDB.
 * YNAB bug case: both the transfer AND the bank-import stay live with
 * matched_transaction_id set → hide the non-transfer import (Category Needed
 * third row) and auto-approve it if still unapproved.
 *
 * @param {string} planId
 * @param {Array<{id:string, matched_transaction_id?:string|null, account_id?:string, deleted?:boolean, transfer_account_id?:string|null, approved?:boolean, amount?:number, date?:string}>} transactions
 * @param {Set<string>} [pendingSk] TXN#… keys to leave alone (local PENDING_PUSH)
 * @returns {object[]} DDB put items
 */
function matchedCounterpartTombstones(planId, transactions, pendingSk = new Set()) {
  const out = [];
  const seen = new Set();
  const live = (transactions || []).filter((t) => t && t.id && !t.deleted);
  const byId = new Map(live.map((t) => [t.id, t]));

  for (const t of live) {
    const mid = t.matched_transaction_id;
    if (!mid || mid === t.id) continue;
    const sk = `TXN#${mid}`;
    if (pendingSk.has(sk) || seen.has(mid)) continue;

    const other = byId.get(mid);
    if (other) {
      // Both live — only hide a non-transfer bank import (the classic YNAB
      // "Category Needed" third row next to a real transfer pair).
      if (other.transfer_account_id) continue;
      seen.add(mid);
      const item = ghostTombstoneFromYnab(planId, other, t.id);
      if (item) out.push(item);
      continue;
    }

    // Counterpart gone from YNAB live list — standard match absorb.
    seen.add(mid);
    const item = tombstoneTxnItem(planId, mid, t.account_id);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Soft-delete + auto-approve a YNAB-shaped ghost import row.
 * Used by matched-live and amount-based ghost detectors.
 */
function ghostTombstoneFromYnab(planId, g, ghostOfTransferId) {
  if (!g || !g.id) return null;
  const item = tombstoneTxnItem(
    planId,
    g.id,
    g.account_id || null,
    'ghost_transfer_import',
  );
  if (!item) return null;
  item.date = g.date;
  item.amount = g.amount;
  item.payload = {
    ...item.payload,
    date: g.date,
    amount: g.amount,
    payee_id: g.payee_id ?? null,
    category_id: g.category_id ?? null,
    import_id: g.import_id ?? null,
    approved: true,
    cleared: g.cleared || 'uncleared',
    memo: g.memo ?? null,
    payee_name: g.payee_name ?? null,
    import_payee_name: g.import_payee_name ?? null,
    _ghost_of_transfer_id: ghostOfTransferId || null,
  };
  if (g.approved === false) {
    const now = item.updatedAt || Date.now();
    const sk = `TXN#${g.id}`;
    item.syncStatus = 'PENDING_PUSH';
    item.gsi2pk = 'PENDING_PUSH';
    item.gsi2sk = `${String(now).padStart(15, '0')}#${sk}`;
  }
  return item;
}

/**
 * Auto-approve unapproved transfer legs when their linked counterpart exists.
 * YNAB often leaves one side of a transfer pair as "Needs approval" while the
 * other is already Approved — R2Finance treats the pair as complete.
 *
 * @param {string} planId
 * @param {Array<object>} transactions YNAB-shaped (full ledger merge ok)
 * @param {Set<string>} [pendingSk]
 * @param {Set<string>} [skipIds] already handled as ghosts
 * @returns {object[]} DDB put items marked PENDING_PUSH approved
 */
function autoApproveUnapprovedTransferLegs(
  planId,
  transactions,
  pendingSk = new Set(),
  skipIds = new Set(),
) {
  const live = (transactions || []).filter((t) => t && t.id && !t.deleted);
  const byId = new Map(live.map((t) => [t.id, t]));
  const out = [];
  const seen = new Set();

  for (const t of live) {
    if (!t.transfer_account_id) continue;
    if (t.approved !== false) continue;
    if (skipIds.has(t.id) || seen.has(t.id)) continue;
    const sk = `TXN#${t.id}`;
    if (pendingSk.has(sk)) continue;

    // Prefer linked pair; also approve lone transfers (no category needed).
    if (t.transfer_transaction_id) {
      const other = byId.get(t.transfer_transaction_id);
      if (!other || other.deleted) continue;
      if (other.amount !== -t.amount) continue;
    }

    seen.add(t.id);
    const now = Date.now();
    const payload = {
      ...t,
      approved: true,
    };
    out.push(
      entityItem({
        planId,
        sk,
        entityType: 'transaction',
        ynabId: t.id,
        payload,
        syncStatus: 'PENDING_PUSH',
        extra: {
          accountId: t.account_id,
          date: t.date,
          amount: t.amount,
          payeeId: t.payee_id,
          categoryId: t.category_id,
          approved: true,
          cleared: t.cleared,
          memo: t.memo,
          deleted: false,
          gsi2pk: 'PENDING_PUSH',
          gsi2sk: `${String(now).padStart(15, '0')}#${sk}`,
        },
      }),
    );
  }
  return out;
}

/** Absolute day difference between two ISO date strings (YYYY-MM-DD). */
function dateDiffDays(a, b) {
  if (!a || !b) return Infinity;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Infinity;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

/**
 * Map a DDB TXN row to the YNAB-shaped object ghost/match helpers expect.
 * Delta pull only returns changed rows — ghosts already in DDB must still
 * be visible to detection, so we merge ledger + delta via this shape.
 */
function ddbTxnToYnabShape(row) {
  if (!row) return null;
  const p = row.payload || {};
  const id =
    row.ynabId || p.id || String(row.sk || '').replace(/^TXN#/, '') || null;
  if (!id) return null;
  return {
    id,
    account_id: row.accountId || p.account_id || null,
    date: row.date || p.date || null,
    amount: row.amount ?? p.amount ?? null,
    approved: row.approved ?? p.approved,
    category_id: row.categoryId ?? p.category_id ?? null,
    transfer_account_id: p.transfer_account_id || null,
    transfer_transaction_id: p.transfer_transaction_id || null,
    deleted: !!(row.deleted || p.deleted),
    import_id: p.import_id || null,
    payee_id: row.payeeId ?? p.payee_id ?? null,
    payee_name: p.payee_name || null,
    import_payee_name: p.import_payee_name || null,
    cleared: row.cleared || p.cleared || null,
    memo: row.memo ?? p.memo ?? null,
  };
}

/**
 * Merge live DDB ledger + this-pull YNAB delta into one list for ghost
 * detection. Delta rows win (fresher YNAB state).
 *
 * @param {object[]} ddbRows
 * @param {object[]} ynabDelta
 * @returns {object[]}
 */
function mergeLedgerForGhostScan(ddbRows, ynabDelta) {
  const byId = new Map();
  for (const row of ddbRows || []) {
    const shaped = ddbTxnToYnabShape(row);
    if (shaped && shaped.id) byId.set(shaped.id, shaped);
  }
  for (const t of ynabDelta || []) {
    if (t && t.id) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * YNAB sometimes leaves a bank-import "Category Needed / Needs approval" row
 * on the source account *after* a real transfer pair already exists:
 *
 *   Checkin  −$711  Category Needed  (ghost import)
 *   Checkin  −$711  Transfer : Freedom  (real)
 *   Freedom  +$711  Transfer : Checkin  (real)
 *
 * A transfer pair is only two rows. The third is a YNAB import bug — hide it
 * in R2Finance (soft-delete) and auto-approve it so YNAB's needs-attention
 * queue stays consistent.
 *
 * Match rules (all required):
 * - ghost is live, not a transfer, same account + amount as a live transfer
 * - dates within ±1 day (bank lag)
 * - ghost is unapproved and/or uncategorized (needs-attention shape)
 * - transfer has transfer_account_id; when transfer_transaction_id is set,
 *   the other side must be live with opposite amount (real pair)
 *
 * @param {string} planId
 * @param {Array<object>} transactions YNAB-shaped txn list
 * @param {Set<string>} [pendingSk] TXN#… keys to leave alone
 * @returns {object[]} DDB put items (deleted + approved; PENDING_PUSH if unapproved)
 */
function ghostTransferImportTombstones(planId, transactions, pendingSk = new Set()) {
  const live = (transactions || []).filter((t) => t && t.id && !t.deleted);
  const byId = new Map(live.map((t) => [t.id, t]));

  /** @type {object[]} */
  const transfers = [];
  for (const t of live) {
    if (!t.transfer_account_id) continue;
    if (t.transfer_transaction_id) {
      const other = byId.get(t.transfer_transaction_id);
      if (!other || other.deleted) continue;
      if (other.amount !== -t.amount) continue;
    }
    transfers.push(t);
  }
  if (!transfers.length) return [];

  const out = [];
  const seen = new Set();
  for (const tr of transfers) {
    for (const g of live) {
      if (!g || !g.id || g.id === tr.id) continue;
      if (g.transfer_account_id) continue;
      if (g.account_id !== tr.account_id) continue;
      if (g.amount !== tr.amount) continue;
      if (dateDiffDays(g.date, tr.date) > 1) continue;
      // Only hide needs-attention-shaped imports (Category Needed / unapproved).
      // Leave alone a fully categorized+approved same-amount spend.
      const catMissing = g.category_id == null || g.category_id === '';
      if (g.approved && !catMissing) continue;
      if (seen.has(g.id)) continue;
      const sk = `TXN#${g.id}`;
      if (pendingSk.has(sk)) continue;
      seen.add(g.id);
      const item = ghostTombstoneFromYnab(planId, g, tr.id);
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * After a full YNAB snapshot, mark DDB TXN rows whose ynabId is no longer
 * in the live YNAB set as deleted. Skips PENDING_PUSH (device-originated).
 */
async function reconcileMissingYnabTxns(planId, liveYnabIds) {
  const existing = await ddb.queryPk(ddb.planPk(planId), 'TXN#');
  const items = [];
  for (const row of existing) {
    if (row.deleted) continue;
    if (row.syncStatus === 'PENDING_PUSH') continue;
    const id = row.ynabId || String(row.sk || '').replace(/^TXN#/, '');
    if (!id || liveYnabIds.has(id)) continue;
    items.push(tombstoneTxnItem(planId, id, row.accountId || row.payload?.account_id));
  }
  if (items.length) await ddb.batchWrite(items);
  return items.length;
}

/**
 * Full import (or re-import) of one YNAB plan into DynamoDB.
 */
async function fullImport({ sinceDate = '1990-01-01' } = {}) {
  const plans = await ynab.listPlans();
  if (!plans.length) throw new Error('No YNAB plans for this token');
  const ynabPlan = plans[0];
  const planId = ledgerPlanId;

  const accountsR = await ynab.listAccounts(ynabPlan.id);
  const categoriesR = await ynab.listCategories(ynabPlan.id);
  const payeesR = await ynab.listPayees(ynabPlan.id);
  const txnsR = await ynab.listTransactions(ynabPlan.id, { sinceDate });
  const schedR = await ynab.listScheduled(ynabPlan.id);

  const knowledge = Math.max(
    accountsR.serverKnowledge,
    categoriesR.serverKnowledge,
    payeesR.serverKnowledge,
    txnsR.serverKnowledge,
    schedR.serverKnowledge,
  );

  const items = [];

  items.push(
    entityItem({
      planId,
      sk: 'META',
      entityType: 'plan',
      ynabId: ynabPlan.id,
      payload: {
        name: ynabPlan.name,
        ynabPlanId: ynabPlan.id,
        currency: ynabPlan.currency_format?.iso_code || 'USD',
        firstMonth: ynabPlan.first_month,
        lastMonth: ynabPlan.last_month,
      },
      extra: {
        serverKnowledge: knowledge,
        ynabSyncEnabled: true,
        ynabPlanId: ynabPlan.id,
      },
    }),
  );

  items.push(
    entityItem({
      planId,
      sk: 'CURSOR#ynab',
      entityType: 'cursor',
      payload: {
        serverKnowledge: knowledge,
        lastFullImportAt: new Date().toISOString(),
        ynabPlanId: ynabPlan.id,
      },
      extra: { serverKnowledge: knowledge, ynabPlanId: ynabPlan.id },
    }),
  );

  const accountAliasMap = await loadAccountAliasMap(planId);
  for (const a of accountsR.accounts) {
    if (a.deleted) continue;
    items.push(
      entityItem({
        planId,
        sk: `ACCT#${a.id}`,
        entityType: 'account',
        ynabId: a.id,
        payload: a,
        extra: accountExtra(a, accountAliasMap),
      }),
    );
  }

  const categoryColorMap = await loadCategoryColorMap(planId);
  const categoryUserDeletedMap = await loadCategoryUserDeletedMap(planId);

  for (const g of categoriesR.categoryGroups) {
    if (g.deleted) continue;
    items.push(
      entityItem({
        planId,
        sk: `CGRP#${g.id}`,
        entityType: 'category_group',
        ynabId: g.id,
        payload: { id: g.id, name: g.name, hidden: g.hidden },
        extra: { name: g.name, hidden: g.hidden },
      }),
    );
    for (const c of g.categories || []) {
      if (c.deleted && !categoryUserDeletedMap.has(c.id)) continue;
      items.push(
        entityItem({
          planId,
          sk: `CAT#${c.id}`,
          entityType: 'category',
          ynabId: c.id,
          payload: c,
          extra: categoryPullExtra(
            c,
            g.id,
            categoryColorMap,
            categoryUserDeletedMap,
          ),
        }),
      );
    }
  }

  for (const p of payeesR.payees) {
    if (p.deleted) continue;
    items.push(
      entityItem({
        planId,
        sk: `PAYEE#${p.id}`,
        entityType: 'payee',
        ynabId: p.id,
        payload: p,
        extra: {
          name: p.name,
          transferAccountId: p.transfer_account_id || null,
        },
      }),
    );
  }

  // Preserve Plaid enrichment across full re-import.
  const existingTxns = await ddb.queryPk(ddb.planPk(planId), 'TXN#');
  const enrichBySk = new Map();
  for (const row of existingTxns) {
    const e = pickEnrichment(row);
    if (Object.keys(e).length) enrichBySk.set(row.sk, e);
  }

  // Hide YNAB's extra bank-import row when a real transfer pair already exists.
  // Written instead of the live row (same sk) so BatchWrite never double-puts.
  const ghostItems = ghostTransferImportTombstones(planId, txnsR.transactions);
  const ghostIds = new Set(ghostItems.map((i) => i.ynabId).filter(Boolean));

  for (const t of txnsR.transactions) {
    const sk = `TXN#${t.id}`;
    if (ghostIds.has(t.id)) continue;
    const kept = enrichBySk.get(sk) || {};
    if (t.deleted) {
      items.push(
        entityItem({
          planId,
          sk,
          entityType: 'transaction',
          ynabId: t.id,
          payload: t,
          extra: { deleted: true, accountId: t.account_id, ...kept },
        }),
      );
      continue;
    }
    items.push(
      entityItem({
        planId,
        sk,
        entityType: 'transaction',
        ynabId: t.id,
        payload: t,
        extra: {
          accountId: t.account_id,
          date: t.date,
          amount: t.amount,
          payeeId: t.payee_id,
          categoryId: t.category_id,
          approved: t.approved,
          cleared: t.cleared,
          memo: t.memo,
          deleted: false,
          ...kept,
        },
      }),
    );
  }

  // Matched imports: survivor stays; counterpart id is gone from YNAB — tombstone it.
  // Also hides still-live matched bank imports (YNAB triple-row bug).
  const matchedItems = matchedCounterpartTombstones(planId, txnsR.transactions);
  const matchedHideIds = new Set(
    matchedItems.map((i) => i.ynabId).filter(Boolean),
  );
  items.push(...matchedItems);
  // Ghost transfer imports: soft-delete + auto-approve (see ghostTransferImportTombstones).
  // Skip ids already hidden via matched_transaction_id (avoid double BatchWrite key).
  items.push(...ghostItems.filter((i) => !matchedHideIds.has(i.ynabId)));
  const hideIds = new Set([...ghostIds, ...matchedHideIds]);
  // One transfer leg often stays "Needs approval" — auto-approve for consistency.
  items.push(
    ...autoApproveUnapprovedTransferLegs(
      planId,
      txnsR.transactions,
      new Set(),
      hideIds,
    ),
  );

  for (const s of schedR.scheduled) {
    if (s.deleted) continue;
    items.push(
      entityItem({
        planId,
        sk: `SCHED#${s.id}`,
        entityType: 'scheduled',
        ynabId: s.id,
        payload: s,
      }),
    );
  }

  await ddb.batchWrite(items);

  // Safety net: any leftover DDB TXN with a ynabId not in this snapshot (e.g.
  // matched imports missed by delta) → soft-delete so inbox matches YNAB.
  const liveIds = new Set(
    txnsR.transactions.filter((t) => t && !t.deleted).map((t) => t.id),
  );
  const orphanedTombstoned = await reconcileMissingYnabTxns(planId, liveIds);

  let plaidEnrich = null;
  try {
    plaidEnrich = await require('./plaidEnrich').enrichAfterPull();
  } catch (e) {
    plaidEnrich = { error: e.message };
    console.warn('plaidEnrich after fullImport', e.message);
  }

  return {
    planName: ynabPlan.name,
    ynabPlanId: ynabPlan.id,
    ledgerPlanId: planId,
    counts: {
      accounts: accountsR.accounts.filter((a) => !a.deleted).length,
      categoryGroups: categoriesR.categoryGroups.filter((g) => !g.deleted).length,
      categories: categoriesR.categoryGroups.reduce(
        (n, g) => n + (g.categories || []).filter((c) => !c.deleted).length,
        0,
      ),
      payees: payeesR.payees.filter((p) => !p.deleted).length,
      transactions: txnsR.transactions.filter((t) => !t.deleted).length,
      scheduled: schedR.scheduled.filter((s) => !s.deleted).length,
      itemsWritten: items.length,
      orphanedTombstoned,
    },
    serverKnowledge: knowledge,
    plaidEnrich,
  };
}

/**
 * Incremental pull using last_knowledge_of_server.
 */
async function deltaPull() {
  const cursor = await ddb.getItem(ddb.planPk(), 'CURSOR#ynab');
  const meta = await ddb.getItem(ddb.planPk(), 'META');
  const ynabPlanId = cursor?.ynabPlanId || meta?.ynabPlanId || meta?.payload?.ynabPlanId;
  if (!ynabPlanId) {
    return { mode: 'full', ...(await fullImport()) };
  }

  const last = cursor?.serverKnowledge ?? 0;
  const planId = ledgerPlanId;
  const items = [];
  let knowledge = last;

  const accountsR = await ynab.listAccounts(ynabPlanId, last);
  knowledge = Math.max(knowledge, accountsR.serverKnowledge);
  const accountAliasMap = await loadAccountAliasMap(planId);
  for (const a of accountsR.accounts) {
    items.push(
      entityItem({
        planId,
        sk: `ACCT#${a.id}`,
        entityType: 'account',
        ynabId: a.id,
        payload: a,
        extra: accountExtra(a, accountAliasMap),
      }),
    );
  }

  const categoriesR = await ynab.listCategories(ynabPlanId, last);
  knowledge = Math.max(knowledge, categoriesR.serverKnowledge);
  const categoryColorMap = await loadCategoryColorMap(planId);
  const categoryUserDeletedMap = await loadCategoryUserDeletedMap(planId);
  for (const g of categoriesR.categoryGroups) {
    items.push(
      entityItem({
        planId,
        sk: `CGRP#${g.id}`,
        entityType: 'category_group',
        ynabId: g.id,
        payload: { id: g.id, name: g.name, hidden: g.hidden, deleted: g.deleted },
        extra: { name: g.name, hidden: g.hidden, deleted: !!g.deleted },
      }),
    );
    for (const c of g.categories || []) {
      items.push(
        entityItem({
          planId,
          sk: `CAT#${c.id}`,
          entityType: 'category',
          ynabId: c.id,
          payload: c,
          extra: categoryPullExtra(
            c,
            g.id,
            categoryColorMap,
            categoryUserDeletedMap,
          ),
        }),
      );
    }
  }

  const payeesR = await ynab.listPayees(ynabPlanId, last);
  knowledge = Math.max(knowledge, payeesR.serverKnowledge);
  for (const p of payeesR.payees) {
    items.push(
      entityItem({
        planId,
        sk: `PAYEE#${p.id}`,
        entityType: 'payee',
        ynabId: p.id,
        payload: p,
        extra: { name: p.name, deleted: !!p.deleted },
      }),
    );
  }

  // Transactions: since_date still required for list; use last year floor + knowledge
  const txnsR = await ynab.listTransactions(ynabPlanId, {
    sinceDate: '1990-01-01',
    lastKnowledge: last,
  });
  knowledge = Math.max(knowledge, txnsR.serverKnowledge);

  // Never clobber local categorize/approve that is waiting to push to YNAB.
  // Tick order is pull-then-push; without this, a PENDING_PUSH row would be
  // overwritten by the older YNAB snapshot and the push would no-op.
  const pendingSk = new Set();
  try {
    const pending = await ddb.queryPendingPush(200);
    for (const p of pending) {
      if (p.pk === ddb.planPk(planId) && String(p.sk || '').startsWith('TXN#')) {
        pendingSk.add(p.sk);
      }
    }
  } catch {
    // Best-effort; proceed without skip set.
  }

  // Preserve Plaid enrichment when YNAB overwrites the row.
  const existingForEnrich = await ddb.queryPk(ddb.planPk(planId), 'TXN#');
  const enrichBySk = new Map();
  for (const row of existingForEnrich) {
    const e = pickEnrichment(row);
    if (Object.keys(e).length) enrichBySk.set(row.sk, e);
  }

  // Ghost scan needs the full ledger: delta alone omits already-synced rows
  // (the Category Needed import may not appear in this knowledge window).
  const ghostScan = mergeLedgerForGhostScan(
    existingForEnrich,
    txnsR.transactions,
  );
  const ghostItems = ghostTransferImportTombstones(
    planId,
    ghostScan,
    pendingSk,
  );
  const ghostIds = new Set(ghostItems.map((i) => i.ynabId).filter(Boolean));

  let skippedPending = 0;
  let ghostHidden = 0;
  for (const t of txnsR.transactions) {
    const sk = `TXN#${t.id}`;
    if (pendingSk.has(sk)) {
      skippedPending += 1;
      continue;
    }
    if (ghostIds.has(t.id)) {
      ghostHidden += 1;
      continue;
    }
    const kept = enrichBySk.get(sk) || {};
    items.push(
      entityItem({
        planId,
        sk,
        entityType: 'transaction',
        ynabId: t.id,
        payload: t,
        extra: {
          accountId: t.account_id,
          date: t.date,
          amount: t.amount,
          payeeId: t.payee_id,
          categoryId: t.category_id,
          approved: t.approved,
          cleared: t.cleared,
          memo: t.memo,
          deleted: !!t.deleted,
          ...kept,
        },
      }),
    );
  }

  // When YNAB matches import ↔ manual/transfer, the import id disappears but
  // may never show up as deleted:true in a missed delta window. Tombstone the
  // counterpart referenced by matched_transaction_id so inbox stays aligned.
  // Also hides still-live matched bank imports (YNAB triple-row bug).
  const matchedItems = matchedCounterpartTombstones(
    planId,
    ghostScan,
    pendingSk,
  );
  const matchedHideIds = new Set(
    matchedItems.map((i) => i.ynabId).filter(Boolean),
  );
  items.push(...matchedItems);
  // Ghost transfer imports: soft-delete + auto-approve unapproved ones.
  // Includes ghosts only present in DDB (not in this delta batch).
  const uniqueGhosts = ghostItems.filter((i) => !matchedHideIds.has(i.ynabId));
  items.push(...uniqueGhosts);
  ghostHidden = uniqueGhosts.length + matchedHideIds.size;

  const hideIds = new Set([...ghostIds, ...matchedHideIds]);
  const transferApprovals = autoApproveUnapprovedTransferLegs(
    planId,
    ghostScan,
    pendingSk,
    hideIds,
  );
  items.push(...transferApprovals);

  const schedR = await ynab.listScheduled(ynabPlanId, last);
  knowledge = Math.max(knowledge, schedR.serverKnowledge);
  for (const s of schedR.scheduled) {
    items.push(
      entityItem({
        planId,
        sk: `SCHED#${s.id}`,
        entityType: 'scheduled',
        ynabId: s.id,
        payload: s,
        extra: { deleted: !!s.deleted },
      }),
    );
  }

  if (items.length) await ddb.batchWrite(items);

  await ddb.putItem(
    entityItem({
      planId,
      sk: 'CURSOR#ynab',
      entityType: 'cursor',
      payload: {
        serverKnowledge: knowledge,
        lastDeltaAt: new Date().toISOString(),
        ynabPlanId,
      },
      extra: { serverKnowledge: knowledge, ynabPlanId },
    }),
  );
  await ddb.putItem({
    ...(meta || {}),
    pk: ddb.planPk(planId),
    sk: 'META',
    serverKnowledge: knowledge,
    updatedAt: Date.now(),
  });

  let plaidEnrich = null;
  try {
    // Stamp new spends + inbox needs-attention with Plaid match/location.
    plaidEnrich = await require('./plaidEnrich').enrichAfterPull();
  } catch (e) {
    plaidEnrich = { error: e.message };
    console.warn('plaidEnrich after deltaPull', e.message);
  }

  return {
    mode: 'delta',
    ynabPlanId,
    previousKnowledge: last,
    serverKnowledge: knowledge,
    itemsUpserted: items.length,
    skippedPendingPush: skippedPending,
    ghostTransferImportsHidden: ghostHidden || ghostItems.length,
    transferLegsAutoApproved: transferApprovals.length,
    plaidEnrich,
  };
}

/**
 * Push PENDING_PUSH transactions (categorize / approve) to YNAB.
 */
async function pushPending({ limit = 40 } = {}) {
  const pending = await ddb.queryPendingPush(limit);
  const meta = await ddb.getItem(ddb.planPk(), 'META');
  const ynabPlanId = meta?.ynabPlanId || meta?.payload?.ynabPlanId;
  if (!ynabPlanId) {
    return { pushed: 0, skipped: pending.length, error: 'no ynabPlanId — run full import first' };
  }

  const results = [];
  for (const item of pending) {
    if (item.entityType !== 'transaction' && !String(item.sk || '').startsWith('TXN#')) {
      // Categories pending push (legacy offline path; website uses immediate dual-write)
      if (item.entityType === 'category' && item.syncStatus === 'PENDING_PUSH') {
        try {
          if (item.userDeleted || item.deleted) {
            try {
              if (item.ynabId) {
                await ynab.deleteCategory(ynabPlanId, item.ynabId);
              }
            } catch (delErr) {
              // YNAB may not support DELETE — keep soft-delete in DDB.
              console.warn('category delete push', delErr.message);
            }
            await ddb.markSynced(item.pk, item.sk, {
              deleted: true,
              userDeleted: true,
              hidden: true,
            });
            results.push({ sk: item.sk, ok: true, deleted: true });
            continue;
          }
          if (item.ynabId) {
            const patch = {
              name: item.name || item.payload?.name,
            };
            const groupId =
              item.categoryGroupId || item.payload?.category_group_id;
            if (groupId) patch.category_group_id = groupId;
            await ynab.updateCategory(ynabPlanId, item.ynabId, patch);
          } else if (item.payload?.category_group_id || item.categoryGroupId) {
            const created = await ynab.createCategory(ynabPlanId, {
              name: item.name || item.payload?.name,
              category_group_id:
                item.categoryGroupId || item.payload.category_group_id,
            });
            const newSk = `CAT#${created.id}`;
            const now = Date.now();
            await ddb.putItem({
              ...item,
              sk: newSk,
              ynabId: created.id,
              name: created.name || item.name,
              categoryGroupId:
                created.category_group_id ||
                item.categoryGroupId ||
                item.payload?.category_group_id,
              payload: created,
              syncStatus: 'SYNCED',
              updatedAt: now,
              lastPushedAt: now,
              gsi2pk: undefined,
              gsi2sk: undefined,
            });
            // Drop provisional row if sk was different (client-temp id)
            if (item.sk !== newSk) {
              await ddb.putItem({
                ...item,
                deleted: true,
                syncStatus: 'SYNCED',
                updatedAt: now,
                gsi2pk: undefined,
                gsi2sk: undefined,
              });
            }
            results.push({ sk: item.sk, ok: true, created: true, ynabId: created.id });
            continue;
          }
          await ddb.markSynced(item.pk, item.sk);
          results.push({ sk: item.sk, ok: true });
        } catch (e) {
          results.push({ sk: item.sk, ok: false, error: e.message });
        }
      }
      continue;
    }

    const payload = item.payload || {};
    const categoryId = item.categoryId !== undefined ? item.categoryId : payload.category_id;
    const approved = item.approved !== undefined ? item.approved : payload.approved;
    const memo = item.memo !== undefined ? item.memo : payload.memo;
    const cleared = item.cleared || payload.cleared;
    const accountId = item.accountId || payload.account_id;
    const date = item.date || payload.date;
    const amount = item.amount ?? payload.amount;
    const payeeId = item.payeeId ?? payload.payee_id ?? null;
    const payeeName = payload.payee_name || null;
    const needsCreate = item.deviceCreate || !item.ynabId;

    try {
      if (needsCreate) {
        // Device-originated txn not yet in YNAB.
        const created = await ynab.createTransaction(ynabPlanId, {
          account_id: accountId,
          date,
          amount,
          payee_id: payeeId,
          payee_name: !payeeId && payeeName ? payeeName : undefined,
          category_id: categoryId,
          memo: memo ?? null,
          cleared: cleared || 'uncleared',
          approved: approved !== false,
          import_id: payload.import_id || item.clientId || undefined,
        });
        const newYnabId = created.id || created.transaction?.id;
        const pushedAt = Date.now();
        await ddb.putItem({
          ...item,
          ynabId: newYnabId,
          deviceCreate: false,
          syncStatus: 'SYNCED',
          updatedAt: pushedAt,
          lastPushedAt: pushedAt,
          payload: {
            ...payload,
            id: newYnabId,
          },
          gsi2pk: undefined,
          gsi2sk: undefined,
        });
        // Clear GSI pending keys + stamp lastPushedAt
        await ddb.markSynced(item.pk, item.sk, {
          ynabId: newYnabId,
          deviceCreate: false,
          lastPushedAt: pushedAt,
        });
        results.push({ sk: item.sk, ok: true, created: true, ynabTxnId: newYnabId });
        continue;
      }

      const ynabTxnId = item.ynabId || item.sk.replace(/^TXN#/, '');
      await ynab.updateTransaction(ynabPlanId, ynabTxnId, {
        category_id: categoryId,
        approved: approved !== false,
        memo: memo ?? null,
        cleared: cleared || 'uncleared',
        account_id: accountId,
        date,
        amount,
        payee_id: payeeId,
      });
      await ddb.markSynced(item.pk, item.sk);
      results.push({ sk: item.sk, ok: true, ynabTxnId, updated: true });
    } catch (e) {
      results.push({ sk: item.sk, ok: false, error: e.message, status: e.status });
    }
  }

  // Pending payees (device-created names) — create in YNAB when possible
  for (const item of pending) {
    if (item.entityType !== 'payee' && !String(item.sk || '').startsWith('PAYEE#')) continue;
    if (!item.deviceCreate && item.ynabId) continue;
    if (item.syncStatus !== 'PENDING_PUSH' && item.gsi2pk !== 'PENDING_PUSH') continue;
    try {
      const name = item.name || item.payload?.name;
      if (!name) continue;
      const created = await ynab.createPayee(ynabPlanId, name);
      await ddb.markSynced(item.pk, item.sk, {
        ynabId: created.id,
        deviceCreate: false,
      });
      results.push({ sk: item.sk, ok: true, created: true, payeeId: created.id });
    } catch (e) {
      results.push({ sk: item.sk, ok: false, error: e.message, status: e.status });
    }
  }

  return {
    pushed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * API helper: categorize a transaction in DDB and mark pending push.
 */
async function categorizeTransaction({ ynabTxnId, categoryYnabId, approved = true }) {
  const planId = ledgerPlanId;
  const sk = `TXN#${ynabTxnId}`;
  const existing = await ddb.getItem(ddb.planPk(planId), sk);
  if (!existing) throw new Error(`transaction ${ynabTxnId} not in DDB — pull first`);
  const payload = {
    ...(existing.payload || {}),
    category_id: categoryYnabId,
    approved,
  };
  const now = Date.now();
  await ddb.putItem({
    ...existing,
    categoryId: categoryYnabId,
    approved,
    payload,
    syncStatus: 'PENDING_PUSH',
    updatedAt: now,
    gsi2pk: 'PENDING_PUSH',
    gsi2sk: `${String(now).padStart(15, '0')}#${ynabTxnId}`,
  });
  return { ok: true, ynabTxnId, categoryYnabId, approved };
}

/**
 * Approve a transaction in DDB and mark pending push to YNAB.
 */
async function approveTransaction({ ynabTxnId }) {
  const planId = ledgerPlanId;
  const sk = `TXN#${ynabTxnId}`;
  const existing = await ddb.getItem(ddb.planPk(planId), sk);
  if (!existing) throw new Error(`transaction ${ynabTxnId} not in DDB — pull first`);
  const payload = {
    ...(existing.payload || {}),
    approved: true,
  };
  const now = Date.now();
  await ddb.putItem({
    ...existing,
    approved: true,
    payload,
    syncStatus: 'PENDING_PUSH',
    updatedAt: now,
    gsi2pk: 'PENDING_PUSH',
    gsi2sk: `${String(now).padStart(15, '0')}#${ynabTxnId}`,
  });
  return { ok: true, ynabTxnId, approved: true };
}

/**
 * Map a DDB transaction row to the public API shape.
 * `id` is the stable client key (device clientId or YNAB id) — never changes after create.
 * `ynabId` is the real YNAB id once known (null for device-only until push).
 *
 * Optional fields that are null/empty are omitted so full snapshots stay under
 * the Lambda 6MB response limit (~7k+ txns with Plaid enrich fields).
 */
function mapTxn(t) {
  const p = t.payload || {};
  const skId = String(t.sk || '').replace(/^TXN#/, '') || null;
  const clientId = t.clientId || p.client_id || null;
  const ynabId = t.ynabId || p.id || null;
  const stableId = clientId || ynabId || skId;
  const enrich = pickEnrichment(t);
  const out = {
    id: stableId,
    ynabId: ynabId || stableId,
    accountId: t.accountId || p.account_id,
    date: t.date || p.date,
    amount: t.amount ?? p.amount,
    cleared: t.cleared || p.cleared || 'uncleared',
    approved: t.approved ?? p.approved ?? true,
    deleted: !!(t.deleted || p.deleted),
    updatedAt: t.updatedAt || 0,
  };
  // Sync bridge metadata (outbound to YNAB).
  if (t.syncStatus) out.syncStatus = t.syncStatus;
  if (t.lastPushedAt) out.lastPushedAt = t.lastPushedAt;
  // Optional scalars — omit null/empty to shrink JSON.
  if (clientId) out.clientId = clientId;
  const payeeId = t.payeeId ?? p.payee_id ?? null;
  if (payeeId) out.payeeId = payeeId;
  const categoryId = t.categoryId ?? p.category_id ?? null;
  if (categoryId) out.categoryId = categoryId;
  const memo = t.memo ?? p.memo ?? null;
  if (memo) out.memo = memo;
  if (p.flag_color) out.flagColor = p.flag_color;
  if (p.transfer_account_id) out.transferAccountId = p.transfer_account_id;
  if (p.transfer_transaction_id) {
    out.transferTransactionId = p.transfer_transaction_id;
  }
  const importId = p.import_id || clientId || null;
  if (importId) out.importId = importId;
  // Bank import payee (parsed; never raw YNAB match-suggestion JSON)
  const importPayeeName = parseImportPayeeName(p.import_payee_name);
  if (importPayeeName) out.importPayeeName = importPayeeName;
  // Plaid match + location (optional; stamped by plaidEnrich)
  if (enrich.plaidTransactionId) out.plaidTransactionId = enrich.plaidTransactionId;
  if (enrich.plaidMerchantName) out.plaidMerchantName = enrich.plaidMerchantName;
  if (enrich.plaidMerchantEntityId) {
    out.plaidMerchantEntityId = enrich.plaidMerchantEntityId;
  }
  if (enrich.plaidPaymentChannel) {
    out.plaidPaymentChannel = enrich.plaidPaymentChannel;
  }
  if (enrich.plaidPfc) out.plaidPfc = enrich.plaidPfc;
  if (enrich.matchTier) out.matchTier = enrich.matchTier;
  if (enrich.matchConfidence != null) out.matchConfidence = enrich.matchConfidence;
  if (enrich.location) out.location = enrich.location;
  if (enrich.locationSource) out.locationSource = enrich.locationSource;
  if (enrich.locationConfidence != null) {
    out.locationConfidence = enrich.locationConfidence;
  }
  if (enrich.locationDisplay) out.locationDisplay = enrich.locationDisplay;
  if (enrich.enrichedAt) out.enrichedAt = enrich.enrichedAt;
  const subs = (p.subtransactions || [])
    .map((s) => {
      const sub = { amount: s.amount };
      if (s.id) sub.ynabId = s.id;
      if (s.payee_id) sub.payeeId = s.payee_id;
      if (s.category_id) sub.categoryId = s.category_id;
      if (s.memo) sub.memo = s.memo;
      if (s.transfer_account_id) sub.transferAccountId = s.transfer_account_id;
      return sub;
    })
    .filter((s) => s.amount != null);
  if (subs.length) out.subtransactions = subs;
  return out;
}

/** Default page size for full snapshots — keeps each response well under 6MB. */
const DEFAULT_TXN_PAGE = 2500;
/** Hard ceiling so a malicious/huge limit cannot blow the Lambda response. */
const MAX_TXN_PAGE = 4000;

/**
 * Local-first client sync: full snapshot or incremental changes since cursor.
 *
 * Query: GET /v1/sync/changes?since=<epoch_ms>&full=0|1&txnOffset=0&txnLimit=2500
 *
 * - No since / since=0 / full=1 → mode "full" (live rows only; no tombstones)
 * - since>0 → mode "delta" (rows with updatedAt > since, including deleted:true)
 * - Transactions are paged (`txnOffset` / `txnLimit`). Meta entities (accounts,
 *   groups, categories, payees, plan) are only included on the first page
 *   (`txnOffset=0`) so follow-up pages stay small.
 * - When `hasMore` is true, clients must request `nextTxnOffset` until done
 *   before advancing their local cursor.
 *
 * Clients store `cursor` (serverTime) and pass it as the next `since`.
 * HTTP payload stays small on day-to-day opens; occasional full resync heals drift.
 *
 * @param {{
 *   since?: number|string,
 *   full?: boolean|string|number,
 *   txnOffset?: number|string,
 *   txnLimit?: number|string,
 * }} [opts]
 */
async function listChanges(opts = {}) {
  const serverTime = Date.now();
  const sinceMs = Math.max(0, Number(opts.since) || 0);
  const forceFull =
    opts.full === true ||
    opts.full === 1 ||
    opts.full === '1' ||
    opts.full === 'true';
  const mode = forceFull || !sinceMs ? 'full' : 'delta';
  const planId = ledgerPlanId;
  const txnOffset = Math.max(0, Math.floor(Number(opts.txnOffset) || 0));
  let txnLimit = Math.floor(Number(opts.txnLimit) || 0);
  if (!txnLimit || txnLimit < 1) {
    // Full dumps always page; delta defaults high but still capped.
    txnLimit = mode === 'full' ? DEFAULT_TXN_PAGE : MAX_TXN_PAGE;
  }
  txnLimit = Math.min(MAX_TXN_PAGE, Math.max(1, txnLimit));
  const includeMeta = txnOffset === 0;

  const [meta, accts, groups, cats, payees, txns] = await Promise.all([
    includeMeta ? ddb.getItem(ddb.planPk(planId), 'META') : Promise.resolve(null),
    includeMeta ? ddb.queryPk(ddb.planPk(planId), 'ACCT#') : Promise.resolve([]),
    includeMeta ? ddb.queryPk(ddb.planPk(planId), 'CGRP#') : Promise.resolve([]),
    includeMeta ? ddb.queryPk(ddb.planPk(planId), 'CAT#') : Promise.resolve([]),
    includeMeta ? ddb.queryPk(ddb.planPk(planId), 'PAYEE#') : Promise.resolve([]),
    ddb.queryPk(ddb.planPk(planId), 'TXN#'),
  ]);

  const plan = includeMeta
    ? {
        name: meta?.payload?.name || meta?.name || 'Plan',
        ynabPlanId: meta?.ynabPlanId || meta?.payload?.ynabPlanId,
        currency: meta?.payload?.currency || 'USD',
        serverKnowledge: meta?.serverKnowledge ?? 0,
      }
    : null;

  const isChanged = (row) => {
    if (mode === 'full') return true;
    return (Number(row.updatedAt) || 0) > sinceMs;
  };

  let accounts = [];
  let groupsOut = [];
  let categories = [];
  let payeesOut = [];

  if (includeMeta) {
    accounts = accts
      .filter(isChanged)
      .filter((a) => (mode === 'full' ? !a.deleted && !a.closed : true))
      .map((i) => mapAccount(i));

    groupsOut = groups
      .filter(isChanged)
      .filter((g) => (mode === 'full' ? !g.deleted : true))
      .map((g) => ({
        ynabId: g.ynabId,
        name: g.name,
        hidden: g.hidden ?? false,
        deleted: !!g.deleted,
        updatedAt: g.updatedAt || 0,
      }));

    categories = cats
      .filter(isChanged)
      .filter((c) => (mode === 'full' ? !c.deleted : true))
      .map((c) => {
        let color = c.color;
        if (!color) {
          color = colorForCategory({ name: c.name, ynabId: c.ynabId });
        }
        return {
          ynabId: c.ynabId,
          name: c.name,
          categoryGroupId: c.categoryGroupId,
          hidden: c.hidden ?? false,
          color,
          deleted: !!c.deleted,
          updatedAt: c.updatedAt || 0,
        };
      });

    payeesOut = payees
      .filter(isChanged)
      .filter((p) => (mode === 'full' ? !p.deleted : true))
      .map((p) => ({
        ynabId: p.ynabId,
        name: p.name,
        transferAccountId:
          p.transferAccountId ?? p.payload?.transfer_account_id ?? null,
        deleted: !!p.deleted,
        updatedAt: p.updatedAt || 0,
      }));
  }

  // Stable sort so pages never re-shuffle between requests.
  const filteredTxns = txns
    .filter(isChanged)
    .filter((t) => (mode === 'full' ? !t.deleted : true))
    .sort((a, b) => {
      const ka = String(a.sk || a.ynabId || a.clientId || '');
      const kb = String(b.sk || b.ynabId || b.clientId || '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const txnTotal = filteredTxns.length;
  const pageRows = filteredTxns.slice(txnOffset, txnOffset + txnLimit);
  const transactions = pageRows.map((t) => mapTxn(t));
  const nextTxnOffset = txnOffset + transactions.length;
  const hasMore = nextTxnOffset < txnTotal;

  return {
    mode,
    serverTime,
    // Only advance client cursor once the full page set is consumed.
    cursor: hasMore ? sinceMs : serverTime,
    since: sinceMs,
    plan,
    accounts,
    groups: groupsOut,
    categories,
    payees: payeesOut,
    transactions,
    hasMore,
    txnOffset,
    nextTxnOffset,
    txnLimit,
    txnTotal,
    counts: {
      accounts: accounts.length,
      groups: groupsOut.length,
      categories: categories.length,
      payees: payeesOut.length,
      transactions: transactions.length,
      txnTotal,
    },
  };
}

/**
 * Phone → DDB write path (offline-first).
 * Lands local PENDING_PUSH rows into DynamoDB; YNAB push happens later via
 * pushPending / EventBridge — not required for this call to succeed.
 *
 * Body:
 * {
 *   payees: [{ clientId, name, ynabId? }],
 *   transactions: [{ clientId, ynabId?, accountId, date, amount, payeeId?,
 *                    categoryId?, memo?, cleared?, approved?, deleted?,
 *                    payeeName?, updatedAt? }]
 * }
 */
async function devicePush(body = {}) {
  const planId = ledgerPlanId;
  const now = Date.now();
  const payeesIn = Array.isArray(body.payees) ? body.payees : [];
  const txnsIn = Array.isArray(body.transactions) ? body.transactions : [];
  const results = { payees: [], transactions: [] };

  for (const p of payeesIn) {
    const clientId = p.clientId || p.id || uuid();
    const ynabId = p.ynabId || null;
    const name = (p.name || '').trim();
    if (!name) {
      results.payees.push({ clientId, ok: false, error: 'name required' });
      continue;
    }
    const sk = ynabId ? `PAYEE#${ynabId}` : `PAYEE#${clientId}`;
    const existing = await ddb.getItem(ddb.planPk(planId), sk);
    const item = {
      pk: ddb.planPk(planId),
      sk,
      entityType: 'payee',
      clientId,
      ynabId: ynabId || existing?.ynabId || undefined,
      name,
      payload: {
        ...(existing?.payload || {}),
        id: ynabId || existing?.ynabId || clientId,
        name,
        client_id: clientId,
      },
      syncStatus: ynabId ? 'SYNCED' : 'PENDING_PUSH',
      updatedAt: p.updatedAt || now,
      deleted: !!p.deleted,
    };
    if (!ynabId && !item.ynabId) {
      item.gsi2pk = 'PENDING_PUSH';
      item.gsi2sk = `${String(item.updatedAt).padStart(15, '0')}#${sk}`;
      item.deviceCreate = true;
    }
    await ddb.putItem(item);
    results.payees.push({ clientId, ok: true, sk, ynabId: item.ynabId || null });
  }

  for (const t of txnsIn) {
    const clientId = t.clientId || t.id || uuid();
    const ynabId = t.ynabId && t.ynabId !== clientId ? t.ynabId : null;
    const accountId = t.accountId;
    if (!accountId || !t.date || t.amount == null) {
      results.transactions.push({
        clientId,
        ok: false,
        error: 'accountId, date, amount required',
      });
      continue;
    }
    // Prefer existing YNAB row; else stable client key so offline create survives.
    const sk = ynabId ? `TXN#${ynabId}` : `TXN#${clientId}`;
    const existing = await ddb.getItem(ddb.planPk(planId), sk);
    // Also try lookup by ynabId when client sent both
    let base = existing;
    if (!base && ynabId) {
      base = await ddb.getItem(ddb.planPk(planId), `TXN#${ynabId}`);
    }
    if (!base && clientId) {
      base = await ddb.getItem(ddb.planPk(planId), `TXN#${clientId}`);
    }

    const isCreate = !base?.ynabId && !ynabId;
    const payload = {
      ...(base?.payload || {}),
      id: ynabId || base?.ynabId || clientId,
      account_id: accountId,
      date: t.date,
      amount: t.amount,
      payee_id: t.payeeId ?? base?.payeeId ?? null,
      category_id: t.categoryId ?? base?.categoryId ?? null,
      memo: t.memo ?? base?.memo ?? null,
      cleared: t.cleared || base?.cleared || 'uncleared',
      approved: t.approved !== false,
      deleted: !!t.deleted,
      client_id: clientId,
      import_id: t.importId || clientId,
      payee_name: t.payeeName || undefined,
    };
    const updatedAt = t.updatedAt || now;
    const item = {
      pk: ddb.planPk(planId),
      sk: base?.sk || sk,
      entityType: 'transaction',
      clientId,
      ynabId: ynabId || base?.ynabId || undefined,
      accountId,
      date: t.date,
      amount: t.amount,
      payeeId: payload.payee_id,
      categoryId: payload.category_id,
      memo: payload.memo,
      cleared: payload.cleared,
      approved: payload.approved,
      deleted: payload.deleted,
      payload,
      syncStatus: 'PENDING_PUSH',
      updatedAt,
      gsi2pk: 'PENDING_PUSH',
      gsi2sk: `${String(updatedAt).padStart(15, '0')}#${base?.sk || sk}`,
      deviceCreate: isCreate || !!base?.deviceCreate,
      // Keep Plaid location / match when phone re-saves categorize offline.
      ...pickEnrichment(base),
    };
    await ddb.putItem(item);
    results.transactions.push({
      clientId,
      ok: true,
      sk: item.sk,
      ynabId: item.ynabId || null,
      deviceCreate: !!item.deviceCreate,
    });
  }

  return {
    ok: true,
    accepted: {
      payees: results.payees.filter((r) => r.ok).length,
      transactions: results.transactions.filter((r) => r.ok).length,
    },
    failed: {
      payees: results.payees.filter((r) => !r.ok).length,
      transactions: results.transactions.filter((r) => !r.ok).length,
    },
    results,
  };
}

/**
 * Needs-attention inbox (YNAB-style Spending):
 * - unapproved (always, including transfers)
 * - on-budget uncategorized (no transfer, no splits)
 * Approve without a category removes unapproved rows; uncategorized-approved stay until categorized.
 */
async function listInbox() {
  const planId = ledgerPlanId;
  const [txns, accounts, payees, categories] = await Promise.all([
    ddb.queryPk(ddb.planPk(planId), 'TXN#'),
    ddb.queryPk(ddb.planPk(planId), 'ACCT#'),
    ddb.queryPk(ddb.planPk(planId), 'PAYEE#'),
    ddb.queryPk(ddb.planPk(planId), 'CAT#'),
  ]);

  const acctById = new Map();
  for (const a of accounts) {
    if (a.deleted || a.closed) continue;
    const id = a.ynabId || String(a.sk || '').replace(/^ACCT#/, '');
    acctById.set(id, a);
  }

  const payeeById = new Map();
  for (const p of payees) {
    if (p.deleted) continue;
    const id = p.ynabId || String(p.sk || '').replace(/^PAYEE#/, '');
    payeeById.set(id, p);
  }

  const uncategorizedIds = new Set();
  for (const c of categories) {
    if (c.deleted) continue;
    const name = (c.name || c.payload?.name || '').toLowerCase();
    if (name === 'uncategorized') {
      const id = c.ynabId || String(c.sk || '').replace(/^CAT#/, '');
      if (id) uncategorizedIds.add(id);
    }
  }

  const out = [];
  let unapproved = 0;
  let uncategorized = 0;
  for (const raw of txns) {
    if (raw.deleted) continue;
    const t = mapTxn(raw);
    if (!t.ynabId || !t.accountId) continue;
    const acct = acctById.get(t.accountId);
    if (!acct) continue;

    const approved = t.approved !== false;
    const onBudget = !!(acct.onBudget ?? acct.payload?.on_budget ?? true);
    const isTransfer = !!t.transferAccountId;
    const hasSubs = Array.isArray(t.subtransactions) && t.subtransactions.length > 0;
    const catMissing = !t.categoryId || uncategorizedIds.has(t.categoryId);
    const isUncategorized =
      approved && onBudget && !isTransfer && !hasSubs && catMissing;

    if (approved && !isUncategorized) continue;

    const reason = !approved ? 'unapproved' : 'uncategorized';
    if (!approved) unapproved += 1;
    else uncategorized += 1;

    const payee = t.payeeId ? payeeById.get(t.payeeId) : null;
    const transferAcct = t.transferAccountId
      ? acctById.get(t.transferAccountId)
      : null;
    const namedPayee = payee?.name || payee?.payload?.name || null;
    const transferYnabName =
      transferAcct?.name || transferAcct?.payload?.name || null;
    const transferAlias = transferAcct?.alias
      ? String(transferAcct.alias).trim()
      : '';
    const ynabName = acct.name || acct.payload?.name || null;
    const alias = acct.alias ? String(acct.alias).trim() : '';
    // Prefer aliases in transfer labels so categorization reads nicknames.
    const accountsForPayee = [...acctById.values()].map((a) => ({
      ...a,
      name: (a.alias && String(a.alias).trim()) || a.name || a.payload?.name,
    }));
    const displayPayee = resolveDisplayPayee({
      payeeName: namedPayee,
      transferAccountName: transferAlias || transferYnabName,
      plaidMerchantName: t.plaidMerchantName || null,
      plaidPfc: t.plaidPfc || null,
      importPayeeName: t.importPayeeName || null,
      accounts: accountsForPayee,
    });
    out.push({
      ...t,
      accountName: alias || ynabName,
      accountAlias: alias || null,
      accountMask: extractAccountMask(ynabName),
      payeeName: displayPayee || namedPayee || null,
      reason,
      onBudget,
    });
  }

  out.sort((a, b) => {
    if (a.date === b.date) return (b.amount || 0) - (a.amount || 0);
    return a.date < b.date ? 1 : -1;
  });

  return {
    count: out.length,
    unapproved,
    uncategorized,
    transactions: out,
  };
}

async function stats() {
  const all = await ddb.queryPk(ddb.planPk());
  const byType = {};
  for (const i of all) {
    const t = i.entityType || i.sk.split('#')[0];
    byType[t] = (byType[t] || 0) + 1;
  }
  const meta = all.find((i) => i.sk === 'META');
  const cursor = all.find((i) => i.sk === 'CURSOR#ynab');
  let inbox = null;
  try {
    const ib = await listInbox();
    inbox = {
      count: ib.count,
      unapproved: ib.unapproved,
      uncategorized: ib.uncategorized,
    };
  } catch (e) {
    inbox = { error: e.message };
  }
  return {
    itemCount: all.length,
    byType,
    planName: meta?.payload?.name,
    ynabPlanId: meta?.ynabPlanId || meta?.payload?.ynabPlanId,
    serverKnowledge: cursor?.serverKnowledge ?? meta?.serverKnowledge,
    inbox,
  };
}

/**
 * Set or clear a user nickname (alias) on a ledger account.
 * Does not push to YNAB — aliases are R2Finance-only display labels.
 *
 * Saving a non-empty value marks aliasUserSet so later YNAB pulls keep it.
 * Clearing removes the custom flag so the next pull re-seeds from the YNAB name.
 */
async function setAccountAlias(ynabId, aliasRaw) {
  const id = String(ynabId || '').trim();
  if (!id) {
    const err = new Error('ynabId required');
    err.status = 400;
    throw err;
  }
  const sk = `ACCT#${id}`;
  const existing = await ddb.getItem(ddb.planPk(), sk);
  if (!existing || existing.deleted) {
    const err = new Error('account not found');
    err.status = 404;
    throw err;
  }
  const alias =
    aliasRaw == null || aliasRaw === ''
      ? null
      : String(aliasRaw).trim().slice(0, 80) || null;
  const next = { ...existing, updatedAt: Date.now() };
  if (alias) {
    next.alias = alias;
    next.aliasUserSet = true;
  } else {
    // Clear custom nickname → next YNAB pull re-mirrors account name.
    delete next.alias;
    delete next.aliasUserSet;
  }
  await ddb.putItem(next);
  return mapAccount(next);
}

/**
 * One-shot: seed R2 aliases from current YNAB account names for every open
 * account that does not yet have a user-set nickname. Safe to call repeatedly.
 * Returns { seeded, skipped, total }.
 */
async function seedAccountAliasesFromYnab(planId = ledgerPlanId) {
  const accts = await ddb.queryPk(ddb.planPk(planId), 'ACCT#');
  let seeded = 0;
  let skipped = 0;
  const now = Date.now();
  for (const a of accts) {
    if (a.deleted || a.closed) {
      skipped += 1;
      continue;
    }
    if (isAliasUserSet(a)) {
      skipped += 1;
      continue;
    }
    const ynabName = String(a.name || a.payload?.name || '')
      .trim()
      .slice(0, 80);
    if (!ynabName) {
      skipped += 1;
      continue;
    }
    if (a.alias && String(a.alias).trim() === ynabName && a.aliasUserSet === false) {
      skipped += 1;
      continue;
    }
    await ddb.putItem({
      ...a,
      alias: ynabName,
      aliasUserSet: false,
      updatedAt: now,
    });
    seeded += 1;
  }
  return { seeded, skipped, total: accts.length };
}

/**
 * Create a category in YNAB then write CAT# to DynamoDB (immediate dual-write).
 * @param {{ name: string, categoryGroupId: string }} body
 */
async function createCategoryEntity({ name, categoryGroupId }) {
  const n = String(name || '').trim().slice(0, 100);
  const groupId = String(categoryGroupId || '').trim();
  if (!n) {
    const err = new Error('name required');
    err.status = 400;
    throw err;
  }
  if (!groupId) {
    const err = new Error('categoryGroupId required');
    err.status = 400;
    throw err;
  }
  if (isSystemCategoryName(n)) {
    const err = new Error('cannot create a system category name');
    err.status = 400;
    throw err;
  }

  const group = await ddb.getItem(ddb.planPk(), `CGRP#${groupId}`);
  if (!group || group.deleted) {
    const err = new Error('category group not found');
    err.status = 404;
    throw err;
  }
  if (isSystemCategoryGroupName(group.name)) {
    const err = new Error(
      `cannot add categories to system group “${group.name}”`,
    );
    err.status = 400;
    throw err;
  }

  const ynabPlanId = await resolveYnabPlanId();
  let created;
  try {
    created = await ynab.createCategory(ynabPlanId, {
      name: n,
      category_group_id: groupId,
    });
  } catch (e) {
    const err = new Error(e.message || 'YNAB create category failed');
    err.status = e.status || 502;
    err.body = e.body;
    throw err;
  }

  const catId = created.id;
  const color = colorForCategory({
    name: created.name || n,
    ynabId: catId,
  });
  const now = Date.now();
  const item = {
    pk: ddb.planPk(),
    sk: `CAT#${catId}`,
    entityType: 'category',
    ynabId: catId,
    name: created.name || n,
    categoryGroupId: created.category_group_id || groupId,
    hidden: !!created.hidden,
    deleted: false,
    userDeleted: false,
    color,
    syncStatus: 'SYNCED',
    updatedAt: now,
    lastPushedAt: now,
    payload: created,
  };
  await ddb.putItem(item);
  return {
    ok: true,
    ynab: true,
    category: mapCategory(item),
  };
}

/**
 * Update category name and/or group in YNAB + DynamoDB.
 * @param {{ ynabId: string, name?: string, categoryGroupId?: string }} body
 */
async function updateCategoryEntity({ ynabId, name, categoryGroupId }) {
  const id = String(ynabId || '').trim();
  if (!id) {
    const err = new Error('ynabId required');
    err.status = 400;
    throw err;
  }
  const existing = await ddb.getItem(ddb.planPk(), `CAT#${id}`);
  if (!existing || existing.deleted) {
    const err = new Error('category not found');
    err.status = 404;
    throw err;
  }
  if (isSystemCategoryName(existing.name)) {
    const err = new Error('cannot modify a system category');
    err.status = 400;
    throw err;
  }

  const existingGroupId = existing.categoryGroupId;
  if (existingGroupId) {
    const eg = await ddb.getItem(ddb.planPk(), `CGRP#${existingGroupId}`);
    if (eg && isSystemCategoryGroupName(eg.name)) {
      const err = new Error('cannot modify a system category');
      err.status = 400;
      throw err;
    }
  }

  const patch = {};
  if (name !== undefined && name !== null) {
    const n = String(name).trim().slice(0, 100);
    if (!n) {
      const err = new Error('name cannot be empty');
      err.status = 400;
      throw err;
    }
    if (isSystemCategoryName(n)) {
      const err = new Error('cannot rename to a system category name');
      err.status = 400;
      throw err;
    }
    patch.name = n;
  }
  if (categoryGroupId !== undefined && categoryGroupId !== null) {
    const groupId = String(categoryGroupId).trim();
    if (!groupId) {
      const err = new Error('categoryGroupId cannot be empty');
      err.status = 400;
      throw err;
    }
    const group = await ddb.getItem(ddb.planPk(), `CGRP#${groupId}`);
    if (!group || group.deleted) {
      const err = new Error('category group not found');
      err.status = 404;
      throw err;
    }
    if (isSystemCategoryGroupName(group.name)) {
      const err = new Error(
        `cannot move categories into system group “${group.name}”`,
      );
      err.status = 400;
      throw err;
    }
    patch.category_group_id = groupId;
  }

  if (Object.keys(patch).length === 0) {
    const err = new Error('name or categoryGroupId required');
    err.status = 400;
    throw err;
  }

  const ynabPlanId = await resolveYnabPlanId();
  let updated;
  try {
    updated = await ynab.updateCategory(ynabPlanId, id, patch);
  } catch (e) {
    const err = new Error(e.message || 'YNAB update category failed');
    err.status = e.status || 502;
    err.body = e.body;
    throw err;
  }

  const now = Date.now();
  const nextName = updated?.name || patch.name || existing.name;
  const nextGroup =
    updated?.category_group_id ||
    patch.category_group_id ||
    existing.categoryGroupId;
  // Keep color unless name changed to something colorForCategory prefers (preserve).
  const color =
    existing.color ||
    colorForCategory({ name: nextName, ynabId: id });
  const item = {
    ...existing,
    name: nextName,
    categoryGroupId: nextGroup,
    hidden: updated?.hidden ?? existing.hidden ?? false,
    deleted: false,
    userDeleted: false,
    color,
    payload: { ...(existing.payload || {}), ...(updated || {}), ...patch },
    syncStatus: 'SYNCED',
    updatedAt: now,
    lastPushedAt: now,
  };
  delete item.gsi2pk;
  delete item.gsi2sk;
  await ddb.putItem(item);
  return {
    ok: true,
    ynab: true,
    category: mapCategory(item),
  };
}

/**
 * Soft-delete category in DynamoDB; attempt YNAB DELETE (often unsupported).
 * userDeleted survives YNAB pulls so the row stays hidden in R2Finance.
 */
async function deleteCategoryEntity({ ynabId }) {
  const id = String(ynabId || '').trim();
  if (!id) {
    const err = new Error('ynabId required');
    err.status = 400;
    throw err;
  }
  const existing = await ddb.getItem(ddb.planPk(), `CAT#${id}`);
  if (!existing || (existing.deleted && existing.userDeleted)) {
    const err = new Error('category not found');
    err.status = 404;
    throw err;
  }
  if (isSystemCategoryName(existing.name)) {
    const err = new Error('cannot delete a system category');
    err.status = 400;
    throw err;
  }
  if (existing.categoryGroupId) {
    const eg = await ddb.getItem(
      ddb.planPk(),
      `CGRP#${existing.categoryGroupId}`,
    );
    if (eg && isSystemCategoryGroupName(eg.name)) {
      const err = new Error('cannot delete a system category');
      err.status = 400;
      throw err;
    }
  }

  let ynabOk = false;
  let ynabError = null;
  try {
    const ynabPlanId = await resolveYnabPlanId();
    await ynab.deleteCategory(ynabPlanId, id);
    ynabOk = true;
  } catch (e) {
    ynabError = e.message || String(e);
    // Expected: OpenAPI has no DELETE for categories (404/405).
    console.warn(
      JSON.stringify({
        msg: 'category delete→ynab',
        ynabId: id,
        error: ynabError,
        status: e.status,
      }),
    );
  }

  const now = Date.now();
  const item = {
    ...existing,
    deleted: true,
    userDeleted: true,
    hidden: true,
    syncStatus: 'SYNCED',
    updatedAt: now,
    ...(ynabOk ? { lastPushedAt: now } : {}),
  };
  delete item.gsi2pk;
  delete item.gsi2sk;
  await ddb.putItem(item);

  return {
    ok: true,
    ynabId: id,
    ynab: ynabOk,
    ynabError: ynabOk ? null : ynabError,
    warning: ynabOk
      ? null
      : 'Removed from R2Finance. YNAB has no documented delete-category API — hide or delete it in the YNAB app if you want it gone there too (R2 will keep it hidden on pulls).',
  };
}

module.exports = {
  fullImport,
  deltaPull,
  pushPending,
  devicePush,
  categorizeTransaction,
  approveTransaction,
  listInbox,
  listChanges,
  mapTxn,
  mapAccount,
  mapCategory,
  setAccountAlias,
  seedAccountAliasesFromYnab,
  resolveAccountAliasForPull,
  createCategoryEntity,
  updateCategoryEntity,
  deleteCategoryEntity,
  extractAccountMask,
  isSystemCategoryGroupName,
  isSystemCategoryName,
  stats,
  uuid,
  tombstoneTxnItem,
  matchedCounterpartTombstones,
  ghostTransferImportTombstones,
  autoApproveUnapprovedTransferLegs,
  dateDiffDays,
  ddbTxnToYnabShape,
  mergeLedgerForGhostScan,
  reconcileMissingYnabTxns,
};
