'use strict';

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { region, resetFromEmail } = require('./config');

const ses = new SESClient({ region });

/**
 * Send a transactional email via SES.
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 */
async function sendEmail({ to, subject, text, html }) {
  const from = resetFromEmail;
  await ses.send(
    new SendEmailCommand({
      Source: `R2Finance <${from}>`,
      Destination: { ToAddresses: [to] },
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
