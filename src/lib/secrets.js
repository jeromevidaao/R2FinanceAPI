'use strict';

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');
const { region, secretId } = require('./config');

const client = new SecretsManagerClient({ region });
let cached;

async function getYnabToken() {
  if (cached) return cached;
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const raw = out.SecretString || '';
  // Allow plain string or {"token":"..."}
  try {
    const j = JSON.parse(raw);
    cached = (j.token || j.pat || j.access_token || raw).trim();
  } catch {
    cached = raw.trim();
  }
  if (!cached) throw new Error('YNAB secret empty');
  return cached;
}

function clearTokenCache() {
  cached = undefined;
}

module.exports = { getYnabToken, clearTokenCache };
