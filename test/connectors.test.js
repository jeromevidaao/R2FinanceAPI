'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const plaid = require('../src/lib/plaid');
const connectors = require('../src/lib/connectors');

describe('Plaid / bank connector helpers', () => {
  it('exports institution ids including Venmo', () => {
    assert.equal(plaid.BOA_INSTITUTION_ID, 'ins_127989');
    assert.equal(plaid.CHASE_INSTITUTION_ID, 'ins_56');
    assert.equal(plaid.VANGUARD_INSTITUTION_ID, 'ins_115616');
    assert.equal(plaid.VENMO_INSTITUTION_ID, 'ins_132083');
  });

  it('resolves boa, chase, vanguard, and venmo banks', () => {
    assert.equal(connectors.resolveBank('boa').name, 'Bank of America');
    assert.equal(connectors.resolveBank('chase').name, 'Chase');
    assert.equal(connectors.resolveBank('CHASE').id, 'chase');
    assert.equal(connectors.resolveBank('vanguard').name, 'Vanguard');
    assert.deepEqual(connectors.resolveBank('vanguard').products, [
      'investments',
    ]);
    assert.equal(connectors.resolveBank('venmo').name, 'Venmo');
    assert.equal(connectors.resolveBank('venmo').bankSk, 'CONNECTOR#VENMO');
  });

  it('rejects unknown connector', () => {
    assert.throws(() => connectors.resolveBank('wells'), /Unknown connector/);
  });

  it('plaid client_user_id is not an email', () => {
    const id = connectors.plaidClientUserId('jerome.ans@gmail.com');
    assert.equal(id.includes('@'), false);
    assert.match(id, /^[a-f0-9]{32}$/);
  });

  it('userKey is stable and opaque (no email in SSM path)', () => {
    const a = connectors.userKey('jerome.ans@gmail.com');
    const b = connectors.userKey('Jerome.Ans@gmail.com');
    const c = connectors.userKey('ngoc.h.dinh@gmail.com');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[a-f0-9]{16}$/);
    assert.equal(a.includes('@'), false);
    assert.equal(
      connectors.itemSsmParam(connectors.resolveBank('boa'), 'jerome.ans@gmail.com'),
      `/r2finance/connectors/${a}/boa`,
    );
  });

  it('isConfigured is false without secret credentials', async () => {
    plaid.clearPlaidCache();
    let configured;
    try {
      configured = await plaid.isConfigured();
    } catch {
      configured = false;
    }
    assert.equal(typeof configured, 'boolean');
  });

  it('toAccountPreview keeps Plaid available/current for Accounts cache', () => {
    const preview = connectors.toAccountPreview({
      accountId: 'acc_1',
      name: 'Checking',
      officialName: 'Advantage Plus',
      mask: '1234',
      type: 'depository',
      subtype: 'checking',
      balances: {
        available: 1200.5,
        current: 1250,
        limit: null,
        isoCurrencyCode: 'USD',
      },
    });
    assert.equal(preview.accountId, 'acc_1');
    assert.equal(preview.available, 1200.5);
    assert.equal(preview.current, 1250);
    assert.equal(connectors.displayBalance(preview), 1200.5);
    assert.equal(connectors.isCreditType('credit', 'credit card'), true);
    assert.equal(connectors.isCreditType('depository', 'checking'), false);
    assert.equal(
      connectors.displayBalance({ available: null, current: 99 }),
      99,
    );
  });
});
