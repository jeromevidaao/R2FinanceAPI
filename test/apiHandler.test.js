const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  handler,
  isPublicRoute,
  PUBLIC_ROUTES,
} = require('../src/handlers/apiHandler');
const auth = require('../src/lib/auth');

describe('R2FinanceApiHandler', () => {
  it('health returns ok without auth', async () => {
    const res = await handler({
      rawPath: '/health',
      requestContext: { http: { method: 'GET' } },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'R2FinanceAPI');
    assert.equal(body.table, 'R2Finance');
  });

  it('unknown path is 401 without session (default deny)', async () => {
    const res = await handler({
      rawPath: '/nope',
      requestContext: { http: { method: 'GET' } },
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'unauthorized');
  });

  it('ledger endpoints reject unauthenticated callers', async () => {
    const paths = [
      ['GET', '/v1/accounts'],
      ['PATCH', '/v1/accounts/some-id'],
      ['POST', '/v1/accounts/some-id'],
      ['GET', '/v1/transactions'],
      ['GET', '/v1/categories'],
      ['GET', '/v1/payees'],
      ['GET', '/v1/plan'],
      ['GET', '/v1/inbox'],
      ['GET', '/v1/stats'],
      ['POST', '/v1/sync/tick'],
      ['POST', '/v1/sync/pull'],
      ['POST', '/v1/sync/push'],
      ['POST', '/v1/device/push'],
      ['POST', '/v1/transactions/categorize'],
      ['POST', '/v1/transactions/approve'],
      ['GET', '/v1/connectors'],
      ['GET', '/v1/auth/me'],
      ['POST', '/v1/auth/invite'],
    ];
    for (const [method, path] of paths) {
      const res = await handler({
        rawPath: path,
        requestContext: { http: { method } },
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(
        res.statusCode,
        401,
        `${method} ${path} should be 401 without session, got ${res.statusCode}`,
      );
    }
  });

  it('invalid bearer token is rejected on ledger', async () => {
    const res = await handler({
      rawPath: '/v1/accounts',
      requestContext: { http: { method: 'GET' } },
      headers: { authorization: 'Bearer not-a-real-session-token' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('public auth routes stay public (no session required for path gate)', () => {
    const publicOnes = [
      ['POST', '/v1/auth/login'],
      ['POST', '/v1/auth/forgot-password'],
      ['POST', '/v1/auth/reset-password'],
      ['POST', '/v1/auth/status'],
      ['POST', '/v1/auth/set-password'],
      ['POST', '/v1/auth/mfa/verify'],
      ['POST', '/v1/auth/mfa/setup'],
      ['POST', '/v1/auth/mfa/enable'],
      ['POST', '/v1/auth/bootstrap'],
      ['GET', '/health'],
      ['GET', '/'],
    ];
    for (const [method, path] of publicOnes) {
      assert.equal(
        isPublicRoute(method, path),
        true,
        `${method} ${path} must stay public`,
      );
    }
    assert.equal(isPublicRoute('GET', '/v1/accounts'), false);
    assert.equal(isPublicRoute('POST', '/v1/sync/tick'), false);
    assert.ok(PUBLIC_ROUTES.size >= 10);
  });

  it('allow-list is exactly Jerome and Ngoc', () => {
    assert.deepEqual(auth.ALLOWED_EMAILS, [
      'jerome.ans@gmail.com',
      'ngoc.h.dinh@gmail.com',
    ]);
    assert.equal(auth.isAllowedEmail('jerome.ans@gmail.com'), true);
    assert.equal(auth.isAllowedEmail('Jerome.Ans@Gmail.com'), true);
    assert.equal(auth.isAllowedEmail('ngoc.h.dinh@gmail.com'), true);
    assert.equal(auth.isAllowedEmail('stranger@gmail.com'), false);
    assert.equal(auth.isAllowedEmail(''), false);
  });

  it('CORS allows finance.i-liquid.be origin', async () => {
    const res = await handler({
      rawPath: '/health',
      requestContext: { http: { method: 'GET' } },
      headers: { origin: 'https://finance.i-liquid.be' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers['access-control-allow-origin'],
      'https://finance.i-liquid.be',
    );
  });

  it('CORS rejects random browser origins (falls back to site, not *)', async () => {
    const res = await handler({
      rawPath: '/health',
      requestContext: { http: { method: 'GET' } },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers['access-control-allow-origin'],
      'https://finance.i-liquid.be',
    );
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  });
});
