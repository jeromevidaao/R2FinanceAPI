/**
 * R2FinanceYnabPush — drain PENDING_PUSH from DDB → YNAB POST/PATCH.
 * Phase 1 stub. Respect 200 req/h rate limit when implemented.
 */

const RESOURCE = {
  lambda: 'R2FinanceYnabPush',
  table: 'R2Finance',
  secret: 'R2Finance/ynab-pat',
  rateLimitPerHour: 200,
};

exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'R2FinanceYnabPush stub', resource: RESOURCE, eventKeys: Object.keys(event || {}) }));
  return {
    ok: true,
    phase: 1,
    pushed: 0,
    message: 'Implement category/txn push + 429 backoff in Phase 3',
  };
};
