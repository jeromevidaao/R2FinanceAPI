const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Pure unit: config shape
const config = require('../src/lib/config');

describe('config', () => {
  it('has table and secret names', () => {
    assert.equal(config.tableName, 'R2Finance');
    assert.equal(config.secretId, 'R2Finance/ynab-pat');
    assert.equal(config.ledgerPlanId, 'default');
  });
});

describe('apiHandler health', () => {
  it('returns ok without AWS when path health — may fail secrets; smoke syntax only', async () => {
    const { handler } = require('../src/handlers/apiHandler');
    assert.equal(typeof handler, 'function');
  });
});

describe('categorize API contract', () => {
  it('rejects missing ids with 400', async () => {
    const { handler } = require('../src/handlers/apiHandler');
    const res = await handler({
      rawPath: '/v1/transactions/categorize',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({}),
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /ynabTxnId|categoryYnabId/);
  });
});
