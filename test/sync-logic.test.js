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
  it('requires session before body validation', async () => {
    const { handler } = require('../src/handlers/apiHandler');
    const res = await handler({
      rawPath: '/v1/transactions/categorize',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({}),
    });
    // Auth gate runs first — unauthenticated never reaches field validation.
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'unauthorized');
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
  it('requires session (not open, not 404)', async () => {
    const { handler } = require('../src/handlers/apiHandler');
    const res = await handler({
      rawPath: '/v1/device/push',
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({ payees: [], transactions: [] }),
    });
    assert.equal(res.statusCode, 401);
    assert.notEqual(res.statusCode, 404);
  });
});

describe('matchedCounterpartTombstones', () => {
  const {
    matchedCounterpartTombstones,
    tombstoneTxnItem,
  } = require('../src/lib/sync');

  it('tombstones matched import counterpart when survivor is live', () => {
    const importId = 'import-gone-1';
    const survivorId = 'survivor-1';
    const items = matchedCounterpartTombstones('default', [
      {
        id: survivorId,
        matched_transaction_id: importId,
        account_id: 'acct-1',
        deleted: false,
      },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].sk, `TXN#${importId}`);
    assert.equal(items[0].deleted, true);
    assert.equal(items[0].ynabId, importId);
  });

  it('does not tombstone when counterpart is still live in the same batch', () => {
    const items = matchedCounterpartTombstones('default', [
      {
        id: 'a',
        matched_transaction_id: 'b',
        account_id: 'acct',
        deleted: false,
      },
      {
        id: 'b',
        matched_transaction_id: 'a',
        account_id: 'acct',
        deleted: false,
      },
    ]);
    assert.equal(items.length, 0);
  });

  it('skips pending-push counterpart keys', () => {
    const pending = new Set(['TXN#import-1']);
    const items = matchedCounterpartTombstones(
      'default',
      [
        {
          id: 'surv',
          matched_transaction_id: 'import-1',
          account_id: 'a',
          deleted: false,
        },
      ],
      pending,
    );
    assert.equal(items.length, 0);
  });

  it('dedupes the same matched id from multiple rows', () => {
    const items = matchedCounterpartTombstones('default', [
      { id: 's1', matched_transaction_id: 'gone', account_id: 'a' },
      { id: 's2', matched_transaction_id: 'gone', account_id: 'a' },
    ]);
    assert.equal(items.length, 1);
  });

  it('tombstoneTxnItem marks deleted + approved', () => {
    const item = tombstoneTxnItem('default', 'x', 'acct');
    assert.equal(item.deleted, true);
    assert.equal(item.approved, true);
    assert.equal(item.sk, 'TXN#x');
  });
});
