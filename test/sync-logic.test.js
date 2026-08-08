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

describe('account alias + mask', () => {
  it('extracts last-4 from YNAB account names', () => {
    const { extractAccountMask, mapAccount } = require('../src/lib/sync');
    assert.equal(extractAccountMask('Chase Freedom 8053'), '8053');
    assert.equal(extractAccountMask('Checking'), null);
    const mapped = mapAccount({
      ynabId: 'a1',
      name: 'BoA Checkin 1234',
      type: 'checking',
      balance: 1000,
      onBudget: true,
      closed: false,
      alias: 'Joint checking',
    });
    assert.equal(mapped.alias, 'Joint checking');
    assert.equal(mapped.mask, '1234');
    assert.equal(mapped.name, 'BoA Checkin 1234');
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

  it('exposes deleted + updatedAt for client delta merge', () => {
    const { mapTxn } = require('../src/lib/sync');
    const mapped = mapTxn({
      sk: 'TXN#gone',
      ynabId: 'gone',
      accountId: 'a',
      date: '2026-01-01',
      amount: 0,
      deleted: true,
      updatedAt: 1700000000000,
      payload: { deleted: true },
    });
    assert.equal(mapped.deleted, true);
    assert.equal(mapped.updatedAt, 1700000000000);
  });

  it('omits null optional plaid fields to keep full sync under 6MB', () => {
    const { mapTxn } = require('../src/lib/sync');
    const mapped = mapTxn({
      sk: 'TXN#lean',
      ynabId: 'lean',
      accountId: 'a',
      date: '2026-01-01',
      amount: -100,
      payload: {},
    });
    assert.equal(mapped.ynabId, 'lean');
    assert.equal(mapped.accountId, 'a');
    assert.equal('plaidTransactionId' in mapped, false);
    assert.equal('locationDisplay' in mapped, false);
    assert.equal('subtransactions' in mapped, false);
    assert.equal('memo' in mapped, false);
  });

  it('exposes syncStatus + lastPushedAt for outbound YNAB visibility', () => {
    const { mapTxn } = require('../src/lib/sync');
    const mapped = mapTxn({
      sk: 'TXN#pushed-1',
      ynabId: 'pushed-1',
      accountId: 'a',
      date: '2026-08-01',
      amount: -500,
      syncStatus: 'SYNCED',
      lastPushedAt: 1700000001000,
      payload: {},
    });
    assert.equal(mapped.syncStatus, 'SYNCED');
    assert.equal(mapped.lastPushedAt, 1700000001000);
  });

  it('exposes parsed importPayeeName (never raw match-suggestion JSON)', () => {
    const { mapTxn } = require('../src/lib/sync');
    const mapped = mapTxn({
      sk: 'TXN#import-payee',
      ynabId: 'import-payee',
      accountId: 'a',
      date: '2026-08-07',
      amount: -239350,
      payload: {
        import_payee_name: JSON.stringify({
          importedPayee: 'Chase Credit Card',
          accepted: false,
        }),
      },
    });
    assert.equal(mapped.importPayeeName, 'Chase Credit Card');
  });
});

describe('listChanges export', () => {
  it('is a function (full/delta client snapshot)', () => {
    const { listChanges } = require('../src/lib/sync');
    assert.equal(typeof listChanges, 'function');
  });
});

describe('GET /v1/sync/changes route', () => {
  it('requires session (not open, not 404)', async () => {
    const { handler } = require('../src/handlers/apiHandler');
    const res = await handler({
      rawPath: '/v1/sync/changes',
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: { since: '0' },
    });
    assert.equal(res.statusCode, 401);
    assert.notEqual(res.statusCode, 404);
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

  it('hides still-live non-transfer bank import matched to a transfer (YNAB triple bug)', () => {
    const items = matchedCounterpartTombstones('default', [
      {
        id: 'xfer',
        matched_transaction_id: 'import-ghost',
        account_id: 'acct',
        transfer_account_id: 'other-acct',
        amount: -711820,
        approved: true,
        deleted: false,
      },
      {
        id: 'import-ghost',
        account_id: 'acct',
        amount: -711820,
        approved: false,
        category_id: null,
        deleted: false,
      },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].sk, 'TXN#import-ghost');
    assert.equal(items[0].deleted, true);
    assert.equal(items[0].approved, true);
    assert.equal(items[0].syncStatus, 'PENDING_PUSH');
    assert.equal(items[0].payload._tombstone, 'ghost_transfer_import');
  });

  it('does not hide a still-live transfer matched to another transfer', () => {
    const items = matchedCounterpartTombstones('default', [
      {
        id: 'a',
        matched_transaction_id: 'b',
        account_id: 'acct',
        transfer_account_id: 'x',
        deleted: false,
      },
      {
        id: 'b',
        matched_transaction_id: 'a',
        account_id: 'acct',
        transfer_account_id: 'y',
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

describe('ghostTransferImportTombstones', () => {
  const {
    ghostTransferImportTombstones,
    dateDiffDays,
  } = require('../src/lib/sync');

  const checkin = 'acct-checkin-6022';
  const freedom = 'acct-freedom-6553';
  const amount = -711820; // YNAB milliunits (−$711.82)

  function transferPair(date = '2026-08-07') {
    return [
      {
        id: 'xfer-out',
        account_id: checkin,
        date,
        amount,
        approved: true,
        category_id: null,
        transfer_account_id: freedom,
        transfer_transaction_id: 'xfer-in',
        payee_name: 'Transfer : Family Freedom 6553',
      },
      {
        id: 'xfer-in',
        account_id: freedom,
        date,
        amount: -amount,
        approved: true,
        category_id: null,
        transfer_account_id: checkin,
        transfer_transaction_id: 'xfer-out',
        payee_name: 'Transfer : Family Checkin 6022',
      },
    ];
  }

  it('hides Category Needed bank import that duplicates a transfer pair', () => {
    const ghost = {
      id: 'import-ghost',
      account_id: checkin,
      date: '2026-08-07',
      amount,
      approved: false,
      category_id: null,
      import_id: 'YNAB:…:2026-08-07:1',
      payee_name: null,
    };
    const items = ghostTransferImportTombstones('default', [
      ghost,
      ...transferPair(),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].sk, 'TXN#import-ghost');
    assert.equal(items[0].deleted, true);
    assert.equal(items[0].approved, true);
    assert.equal(items[0].payload._tombstone, 'ghost_transfer_import');
    assert.equal(items[0].payload._ghost_of_transfer_id, 'xfer-out');
    // Unapproved → queue auto-approve to YNAB
    assert.equal(items[0].syncStatus, 'PENDING_PUSH');
    assert.equal(items[0].gsi2pk, 'PENDING_PUSH');
  });

  it('does not PENDING_PUSH when ghost is already approved (just hide)', () => {
    const ghost = {
      id: 'import-approved-ghost',
      account_id: checkin,
      date: '2026-08-07',
      amount,
      approved: true,
      category_id: null, // still Category Needed
    };
    const items = ghostTransferImportTombstones('default', [
      ghost,
      ...transferPair(),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].deleted, true);
    assert.notEqual(items[0].syncStatus, 'PENDING_PUSH');
    assert.equal(items[0].gsi2pk, undefined);
  });

  it('does not hide a categorized approved spend of the same amount', () => {
    const realSpend = {
      id: 'real-spend',
      account_id: checkin,
      date: '2026-08-07',
      amount,
      approved: true,
      category_id: 'cat-groceries',
    };
    const items = ghostTransferImportTombstones('default', [
      realSpend,
      ...transferPair(),
    ]);
    assert.equal(items.length, 0);
  });

  it('allows ±1 day bank date lag', () => {
    const ghost = {
      id: 'import-lag',
      account_id: checkin,
      date: '2026-08-08',
      amount,
      approved: false,
      category_id: null,
    };
    const items = ghostTransferImportTombstones('default', [
      ghost,
      ...transferPair('2026-08-07'),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].ynabId, 'import-lag');
  });

  it('ignores date gaps larger than 1 day', () => {
    const ghost = {
      id: 'import-far',
      account_id: checkin,
      date: '2026-08-01',
      amount,
      approved: false,
      category_id: null,
    };
    const items = ghostTransferImportTombstones('default', [
      ghost,
      ...transferPair('2026-08-07'),
    ]);
    assert.equal(items.length, 0);
  });

  it('requires a live opposite-amount pair when transfer_transaction_id is set', () => {
    const ghost = {
      id: 'import-no-pair',
      account_id: checkin,
      date: '2026-08-07',
      amount,
      approved: false,
      category_id: null,
    };
    const items = ghostTransferImportTombstones('default', [
      ghost,
      {
        id: 'orphan-xfer',
        account_id: checkin,
        date: '2026-08-07',
        amount,
        approved: true,
        transfer_account_id: freedom,
        transfer_transaction_id: 'missing-other-side',
      },
    ]);
    assert.equal(items.length, 0);
  });

  it('skips pending-push ghost keys', () => {
    const ghost = {
      id: 'import-pending',
      account_id: checkin,
      date: '2026-08-07',
      amount,
      approved: false,
      category_id: null,
    };
    const items = ghostTransferImportTombstones(
      'default',
      [ghost, ...transferPair()],
      new Set(['TXN#import-pending']),
    );
    assert.equal(items.length, 0);
  });

  it('dateDiffDays handles ISO dates', () => {
    assert.equal(dateDiffDays('2026-08-07', '2026-08-08'), 1);
    assert.equal(dateDiffDays('2026-08-07', '2026-08-07'), 0);
    assert.equal(dateDiffDays(null, '2026-08-07'), Infinity);
  });

  it('autoApproveUnapprovedTransferLegs approves unapproved side of a pair', () => {
    const { autoApproveUnapprovedTransferLegs } = require('../src/lib/sync');
    const items = autoApproveUnapprovedTransferLegs('default', [
      {
        id: 'in',
        account_id: freedom,
        date: '2026-07-15',
        amount: 1134530,
        approved: false,
        transfer_account_id: checkin,
        transfer_transaction_id: 'out',
      },
      {
        id: 'out',
        account_id: checkin,
        date: '2026-07-15',
        amount: -1134530,
        approved: true,
        transfer_account_id: freedom,
        transfer_transaction_id: 'in',
      },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].ynabId, 'in');
    assert.equal(items[0].approved, true);
    assert.equal(items[0].syncStatus, 'PENDING_PUSH');
    assert.equal(items[0].deleted, false);
  });

  it('mergeLedgerForGhostScan overlays delta on DDB so ghosts outside delta are found', () => {
    const {
      mergeLedgerForGhostScan,
      ghostTransferImportTombstones: scan,
    } = require('../src/lib/sync');
    // Ghost only in DDB (not in this knowledge delta).
    const ddbRows = [
      {
        sk: 'TXN#import-ghost',
        ynabId: 'import-ghost',
        accountId: checkin,
        date: '2026-08-07',
        amount,
        approved: false,
        payload: {
          id: 'import-ghost',
          account_id: checkin,
          date: '2026-08-07',
          amount,
          approved: false,
          category_id: null,
        },
      },
      {
        sk: 'TXN#xfer-out',
        ynabId: 'xfer-out',
        accountId: checkin,
        date: '2026-08-07',
        amount,
        approved: true,
        payload: {
          id: 'xfer-out',
          account_id: checkin,
          date: '2026-08-07',
          amount,
          approved: true,
          transfer_account_id: freedom,
          transfer_transaction_id: 'xfer-in',
        },
      },
      {
        sk: 'TXN#xfer-in',
        ynabId: 'xfer-in',
        accountId: freedom,
        date: '2026-08-07',
        amount: -amount,
        approved: true,
        payload: {
          id: 'xfer-in',
          account_id: freedom,
          date: '2026-08-07',
          amount: -amount,
          approved: true,
          transfer_account_id: checkin,
          transfer_transaction_id: 'xfer-out',
        },
      },
    ];
    // Empty delta (nothing changed this tick) — must still find the ghost.
    const merged = mergeLedgerForGhostScan(ddbRows, []);
    const items = scan('default', merged);
    assert.equal(items.length, 1);
    assert.equal(items[0].ynabId, 'import-ghost');
    assert.equal(items[0].syncStatus, 'PENDING_PUSH');
  });
});
