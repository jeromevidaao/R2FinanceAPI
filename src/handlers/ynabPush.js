'use strict';

const sync = require('../lib/sync');

/** R2FinanceYnabPush — drain PENDING_PUSH → YNAB. */
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'R2FinanceYnabPush start' }));
  const result = await sync.pushPending({
    limit: event?.limit || 40,
  });
  console.log(JSON.stringify(result));
  return { ok: true, ...result };
};
