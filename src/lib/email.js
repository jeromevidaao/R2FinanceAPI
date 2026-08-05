'use strict';

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { region, resetFromEmail } = require('./config');

const ses = new SESClient({ region });

/**
 * Send a transactional email via SES.
 * @param {{ to: string|string[], cc?: string|string[], subject: string, text: string, html?: string }} opts
 */
async function sendEmail({ to, cc, subject, text, html }) {
  const from = resetFromEmail;
  const toList = Array.isArray(to) ? to : [to];
  const ccList = (Array.isArray(cc) ? cc : cc ? [cc] : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter(Boolean)
    .filter((e) => !toList.map((t) => t.toLowerCase()).includes(e));

  // From must be on a verified domain (i-liquid.be + DKIM) — not Gmail.
  await ses.send(
    new SendEmailCommand({
      Source: `R2Finance <${from}>`,
      Destination: {
        ToAddresses: toList,
        ...(ccList.length ? { CcAddresses: ccList } : {}),
      },
      ReplyToAddresses: ['no-reply@i-liquid.be'],
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: text, Charset: 'UTF-8' },
          ...(html
            ? { Html: { Data: html, Charset: 'UTF-8' } }
            : {}),
        },
      },
    }),
  );
}

module.exports = { sendEmail };
