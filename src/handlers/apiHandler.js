'use strict';

const sync = require('../lib/sync');
const ddb = require('../lib/ddb');
const { ledgerPlanId } = require('../lib/config');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event?.body) return {};
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return {};
  }
}

exports.handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const path = event?.rawPath || event?.path || '/';

  if (method === 'OPTIONS') return json(204, {});

  try {
    if (method === 'GET' && (path === '/' || path === '/health')) {
      return json(200, {
        ok: true,
        service: 'R2FinanceAPI',
        phase: 3,
        table: ddb.tableName,
        planId: ledgerPlanId,
      });
    }

    if (method === 'GET' && path === '/v1/stats') {
      return json(200, await sync.stats());
    }

    if (method === 'POST' && path === '/v1/sync/import') {
      const body = parseBody(event);
      const report = await sync.fullImport({
        sinceDate: body.sinceDate || '1990-01-01',
      });
      return json(200, report);
    }

    if (method === 'POST' && path === '/v1/sync/pull') {
      return json(200, await sync.deltaPull());
    }

    if (method === 'POST' && path === '/v1/sync/push') {
      return json(200, await sync.pushPending(parseBody(event)));
    }

    if (method === 'POST' && path === '/v1/sync/tick') {
      // Pull then push — used by schedule or manual
      const pull = await sync.deltaPull();
      const push = await sync.pushPending();
      return json(200, { pull, push });
    }

    if (method === 'POST' && path === '/v1/transactions/categorize') {
      const body = parseBody(event);
      if (!body.ynabTxnId || !body.categoryYnabId) {
        return json(400, {
          error: 'ynabTxnId and categoryYnabId required',
        });
      }
      const marked = await sync.categorizeTransaction(body);
      // Optional immediate push
      let push;
      if (body.push !== false) {
        push = await sync.pushPending({ limit: 5 });
      }
      return json(200, { marked, push });
    }

    if (method === 'GET' && path === '/v1/accounts') {
      const items = await ddb.queryPk(ddb.planPk(), 'ACCT#');
      return json(200, {
        accounts: items.map((i) => ({
          ynabId: i.ynabId,
          name: i.name,
          type: i.type,
          balance: i.balance,
          onBudget: i.onBudget,
          closed: i.closed,
        })),
      });
    }

    if (method === 'GET' && path === '/v1/categories') {
      const groups = await ddb.queryPk(ddb.planPk(), 'CGRP#');
      const cats = await ddb.queryPk(ddb.planPk(), 'CAT#');
      return json(200, {
        groups: groups.map((g) => ({ ynabId: g.ynabId, name: g.name })),
        categories: cats.map((c) => ({
          ynabId: c.ynabId,
          name: c.name,
          categoryGroupId: c.categoryGroupId,
        })),
      });
    }

    return json(404, { error: 'not_found', path, method });
  } catch (e) {
    console.error(e);
    return json(500, { error: e.message || String(e) });
  }
};
