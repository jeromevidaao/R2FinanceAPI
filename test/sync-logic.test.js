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

describe('mapTxn stable client id', () => {
  it('prefers clientId as stable id for device-created rows', () => {
    const { mapTxn } = require('../src/lib/sync');
    const mapped = mapTxn({
      sk: 'TXN#phone-uuid-1',
      clientId: 'phone-uuid-1',
      ynabId: 'ynab-real-9',
      accountId: 'acct-1',
      date: '2026-08-04',
      amount: -1000,
      payload: { client_id: 'phone-uuid-1', account_id: 'acct-1' },
    });
    assert.equal(mapped.id, 'phone-uuid-1');
    assert.equal(mapped.clientId, 'phone-uuid-1');
    assert.equal(mapped.ynabId, 'ynab-real-9');
  });

  it('falls back to ynabId when no clientId', () => {
    const { mapTxn } = require('../src/lib/sync');
    const mapped = mapTxn({
      sk: 'TXN#ynab-1',
      ynabId: 'ynab-1',
      accountId: 'a',
      date: '2026-01-01',
      amount: 0,
      payload: {},
    });
    assert.equal(mapped.id, 'ynab-1');
    assert.equal(mapped.ynabId, 'ynab-1');
  });
});

describe('device/push route exists', () => {
  it('is registered (not 404 for empty body — may 500 without AWS)', async () => {
    const { handler } = require('../src/handlers/apiHandler');
    const res = await handler({
      rawPath: '/v1/device/push',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ payees: [], transactions: [] }),
    });
    // Without AWS creds this may 500; must not be not_found.
    assert.notEqual(res.statusCode, 404);
  });
});
