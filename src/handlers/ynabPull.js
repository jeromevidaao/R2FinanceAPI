'use strict';

const sync = require('../lib/sync');

/**
 * R2FinanceYnabPull — EventBridge schedule → delta pull YNAB → DDB.
 * Also runs push so categorize round-trips in one tick.
 */
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'R2FinanceYnabPull start', eventKeys: Object.keys(event || {}) }));
  const pull = await sync.deltaPull();
  let push;
  try {
    push = await sync.pushPending({ limit: 40 });
  } catch (e) {
    push = { error: e.message };
  }
  const result = { ok: true, pull, push };
  console.log(JSON.stringify(result));
  return result;
};
