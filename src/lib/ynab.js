'use strict';

const { ynabBase } = require('./config');
const { getYnabToken } = require('./secrets');

async function ynabFetch(path, { method = 'GET', body } = {}) {
  const token = await getYnabToken();
  const url = `${ynabBase.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `YNAB ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`,
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function listPlans() {
  const r = await ynabFetch('/plans');
  return r.data.plans || [];
}

async function listAccounts(planId, lastKnowledge) {
  const q = lastKnowledge != null ? `?last_knowledge_of_server=${lastKnowledge}` : '';
  const r = await ynabFetch(`/plans/${planId}/accounts${q}`);
  return {
    accounts: r.data.accounts || [],
    serverKnowledge: r.data.server_knowledge ?? 0,
  };
}

async function listCategories(planId, lastKnowledge) {
  const q = lastKnowledge != null ? `?last_knowledge_of_server=${lastKnowledge}` : '';
  const r = await ynabFetch(`/plans/${planId}/categories${q}`);
  return {
    categoryGroups: r.data.category_groups || [],
    serverKnowledge: r.data.server_knowledge ?? 0,
  };
}

async function listPayees(planId, lastKnowledge) {
  const q = lastKnowledge != null ? `?last_knowledge_of_server=${lastKnowledge}` : '';
  const r = await ynabFetch(`/plans/${planId}/payees${q}`);
  return {
    payees: r.data.payees || [],
    serverKnowledge: r.data.server_knowledge ?? 0,
  };
}

async function listTransactions(planId, { sinceDate = '1990-01-01', lastKnowledge } = {}) {
  const params = new URLSearchParams();
  if (sinceDate) params.set('since_date', sinceDate);
  if (lastKnowledge != null) params.set('last_knowledge_of_server', String(lastKnowledge));
  const q = params.toString() ? `?${params}` : '';
  const r = await ynabFetch(`/plans/${planId}/transactions${q}`);
  return {
    transactions: r.data.transactions || [],
    serverKnowledge: r.data.server_knowledge ?? 0,
  };
}

async function listScheduled(planId, lastKnowledge) {
  const q = lastKnowledge != null ? `?last_knowledge_of_server=${lastKnowledge}` : '';
  const r = await ynabFetch(`/plans/${planId}/scheduled_transactions${q}`);
  return {
    scheduled: r.data.scheduled_transactions || [],
    serverKnowledge: r.data.server_knowledge ?? 0,
  };
}

async function updateTransaction(planId, transactionId, patch) {
  const r = await ynabFetch(`/plans/${planId}/transactions/${transactionId}`, {
    method: 'PUT',
    body: { transaction: patch },
  });
  return r.data.transaction || r.data;
}

async function createCategory(planId, { name, category_group_id }) {
  const r = await ynabFetch(`/plans/${planId}/categories`, {
    method: 'POST',
    body: { category: { name, category_group_id } },
  });
  return r.data.category;
}

async function updateCategory(planId, categoryId, patch) {
  const r = await ynabFetch(`/plans/${planId}/categories/${categoryId}`, {
    method: 'PATCH',
    body: { category: patch },
  });
  return r.data.category;
}

module.exports = {
  ynabFetch,
  listPlans,
  listAccounts,
  listCategories,
  listPayees,
  listTransactions,
  listScheduled,
  updateTransaction,
  createCategory,
  updateCategory,
};
