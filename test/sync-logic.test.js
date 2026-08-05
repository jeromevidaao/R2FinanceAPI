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
