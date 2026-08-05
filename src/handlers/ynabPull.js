/**
 * R2FinanceYnabPull — EventBridge → YNAB delta → DynamoDB `R2Finance`.
 * Phase 1 stub (no network).
 */

const RESOURCE = {
  lambda: 'R2FinanceYnabPull',
  schedule: 'R2FinanceYnabPullSchedule',
  table: 'R2Finance',
  secret: 'R2Finance/ynab-pat',
};

exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'R2FinanceYnabPull stub', resource: RESOURCE, eventKeys: Object.keys(event || {}) }));
  return {
    ok: true,
    phase: 1,
    pulled: 0,
    message: 'Implement YNAB GET deltas + DDB upsert in Phase 3',
  };
};
