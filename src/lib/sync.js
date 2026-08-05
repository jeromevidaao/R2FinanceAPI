'use strict';

const crypto = require('crypto');
const ynab = require('./ynab');
const ddb = require('./ddb');
const { ledgerPlanId } = require('./config');

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
          extra: {
            name: c.name,
            categoryGroupId: c.category_group_id || g.id,
            hidden: c.hidden,
          },
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

  for (const t of txnsR.transactions) {
    if (t.deleted) {
      items.push(
        entityItem({
          planId,
          sk: `TXN#${t.id}`,
          entityType: 'transaction',
          ynabId: t.id,
          payload: t,
          extra: { deleted: true, accountId: t.account_id },
        }),
      );
      continue;
    }
    items.push(
      entityItem({
        planId,
        sk: `TXN#${t.id}`,
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
        },
      }),
    );
  }

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
    },
    serverKnowledge: knowledge,
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
          extra: {
            name: c.name,
            categoryGroupId: c.category_group_id || g.id,
            hidden: c.hidden,
            deleted: !!c.deleted,
          },
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

  let skippedPending = 0;
  for (const t of txnsR.transactions) {
    const sk = `TXN#${t.id}`;
    if (pendingSk.has(sk)) {
      skippedPending += 1;
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
          deleted: !!t.deleted,
        },
      }),
    );
  }

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

  return {
    mode: 'delta',
    ynabPlanId,
    previousKnowledge: last,
    serverKnowledge: knowledge,
    itemsUpserted: items.length,
    skippedPendingPush: skippedPending,
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

    const ynabTxnId = item.ynabId || item.sk.replace(/^TXN#/, '');
    const payload = item.payload || {};
    const categoryId = item.categoryId !== undefined ? item.categoryId : payload.category_id;
    const approved = item.approved !== undefined ? item.approved : payload.approved;
    const memo = item.memo !== undefined ? item.memo : payload.memo;
    const cleared = item.cleared || payload.cleared;

    try {
      await ynab.updateTransaction(ynabPlanId, ynabTxnId, {
        category_id: categoryId,
        approved: approved !== false,
        memo: memo ?? null,
        cleared: cleared || 'uncleared',
        // required fields for PUT — pass through from last known
        account_id: item.accountId || payload.account_id,
        date: item.date || payload.date,
        amount: item.amount ?? payload.amount,
        payee_id: item.payeeId ?? payload.payee_id ?? null,
      });
      await ddb.markSynced(item.pk, item.sk);
      results.push({ sk: item.sk, ok: true, ynabTxnId });
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
 */
function mapTxn(t) {
  const p = t.payload || {};
  return {
    ynabId: t.ynabId,
    accountId: t.accountId || p.account_id,
    date: t.date || p.date,
    amount: t.amount ?? p.amount,
    payeeId: t.payeeId ?? p.payee_id ?? null,
    categoryId: t.categoryId ?? p.category_id ?? null,
    memo: t.memo ?? p.memo ?? null,
    cleared: t.cleared || p.cleared || 'uncleared',
    approved: t.approved ?? p.approved ?? true,
    flagColor: p.flag_color || null,
    transferAccountId: p.transfer_account_id || null,
    transferTransactionId: p.transfer_transaction_id || null,
    importId: p.import_id || null,
    subtransactions: (p.subtransactions || []).map((s) => ({
      ynabId: s.id,
      amount: s.amount,
      payeeId: s.payee_id || null,
      categoryId: s.category_id || null,
      memo: s.memo || null,
    })),
  };
}

/**
 * Needs-attention inbox (YNAB-style):
 * - unapproved (any account / including transfers)
 * - on-budget, no category, not a transfer, no subtransactions
 * - on-budget, category is Internal "Uncategorized"
 */
async function listInbox() {
  const planId = ledgerPlanId;
  const [txns, accounts, categories, payees] = await Promise.all([
    ddb.queryPk(ddb.planPk(planId), 'TXN#'),
    ddb.queryPk(ddb.planPk(planId), 'ACCT#'),
    ddb.queryPk(ddb.planPk(planId), 'CAT#'),
    ddb.queryPk(ddb.planPk(planId), 'PAYEE#'),
  ]);

  const acctById = new Map();
  for (const a of accounts) {
    if (a.deleted || a.closed) continue;
    const id = a.ynabId || String(a.sk || '').replace(/^ACCT#/, '');
    acctById.set(id, a);
  }

  const uncategorizedIds = new Set();
  for (const c of categories) {
    if (c.deleted) continue;
    const name = (c.name || c.payload?.name || '').toLowerCase();
    if (name === 'uncategorized') {
      const id = c.ynabId || String(c.sk || '').replace(/^CAT#/, '');
      uncategorizedIds.add(id);
    }
  }

  const payeeById = new Map();
  for (const p of payees) {
    if (p.deleted) continue;
    const id = p.ynabId || String(p.sk || '').replace(/^PAYEE#/, '');
    payeeById.set(id, p);
  }

  const out = [];
  for (const raw of txns) {
    if (raw.deleted) continue;
    const t = mapTxn(raw);
    if (!t.ynabId || !t.accountId) continue;
    const acct = acctById.get(t.accountId);
    if (!acct) continue;

    const onBudget = acct.onBudget ?? acct.payload?.on_budget ?? true;
    const isTransfer = !!t.transferAccountId;
    const hasSubs = (t.subtransactions || []).length > 0;
    const approved = t.approved !== false;
    const catNull = t.categoryId == null || t.categoryId === '';
    const catUncategorized = t.categoryId && uncategorizedIds.has(t.categoryId);

    let reason = null;
    if (!approved) {
      reason = 'unapproved';
    } else if (onBudget && !isTransfer && !hasSubs && (catNull || catUncategorized)) {
      reason = 'uncategorized';
    }
    if (!reason) continue;

    const payee = t.payeeId ? payeeById.get(t.payeeId) : null;
    out.push({
      ...t,
      accountName: acct.name || acct.payload?.name || null,
      payeeName: payee?.name || payee?.payload?.name || null,
      reason,
      onBudget: !!onBudget,
    });
  }

  out.sort((a, b) => {
    if (a.date === b.date) return (b.amount || 0) - (a.amount || 0);
    return a.date < b.date ? 1 : -1;
  });

  return {
    count: out.length,
    unapproved: out.filter((t) => t.reason === 'unapproved').length,
    uncategorized: out.filter((t) => t.reason === 'uncategorized').length,
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
  categorizeTransaction,
  approveTransaction,
  listInbox,
  mapTxn,
  stats,
  uuid,
};
