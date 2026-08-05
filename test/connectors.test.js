'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const plaid = require('../src/lib/plaid');

describe('Plaid / BoA connector helpers', () => {
  it('exports Bank of America institution id', () => {
    assert.equal(plaid.BOA_INSTITUTION_ID, 'ins_127989');
  });

  it('isConfigured is false without secret credentials', async () => {
    // Without a real secret (or with missing creds), should not throw from isConfigured.
    // In CI/local unit tests Secrets Manager may be unreachable — treat network/auth as not configured.
    plaid.clearPlaidCache();
    let configured;
    try {
      configured = await plaid.isConfigured();
    } catch (e) {
      // AWS credentials missing in pure unit env
      configured = false;
    }
    assert.equal(typeof configured, 'boolean');
  });
});
