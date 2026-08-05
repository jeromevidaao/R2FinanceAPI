const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../src/handlers/apiHandler');

describe('R2FinanceApiHandler', () => {
  it('health returns ok', async () => {
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

  it('unknown path is 404', async () => {
    const res = await handler({
      rawPath: '/nope',
      requestContext: { http: { method: 'GET' } },
    });
    assert.equal(res.statusCode, 404);
  });
});
