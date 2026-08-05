'use strict';

const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
} = require('@aws-sdk/client-secrets-manager');
const { region, secretId } = require('./config');

const client = new SecretsManagerClient({ region });
let cachedYnab;
const jsonCache = new Map();

async function getSecretString(id) {
  const out = await client.send(new GetSecretValueCommand({ SecretId: id }));
  return out.SecretString || '';
}

async function getSecretJson(id, { cache = true } = {}) {
  if (cache && jsonCache.has(id)) return jsonCache.get(id);
  const raw = await getSecretString(id);
  if (!raw) {
    const empty = {};
    if (cache) jsonCache.set(id, empty);
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { value: raw.trim() };
  }
  if (cache) jsonCache.set(id, parsed);
  return parsed;
}

async function putSecretJson(id, obj, { description } = {}) {
  const SecretString = JSON.stringify(obj);
  try {
    await client.send(
      new DescribeSecretCommand({ SecretId: id }),
    );
    await client.send(
      new PutSecretValueCommand({ SecretId: id, SecretString }),
    );
  } catch (e) {
    if (e.name === 'ResourceNotFoundException' || e.__type?.includes('ResourceNotFound')) {
      await client.send(
        new CreateSecretCommand({
          Name: id,
          Description: description || `R2Finance secret ${id}`,
          SecretString,
          Tags: [{ Key: 'Project', Value: 'R2Finance' }],
        }),
      );
    } else {
      throw e;
    }
  }
  jsonCache.set(id, obj);
  return obj;
}

async function deleteSecret(id, { force = true } = {}) {
  try {
    await client.send(
      new DeleteSecretCommand({
        SecretId: id,
        ForceDeleteWithoutRecovery: force,
      }),
    );
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return;
    throw e;
  }
  jsonCache.delete(id);
}

async function getYnabToken() {
  if (cachedYnab) return cachedYnab;
  const raw = await getSecretString(secretId);
  try {
    const j = JSON.parse(raw);
    cachedYnab = (j.token || j.pat || j.access_token || raw).trim();
  } catch {
    cachedYnab = raw.trim();
  }
  if (!cachedYnab) throw new Error('YNAB secret empty');
  return cachedYnab;
}

function clearTokenCache() {
  cachedYnab = undefined;
  jsonCache.clear();
}

module.exports = {
  getYnabToken,
  clearTokenCache,
  getSecretString,
  getSecretJson,
  putSecretJson,
  deleteSecret,
};
