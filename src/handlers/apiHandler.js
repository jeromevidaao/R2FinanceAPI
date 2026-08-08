'use strict';

const zlib = require('zlib');
const sync = require('../lib/sync');
const ddb = require('../lib/ddb');
const auth = require('../lib/auth');
const connectors = require('../lib/connectors');
const fcm = require('../lib/fcm');
const { ledgerPlanId } = require('../lib/config');

/** Gzip JSON bodies larger than this (bytes) to stay under Lambda 6MB response cap. */
const GZIP_THRESHOLD = 200_000;

/**
 * Browser origins allowed for CORS. Non-browser clients (Android) send no
 * Origin header — CORS does not apply to them.
 */
const CORS_ORIGINS = new Set([
  'https://finance.i-liquid.be',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

/**
 * Public routes (no session). Everything else requires a valid session for
 * an allow-listed email (Jerome or Ngoc only). Login + password recovery stay
 * public so household members can authenticate.
 */
const PUBLIC_ROUTES = new Set([
  'GET /',
  'GET /health',
  'POST /v1/auth/bootstrap',
  'POST /v1/auth/status',
  'POST /v1/auth/set-password',
  'POST /v1/auth/login',
  'POST /v1/auth/mfa/setup',
  'POST /v1/auth/mfa/enable',
  'POST /v1/auth/mfa/verify',
  'POST /v1/auth/forgot-password',
  'POST /v1/auth/reset-password',
]);

function isPublicRoute(method, path) {
  return PUBLIC_ROUTES.has(`${method} ${path}`);
}

function header(event, name) {
  const h = event?.headers || {};
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (String(k).toLowerCase() === want) return v;
  }
  return undefined;
}

function corsOrigin(event) {
  const origin = header(event, 'origin');
  if (!origin) return '*'; // native / curl — not a browser CORS context
  return CORS_ORIGINS.has(origin) ? origin : 'https://finance.i-liquid.be';
}

function json(statusCode, body, event = null) {
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': corsOrigin(event),
    'access-control-allow-headers':
      'authorization,content-type,x-r2finance-client,x-client,accept-encoding',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    vary: 'Origin, Accept-Encoding',
  };
  const raw = JSON.stringify(body == null ? {} : body);
  // Compress large payloads so full ledger sync stays under Lambda's 6MB limit.
  // Browsers (fetch) and OkHttp auto-decompress Content-Encoding: gzip.
  if (raw.length >= GZIP_THRESHOLD) {
    const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 6 });
    return {
      statusCode,
      headers: {
        ...headers,
        'content-encoding': 'gzip',
      },
      isBase64Encoded: true,
      body: gz.toString('base64'),
    };
  }
  return {
    statusCode,
    headers,
    body: raw,
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

function clientIp(event) {
  const xf = header(event, 'x-forwarded-for');
  if (xf) return String(xf).split(',')[0].trim();
  return (
    event?.requestContext?.http?.sourceIp ||
    event?.requestContext?.identity?.sourceIp ||
    null
  );
}

/**
 * Resolve client label for login alerts: body.client | header | user-agent.
 * @returns {'android'|'web'|'unknown'|string}
 */
function resolveClient(event, body = {}) {
  const fromBody = String(body.client || body.source || '')
    .trim()
    .toLowerCase();
  if (fromBody === 'android' || fromBody === 'web' || fromBody === 'ios') {
    return fromBody;
  }
  const hdr = String(
    header(event, 'x-r2finance-client') || header(event, 'x-client') || '',
  )
    .trim()
    .toLowerCase();
  if (hdr === 'android' || hdr === 'web' || hdr === 'ios') return hdr;
  const ua = String(header(event, 'user-agent') || '').toLowerCase();
  if (ua.includes('okhttp') || ua.includes('r2financeandroid')) return 'android';
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) {
    return 'web';
  }
  return fromBody || 'unknown';
}

/**
 * Fire FCM sign-in alert after a session token is issued.
 * Awaits FCM so the push goes out before the client finishes navigating,
 * but never fails the login response.
 */
async function maybeNotifySignIn(event, body, authResult) {
  if (!authResult || !authResult.ok || !authResult.token || !authResult.email) {
    return;
  }
  try {
    await fcm.notifySignIn({
      email: authResult.email,
      client: resolveClient(event, body),
      ip: clientIp(event),
      userAgent: header(event, 'user-agent') || null,
    });
  } catch (e) {
    console.error('maybeNotifySignIn', e && e.message ? e.message : e);
  }
}

