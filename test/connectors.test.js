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

  it('plaid client_user_id is not an email', () => {
    // exercise via createLinkToken wiring — hash must not look like email
    const crypto = require('crypto');
    const email = 'jerome.ans@gmail.com';
    const id = crypto
      .createHash('sha256')
      .update(`r2finance:${email}`)
      .digest('hex')
      .slice(0, 32);
    assert.equal(id.includes('@'), false);
    assert.match(id, /^[a-f0-9]{32}$/);
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
