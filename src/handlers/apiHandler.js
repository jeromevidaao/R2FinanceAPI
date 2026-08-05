'use strict';

const sync = require('../lib/sync');
const ddb = require('../lib/ddb');
const auth = require('../lib/auth');
const connectors = require('../lib/connectors');
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

function bearerToken(event) {
  const hdr =
    event?.headers?.authorization || event?.headers?.Authorization || '';
  return hdr.replace(/^Bearer\s+/i, '').trim();
}

async function requireSession(event) {
  const token = bearerToken(event);
  const session = await auth.validateSession(token);
  if (!session) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  return session;
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

    // ── Auth ──────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/v1/auth/bootstrap') {
      const user = await auth.ensureUser(auth.ALLOWED_EMAIL);
      return json(200, {
        ok: true,
        email: user.email,
        mustSetPassword: !!user.mustSetPassword || !user.passwordHash,
        mfaEnabled: !!user.mfaEnabled,
      });
    }

    if (method === 'POST' && path === '/v1/auth/status') {
      const body = parseBody(event);
      return json(200, await auth.authStatus(body.email));
    }

    if (method === 'POST' && path === '/v1/auth/set-password') {
      const body = parseBody(event);
      return json(200, await auth.setPassword(body.email, body.password));
    }

    if (method === 'POST' && path === '/v1/auth/login') {
      const body = parseBody(event);
      return json(200, await auth.login(body.email, body.password));
    }

    if (method === 'POST' && path === '/v1/auth/mfa/setup') {
      const body = parseBody(event);
      return json(200, await auth.mfaSetupStart(body.email, body.password));
    }

    if (method === 'POST' && path === '/v1/auth/mfa/enable') {
      const body = parseBody(event);
      return json(
        200,
        await auth.mfaSetupConfirm(body.email, body.password, body.code),
      );
    }

    if (method === 'POST' && path === '/v1/auth/mfa/verify') {
      const body = parseBody(event);
      return json(200, await auth.mfaVerify(body.mfaToken, body.code));
    }

    if (method === 'GET' && path === '/v1/auth/me') {
      const hdr = event?.headers?.authorization || event?.headers?.Authorization || '';
      const token = hdr.replace(/^Bearer\s+/i, '').trim();
      const session = await auth.validateSession(token);
      if (!session) return json(401, { error: 'unauthorized' });
      return json(200, { email: session.email, expiresAt: session.expiresAt });
    }

    if (method === 'POST' && path === '/v1/auth/forgot-password') {
      const body = parseBody(event);
      return json(200, await auth.requestPasswordReset(body.email));
    }

    if (method === 'POST' && path === '/v1/auth/reset-password') {
      const body = parseBody(event);
      return json(
        200,
        await auth.resetPasswordWithToken(body.token, body.password),
      );
    }

    // Admin invite (session must be primary admin email)
    if (method === 'POST' && path === '/v1/auth/invite') {
      const hdr =
        event?.headers?.authorization || event?.headers?.Authorization || '';
      const token = hdr.replace(/^Bearer\s+/i, '').trim();
      const session = await auth.validateSession(token);
      if (!session || session.email !== auth.ALLOWED_EMAIL) {
        return json(401, { error: 'admin_required' });
      }
      const body = parseBody(event);
      return json(200, await auth.inviteUser(body.email));
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

    // Phone offline-first: land Room PENDING_PUSH into DDB. YNAB later via tick/schedule.
    if (method === 'POST' && path === '/v1/device/push') {
      return json(200, await sync.devicePush(parseBody(event)));
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

    if (method === 'POST' && path === '/v1/transactions/approve') {
      const body = parseBody(event);
      if (!body.ynabTxnId) {
        return json(400, { error: 'ynabTxnId required' });
      }
      const marked = await sync.approveTransaction(body);
      let push;
      if (body.push !== false) {
        push = await sync.pushPending({ limit: 5 });
      }
      return json(200, { marked, push });
    }

    if (method === 'GET' && path === '/v1/inbox') {
      return json(200, await sync.listInbox());
    }

    if (method === 'GET' && path === '/v1/accounts') {
      const items = await ddb.queryPk(ddb.planPk(), 'ACCT#');
      return json(200, {
        accounts: items
          .filter((i) => !i.deleted && !i.closed)
          .map((i) => ({
            ynabId: i.ynabId,
            name: i.name,
            type: i.type,
            balance: i.balance ?? i.payload?.balance ?? 0,
            onBudget: i.onBudget ?? i.payload?.on_budget ?? true,
            closed: i.closed ?? i.payload?.closed ?? false,
            note: i.payload?.note ?? null,
            transferPayeeId: i.payload?.transfer_payee_id ?? null,
          })),
      });
    }

    if (method === 'GET' && path === '/v1/categories') {
      const groups = await ddb.queryPk(ddb.planPk(), 'CGRP#');
      const cats = await ddb.queryPk(ddb.planPk(), 'CAT#');
      return json(200, {
        groups: groups
          .filter((g) => !g.deleted)
          .map((g) => ({
            ynabId: g.ynabId,
            name: g.name,
            hidden: g.hidden ?? false,
          })),
        categories: cats
          .filter((c) => !c.deleted)
          .map((c) => ({
            ynabId: c.ynabId,
            name: c.name,
            categoryGroupId: c.categoryGroupId,
            hidden: c.hidden ?? false,
          })),
      });
    }

    if (method === 'GET' && path === '/v1/payees') {
      const items = await ddb.queryPk(ddb.planPk(), 'PAYEE#');
      return json(200, {
        payees: items
          .filter((p) => !p.deleted)
          .map((p) => ({
            ynabId: p.ynabId,
            name: p.name,
            transferAccountId: p.transferAccountId ?? p.payload?.transfer_account_id ?? null,
          })),
      });
    }

    if (method === 'GET' && path === '/v1/transactions') {
      const items = await ddb.queryPk(ddb.planPk(), 'TXN#');
      // Map closed accounts if needed — return all non-deleted for hydrate
      return json(200, {
        transactions: items
          .filter((t) => !t.deleted)
          .map((t) => sync.mapTxn(t)),
      });
    }

    if (method === 'GET' && path === '/v1/plan') {
      const meta = await ddb.getItem(ddb.planPk(), 'META');
      return json(200, {
        plan: {
          name: meta?.payload?.name || meta?.name || 'Plan',
          ynabPlanId: meta?.ynabPlanId || meta?.payload?.ynabPlanId,
          currency: meta?.payload?.currency || 'USD',
          serverKnowledge: meta?.serverKnowledge ?? 0,
        },
      });
    }

    // ── Bank connectors (Plaid) ───────────────────────────────────────
    // Access only — never write bank transactions into DDB ledger TXN#.
    // Supported: boa, chase (see connectors.BANKS).
    if (method === 'GET' && path === '/v1/connectors') {
      await requireSession(event);
      return json(200, await connectors.listStatus());
    }

    const connectorMatch = path.match(
      /^\/v1\/connectors\/([a-z0-9_-]+)(?:\/(link-token|exchange|accounts|disconnect))?$/,
    );
    if (connectorMatch) {
      const bankId = connectorMatch[1];
      const action = connectorMatch[2] || null;

      if (method === 'GET' && !action) {
        await requireSession(event);
        return json(200, await connectors.status(bankId));
      }

      if (method === 'POST' && action === 'link-token') {
        const session = await requireSession(event);
        const bank = connectors.resolveBank(bankId);
        const out = await connectors.createLinkToken(bankId, {
          email: session.email,
        });
        return json(200, {
          link_token: out.link_token,
          expiration: out.expiration,
          request_id: out.request_id,
          connectorId: bank.id,
          institution: bank.name,
        });
      }

      if (method === 'POST' && action === 'exchange') {
        const session = await requireSession(event);
        const body = parseBody(event);
        const result = await connectors.exchangeAndStore(bankId, {
          publicToken: body.public_token || body.publicToken,
          email: session.email,
          metadata: body.metadata || null,
        });
        return json(200, result);
      }

      if (method === 'GET' && action === 'accounts') {
        await requireSession(event);
        return json(200, await connectors.probeAccounts(bankId));
      }

      if (method === 'POST' && action === 'disconnect') {
        await requireSession(event);
        return json(200, await connectors.disconnect(bankId));
      }
    }

    return json(404, { error: 'not_found', path, method });
  } catch (e) {
    console.error(e);
    const status = e.status && Number.isInteger(e.status) ? e.status : 500;
    return json(status, {
      error: e.message || String(e),
      code: e.code || undefined,
    });
  }
};
