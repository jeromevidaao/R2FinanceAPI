'use strict';

module.exports = {
  region: process.env.AWS_REGION || 'us-east-1',
  tableName: process.env.R2FINANCE_TABLE || 'R2Finance',
  secretId: process.env.YNAB_SECRET_ID || 'R2Finance/ynab-pat',
  ynabBase: process.env.YNAB_API_BASE || 'https://api.ynab.com/v1',
  /** Ledger plan id for single-plan personal use (stable). */
  ledgerPlanId: process.env.R2FINANCE_PLAN_ID || 'default',
  gsi1: 'R2Finance-GSI1-YnabId',
  gsi2: 'R2Finance-GSI2-UpdatedAt',
  /** Public website used in password-reset emails. */
  websiteBaseUrl:
    process.env.R2FINANCE_WEBSITE_URL || 'https://finance.i-liquid.be',
  /** Verified SES identity (From). */
  resetFromEmail: process.env.R2FINANCE_RESET_FROM || 'no-reply@i-liquid.be',
  /** Password-reset token lifetime (ms). */
  resetTokenTtlMs: Number(process.env.R2FINANCE_RESET_TTL_MS || 60 * 60 * 1000),
  /** Plaid API credentials secret (JSON: client_id, secret, env). */
  plaidSecretId: process.env.PLAID_SECRET_ID || 'R2Finance/plaid',
  /** Plaid env fallback if secret omits env. */
  plaidEnv: process.env.PLAID_ENV || 'sandbox',
  /** Connected Bank of America item access_token secret. */
  boaItemSecretId:
    process.env.BOA_ITEM_SECRET_ID || 'R2Finance/connectors/boa',
};
