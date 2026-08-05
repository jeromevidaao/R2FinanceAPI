const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fcm = require('../src/lib/fcm');

describe('fcm helpers', () => {
  it('maskEmail hides local-part middle', () => {
    assert.equal(fcm.maskEmail('jerome.ans@gmail.com'), 'j…@gmail.com');
    assert.equal(fcm.maskEmail('ab@x.com'), 'a…@x.com');
  });

  it('TOPIC defaults to r2finance_updates', () => {
    assert.equal(fcm.TOPIC, 'r2finance_updates');
  });

  it('notifySignIn is non-fatal without SSM (skipped or soft-fail)', async () => {
    const result = await fcm.notifySignIn({
      email: 'jerome.ans@gmail.com',
      client: 'web',
    });
    assert.equal(typeof result.ok, 'boolean');
    // Local/unit: usually not_configured; never throws
    assert.ok(result.skipped || result.ok === false || result.ok === true);
  });
});
