'use strict';

const crypto = require('crypto');
const ynab = require('./ynab');
const ddb = require('./ddb');
const { ledgerPlanId } = require('./config');
const { colorForCategory } = require('./categoryColors');
const { pickEnrichment } = require('./plaidEnrich');

/** Load existing category colors so re-import / delta never drifts user or assigned colors. */
async function loadCategoryColorMap(planId) {
  const cats = await ddb.queryPk(ddb.planPk(planId), 'CAT#');
  const map = new Map();
  for (const c of cats) {
    if (c.ynabId && c.color) map.set(c.ynabId, c.color);
  }
  return map;
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
function tombstoneTxnItem(planId, ynabId, accountId) {
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
      _tombstone: 'matched_or_missing',
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
 * Empirically when matched_transaction_id is set, the other side is never
 * both-live in YNAB's transaction list (it was absorbed/deleted).
 *
 * @param {string} planId
 * @param {Array<{id:string, matched_transaction_id?:string|null, account_id?:string, deleted?:boolean}>} transactions
 * @param {Set<string>} [pendingSk] TXN#… keys to leave alone (local PENDING_PUSH)
 * @returns {object[]} DDB put items
 */
function matchedCounterpartTombstones(planId, transactions, pendingSk = new Set()) {
  const out = [];
  const seen = new Set();
  for (const t of transactions || []) {
    if (!t || t.deleted) continue;
    const mid = t.matched_transaction_id;
    if (!mid || mid === t.id) continue;
    const sk = `TXN#${mid}`;
    if (pendingSk.has(sk) || seen.has(mid)) continue;
    // Never tombstone a counterpart that is itself present as a live row in
    // this same batch (defensive — YNAB currently never does this).
    const stillLive = (transactions || []).some(
      (o) => o && o.id === mid && !o.deleted,
    );
    if (stillLive) continue;
    seen.add(mid);
    const item = tombstoneTxnItem(planId, mid, t.account_id);
    if (item) out.push(item);
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

  for (const a of accountsR.accounts) {
    if (a.deleted) continue;
    items.push(
      entityItem({
        planId,
        sk: `ACCT#${a.id}`,
        entityType: 'account',
        ynabId: a.id,
        payload: a,
        extra: {
          name: a.name,
          type: a.type,
          onBudget: a.on_budget,
          balance: a.balance,
          closed: a.closed,
        },
      }),
    );
  }

  const categoryColorMap = await loadCategoryColorMap(planId);

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
      if (c.deleted) continue;
      items.push(
        entityItem({
          planId,
          sk: `CAT#${c.id}`,
          entityType: 'category',
          ynabId: c.id,
          payload: c,
          extra: categoryColorExtra(c, g.id, categoryColorMap),
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

  for (const t of txnsR.transactions) {
    const sk = `TXN#${t.id}`;
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
  items.push(...matchedCounterpartTombstones(planId, txnsR.transactions));

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
  for (const a of accountsR.accounts) {
    items.push(
      entityItem({
        planId,
        sk: `ACCT#${a.id}`,
        entityType: 'account',
        ynabId: a.id,
        payload: a,
        extra: {
          name: a.name,
          type: a.type,
          onBudget: a.on_budget,
          balance: a.balance,
          closed: a.closed,
          deleted: !!a.deleted,
        },
      }),
    );
  }

  const categoriesR = await ynab.listCategories(ynabPlanId, last);
  knowledge = Math.max(knowledge, categoriesR.serverKnowledge);
  const categoryColorMap = await loadCategoryColorMap(planId);
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
          extra: categoryColorExtra(c, g.id, categoryColorMap),
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

  let skippedPending = 0;
  for (const t of txnsR.transactions) {
    const sk = `TXN#${t.id}`;
    if (pendingSk.has(sk)) {
      skippedPending += 1;
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
  items.push(
    ...matchedCounterpartTombstones(planId, txnsR.transactions, pendingSk),
  );

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
      // Categories pending push
      if (item.entityType === 'category' && item.syncStatus === 'PENDING_PUSH') {
        try {
          if (item.ynabId) {
            await ynab.updateCategory(ynabPlanId, item.ynabId, {
              name: item.name || item.payload?.name,
            });
          } else if (item.payload?.category_group_id || item.categoryGroupId) {
            const created = await ynab.createCategory(ynabPlanId, {
              name: item.name || item.payload?.name,
              category_group_id: item.categoryGroupId || item.payload.category_group_id,
            });
            await ddb.markSynced(item.pk, item.sk, { ynabId: created.id });
            results.push({ sk: item.sk, ok: true, created: true });
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
        await ddb.putItem({
          ...item,
          ynabId: newYnabId,
          deviceCreate: false,
          syncStatus: 'SYNCED',
          updatedAt: Date.now(),
          payload: {
            ...payload,
            id: newYnabId,
          },
          gsi2pk: undefined,
          gsi2sk: undefined,
        });
        // Clear GSI pending keys
        await ddb.markSynced(item.pk, item.sk, { ynabId: newYnabId, deviceCreate: false });
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
      results.push({ sk: item.sk, ok: true, ynabTxnId });
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
      .map((i) => ({
        ynabId: i.ynabId,
        name: i.name,
        type: i.type,
        balance: i.balance ?? i.payload?.balance ?? 0,
        onBudget: i.onBudget ?? i.payload?.on_budget ?? true,
        closed: !!(i.closed ?? i.payload?.closed ?? false),
        note: i.payload?.note ?? null,
        transferPayeeId: i.payload?.transfer_payee_id ?? null,
        deleted: !!i.deleted,
        updatedAt: i.updatedAt || 0,
      }));

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
    out.push({
      ...t,
      accountName: acct.name || acct.payload?.name || null,
      payeeName: payee?.name || payee?.payload?.name || null,
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
  stats,
  uuid,
  tombstoneTxnItem,
  matchedCounterpartTombstones,
  reconcileMissingYnabTxns,
};
