#!/usr/bin/env node
/**
 * Create/invite an allowed R2Finance user and email set-password link.
 * Usage: node scripts/invite-user.js ngoc.h.dinh@gmail.com
 */
'use strict';

process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.R2FINANCE_TABLE = process.env.R2FINANCE_TABLE || 'R2Finance';
process.env.R2FINANCE_WEBSITE_URL =
  process.env.R2FINANCE_WEBSITE_URL || 'https://finance.i-liquid.be';
process.env.R2FINANCE_RESET_FROM =
  process.env.R2FINANCE_RESET_FROM || 'no-reply@i-liquid.be';

const auth = require('../src/lib/auth');

async function main() {
  const email = process.argv[2] || 'ngoc.h.dinh@gmail.com';
  if (!auth.isAllowedEmail(email)) {
    console.error(
      `Not on allow-list: ${email}. Allowed: ${auth.ALLOWED_EMAILS.join(', ')}`,
    );
    process.exit(1);
  }
  const result = await auth.inviteUser(email, { ccAdmin: true });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
