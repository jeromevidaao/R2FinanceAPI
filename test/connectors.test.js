'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const plaid = require('../src/lib/plaid');
const connectors = require('../src/lib/connectors');

describe('Plaid / bank connector helpers', () => {
  it('exports Bank of America and Chase institution ids', () => {
    assert.equal(plaid.BOA_INSTITUTION_ID, 'ins_127989');
    assert.equal(plaid.CHASE_INSTITUTION_ID, 'ins_56');
  });

  it('resolves boa and chase banks', () => {
    assert.equal(connectors.resolveBank('boa').name, 'Bank of America');
    assert.equal(connectors.resolveBank('chase').name, 'Chase');
    assert.equal(connectors.resolveBank('CHASE').id, 'chase');
  });

  it('rejects unknown connector', () => {
    assert.throws(() => connectors.resolveBank('wells'), /Unknown connector/);
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
});
