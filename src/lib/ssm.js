'use strict';

/**
 * SSM Parameter Store helpers for R2Finance.
 * Sensitive values (Plaid keys, bank item tokens) live in SSM SecureString —
 * never in git, never in the browser.
 */

const {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} = require('@aws-sdk/client-ssm');
const { region } = require('./config');

const client = new SSMClient({ region });
const cache = new Map();

async function getParameter(name, { decrypt = true, useCache = true } = {}) {
  if (useCache && cache.has(name)) return cache.get(name);
  try {
    const out = await client.send(
      new GetParameterCommand({
        Name: name,
        WithDecryption: decrypt,
      }),
    );
    const value = out.Parameter?.Value ?? null;
    if (useCache && value != null) cache.set(name, value);
    return value;
  } catch (e) {
    if (
      e.name === 'ParameterNotFound' ||
      e.__type?.includes('ParameterNotFound')
    ) {
      return null;
    }
    throw e;
  }
}

async function getParameterJson(name, opts = {}) {
  const raw = await getParameter(name, opts);
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { value: raw };
  }
}

async function putParameterJson(name, obj, { description } = {}) {
  const value = JSON.stringify(obj);
  try {
    await client.send(
      new PutParameterCommand({
        Name: name,
        Type: 'SecureString',
        Value: value,
        Overwrite: true,
        Description: description,
      }),
    );
  } catch (e) {
    // First create without overwrite if needed (Overwrite true should work for both)
    throw e;
  }
  cache.set(name, value);
  return obj;
}

async function deleteParameter(name) {
  try {
    await client.send(new DeleteParameterCommand({ Name: name }));
  } catch (e) {
    if (
      e.name === 'ParameterNotFound' ||
      e.__type?.includes('ParameterNotFound')
    ) {
      cache.delete(name);
      return;
    }
    throw e;
  }
  cache.delete(name);
}

function clearSsmCache() {
  cache.clear();
}

module.exports = {
  getParameter,
  getParameterJson,
  putParameterJson,
  deleteParameter,
  clearSsmCache,
};