function bearerToken(event) {
  const hdr =
    event?.headers?.authorization || event?.headers?.Authorization || '';
  return hdr.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Require a valid session for an allow-listed household member.
 * validateSession already rejects non-allowlist emails.
 */
async function requireSession(event) {
  const token = bearerToken(event);
  const session = await auth.validateSession(token);
  if (!session) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  if (!auth.isAllowedEmail(session.email)) {
    const err = new Error('forbidden');
    err.status = 403;
    throw err;
  }
  return session;
}

exports.handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const path = event?.rawPath || event?.path || '/';
  const respond = (code, body) => json(code, body, event);

  if (method === 'OPTIONS') return respond(204, {});

  try {
    // ── Default deny: session required unless route is public ─────────
    let session = null;
    if (!isPublicRoute(method, path)) {
      session = await requireSession(event);
    }

    if (method === 'GET' && (path === '/' || path === '/health')) {
      return respond(200, {
        ok: true,
        service: 'R2FinanceAPI',
        phase: 3,
        table: ddb.tableName,
        planId: ledgerPlanId,
      });
    }

    // ── Auth (public subset; invite requires admin session) ───────────
    if (method === 'POST' && path === '/v1/auth/bootstrap') {
      const user = await auth.ensureUser(auth.ALLOWED_EMAIL);
      return respond(200, {
        ok: true,
        email: user.email,
        mustSetPassword: !!user.mustSetPassword || !user.passwordHash,
        mfaEnabled: !!user.mfaEnabled,
      });
    }

    if (method === 'POST' && path === '/v1/auth/status') {
      const body = parseBody(event);
      return respond(200, await auth.authStatus(body.email));
    }

    if (method === 'POST' && path === '/v1/auth/set-password') {
      const body = parseBody(event);
      return respond(200, await auth.setPassword(body.email, body.password));
    }

    if (method === 'POST' && path === '/v1/auth/login') {
      const body = parseBody(event);
      const result = await auth.login(body.email, body.password);
      await maybeNotifySignIn(event, body, result);
      return respond(200, result);
    }

    if (method === 'POST' && path === '/v1/auth/mfa/setup') {
      const body = parseBody(event);
      return respond(200, await auth.mfaSetupStart(body.email, body.password));
    }

    if (method === 'POST' && path === '/v1/auth/mfa/enable') {
      const body = parseBody(event);
      const result = await auth.mfaSetupConfirm(
        body.email,
        body.password,
        body.code,
      );
      await maybeNotifySignIn(event, body, result);
      return respond(200, result);
    }

    if (method === 'POST' && path === '/v1/auth/mfa/verify') {
      const body = parseBody(event);
      const result = await auth.mfaVerify(body.mfaToken, body.code);
      await maybeNotifySignIn(event, body, result);
      return respond(200, result);
    }

    if (method === 'GET' && path === '/v1/auth/me') {
      return respond(200, {
        email: session.email,
        expiresAt: session.expiresAt,
      });
    }

    if (method === 'POST' && path === '/v1/auth/forgot-password') {
      const body = parseBody(event);
      return respond(200, await auth.requestPasswordReset(body.email));
    }

    if (method === 'POST' && path === '/v1/auth/reset-password') {
      const body = parseBody(event);
      return respond(
        200,
        await auth.resetPasswordWithToken(body.token, body.password),
      );
    }

    // Admin invite (session must be primary admin email)
    if (method === 'POST' && path === '/v1/auth/invite') {
      if (!session || session.email !== auth.ALLOWED_EMAIL) {
        return respond(403, { error: 'admin_required' });
      }
      const body = parseBody(event);
      return respond(200, await auth.inviteUser(body.email));
    }

    // ── Ledger / sync — session + allow-list only ─────────────────────
    if (method === 'GET' && path === '/v1/stats') {
      return respond(200, await sync.stats());
    }

    if (method === 'POST' && path === '/v1/sync/import') {
      const body = parseBody(event);
      const report = await sync.fullImport({
        sinceDate: body.sinceDate || '1990-01-01',
      });
      return respond(200, report);
    }

    if (method === 'POST' && path === '/v1/sync/pull') {
      return respond(200, await sync.deltaPull());
    }

    if (method === 'POST' && path === '/v1/sync/push') {
      return respond(200, await sync.pushPending(parseBody(event)));
    }

    if (method === 'POST' && path === '/v1/sync/tick') {
      // Pull then push — used by client manual refresh (EventBridge hits Lambdas directly)
      const pull = await sync.deltaPull();
      const push = await sync.pushPending();
      return respond(200, { pull, push });
    }

    // Local-first clients: full snapshot or incremental changes since cursor.
    // GET /v1/sync/changes?since=<epoch_ms>&full=0|1&txnOffset=0&txnLimit=2500
    if (method === 'GET' && path === '/v1/sync/changes') {
      const qs = event?.queryStringParameters || {};
      return respond(
        200,
        await sync.listChanges({
          since: qs.since,
          full: qs.full,
          txnOffset: qs.txnOffset,
          txnLimit: qs.txnLimit,
        }),
      );
    }

    // Phone offline-first: land Room PENDING_PUSH into DDB. YNAB later via tick/schedule.
    if (method === 'POST' && path === '/v1/device/push') {
      return respond(200, await sync.devicePush(parseBody(event)));
    }

    if (method === 'POST' && path === '/v1/transactions/categorize') {
      const body = parseBody(event);
      if (!body.ynabTxnId || !body.categoryYnabId) {
        return respond(400, {
          error: 'ynabTxnId and categoryYnabId required',
        });
      }
      // 1) Write category to DynamoDB + mark PENDING_PUSH
      // 2) Immediately drain push queue → YNAB API (unless push=false)
      const marked = await sync.categorizeTransaction(body);
      let push;
      if (body.push !== false) {
        push = await sync.pushPending({ limit: 10 });
        console.log(
          JSON.stringify({
            msg: 'categorize→ynab',
            ynabTxnId: body.ynabTxnId,
            categoryYnabId: body.categoryYnabId,
            pushed: push?.pushed ?? 0,
            failed: push?.failed ?? 0,
            results: (push?.results || []).slice(0, 5),
          }),
        );
        const failedForTxn = (push?.results || []).find(
          (r) =>
            r &&
            r.ok === false &&
            (r.ynabTxnId === body.ynabTxnId ||
              String(r.sk || '').includes(body.ynabTxnId)),
        );
        if (failedForTxn || (push?.failed > 0 && push?.pushed === 0)) {
          return respond(502, {
            error:
              failedForTxn?.error ||
              push?.error ||
              'Category saved in R2Finance but YNAB push failed',
            marked,
            push,
          });
        }
      }
      return respond(200, { marked, push });
    }

    if (method === 'POST' && path === '/v1/transactions/approve') {
      const body = parseBody(event);
      if (!body.ynabTxnId) {
        return respond(400, { error: 'ynabTxnId required' });
      }
      const marked = await sync.approveTransaction(body);
      let push;
      if (body.push !== false) {
        push = await sync.pushPending({ limit: 5 });
      }
      return respond(200, { marked, push });
    }

    if (method === 'GET' && path === '/v1/inbox') {
      return respond(200, await sync.listInbox());
    }

    // Stamp Plaid match + location on new spends / inbox (admin or any session).
    if (method === 'POST' && path === '/v1/sync/enrich-plaid') {
      const plaidEnrich = require('../lib/plaidEnrich');
      const body = parseBody(event);
      if (body?.inboxOnly) {
        return respond(200, {
          ok: true,
          result: await plaidEnrich.enrichInboxNeedsAttention(body),
        });
      }
      if (body?.newOnly) {
        return respond(200, {
          ok: true,
          result: await plaidEnrich.enrichNewSpending(body),
        });
      }
      return respond(200, {
        ok: true,
        result: await plaidEnrich.enrichAfterPull(body),
      });
    }

    if (method === 'GET' && path === '/v1/accounts') {
      const items = await ddb.queryPk(ddb.planPk(), 'ACCT#');
      return respond(200, {
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
      const { colorForCategory } = require('../lib/categoryColors');
      const groups = await ddb.queryPk(ddb.planPk(), 'CGRP#');
      const cats = await ddb.queryPk(ddb.planPk(), 'CAT#');
      const backfill = [];
      const categories = cats
        .filter((c) => !c.deleted)
        .map((c) => {
          let color = c.color;
          if (!color) {
            color = colorForCategory({ name: c.name, ynabId: c.ynabId });
            backfill.push({ ...c, color, updatedAt: Date.now() });
          }
          return {
            ynabId: c.ynabId,
            name: c.name,
            categoryGroupId: c.categoryGroupId,
            hidden: c.hidden ?? false,
            color,
          };
        });
      if (backfill.length) {
        await ddb.batchWrite(backfill);
      }
      return respond(200, {
        groups: groups
          .filter((g) => !g.deleted)
          .map((g) => ({
            ynabId: g.ynabId,
            name: g.name,
            hidden: g.hidden ?? false,
          })),
        categories,
      });
    }

    if (method === 'GET' && path === '/v1/payees') {
      const items = await ddb.queryPk(ddb.planPk(), 'PAYEE#');
      return respond(200, {
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
      // Optional since= for lightweight delta (prefer GET /v1/sync/changes).
      const qs = event?.queryStringParameters || {};
      const sinceMs = Math.max(0, Number(qs.since) || 0);
      const items = await ddb.queryPk(ddb.planPk(), 'TXN#');
      const filtered = items.filter((t) => {
        if (sinceMs > 0) {
          // Delta: include tombstones so clients can soft-delete locally.
          return (Number(t.updatedAt) || 0) > sinceMs;
        }
        return !t.deleted;
      });
      return respond(200, {
        transactions: filtered.map((t) => sync.mapTxn(t)),
        since: sinceMs || undefined,
        mode: sinceMs > 0 ? 'delta' : 'full',
      });
    }

    if (method === 'GET' && path === '/v1/plan') {
      const meta = await ddb.getItem(ddb.planPk(), 'META');
      return respond(200, {
        plan: {
          name: meta?.payload?.name || meta?.name || 'Plan',
          ynabPlanId: meta?.ynabPlanId || meta?.payload?.ynabPlanId,
          currency: meta?.payload?.currency || 'USD',
          serverKnowledge: meta?.serverKnowledge ?? 0,
        },
      });
    }

    // ── Bank connectors (Plaid) — per signed-in email ─────────────────
    // Access only — never write bank transactions into DDB ledger TXN#.
    // Supported banks: boa, chase, vanguard, venmo (see connectors.BANKS).
    // Each household member has their own set (2× each bank type).
    // Accounts UI reads CONNECTOR cache (balances); live Plaid only on
    // explicit refresh / Link exchange / enrich (transactions match).
    if (method === 'GET' && path === '/v1/connectors') {
      const qs = event?.queryStringParameters || {};
      if (qs.household === '1' || qs.household === 'true') {
        return respond(200, await connectors.listHousehold({ email: session.email }));
      }
      return respond(200, await connectors.listStatus({ email: session.email }));
    }

    // Probe every connected bank for this user → write balances to cache.
    if (method === 'POST' && path === '/v1/connectors/refresh-balances') {
      return respond(
        200,
        await connectors.refreshAllBalances({ email: session.email }),
      );
    }

    const connectorMatch = path.match(
      /^\/v1\/connectors\/([a-z0-9_-]+)(?:\/(link-token|exchange|accounts|disconnect))?$/,
    );
    if (connectorMatch) {
      const bankId = connectorMatch[1];
      const action = connectorMatch[2] || null;
      const qs = event?.queryStringParameters || {};

      if (method === 'GET' && !action) {
        return respond(
          200,
          await connectors.status(bankId, { email: session.email }),
        );
      }

      if (method === 'POST' && action === 'link-token') {
        const bank = connectors.resolveBank(bankId);
        const out = await connectors.createLinkToken(bankId, {
          email: session.email,
        });
        return respond(200, {
          link_token: out.link_token,
          expiration: out.expiration,
          request_id: out.request_id,
          connectorId: bank.id,
          institution: bank.name,
          email: session.email,
        });
      }

      if (method === 'POST' && action === 'exchange') {
        const body = parseBody(event);
        const result = await connectors.exchangeAndStore(bankId, {
          publicToken: body.public_token || body.publicToken,
          email: session.email,
          metadata: body.metadata || null,
        });
        return respond(200, result);
      }

      // Default: connector cache (no Plaid). ?live=1 / ?probe=1 hits Plaid.
      if (method === 'GET' && action === 'accounts') {
        const live =
          qs.live === '1' ||
          qs.live === 'true' ||
          qs.probe === '1' ||
          qs.probe === 'true';
        if (live) {
          return respond(
            200,
            await connectors.probeAccounts(bankId, { email: session.email }),
          );
        }
        return respond(
          200,
          await connectors.cachedAccounts(bankId, { email: session.email }),
        );
      }

      if (method === 'POST' && action === 'disconnect') {
        return respond(
          200,
          await connectors.disconnect(bankId, { email: session.email }),
        );
      }
    }

    return respond(404, { error: 'not_found', path, method });
  } catch (e) {
    const status = e.status && Number.isInteger(e.status) ? e.status : 500;
    // Expected auth failures stay quiet; real faults are logged.
    if (status >= 500) {
      console.error(e);
    } else if (status !== 401 && status !== 403) {
      console.warn(e.message || e);
    }
    return respond(status, {
      error: e.message || String(e),
      code: e.code || undefined,
    });
  }
};

// Exported for unit tests
exports.isPublicRoute = isPublicRoute;
exports.PUBLIC_ROUTES = PUBLIC_ROUTES;
exports.CORS_ORIGINS = CORS_ORIGINS;
