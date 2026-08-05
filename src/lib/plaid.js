'use strict';

/**
 * Thin Plaid REST client (no SDK) for Bank of America access.
 * Credentials live in Secrets Manager — never in the browser.
 */

const secrets = require('./secrets');
const {
  plaidSecretId,
  plaidEnv,
  websiteBaseUrl,
} = require('./config');

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

/** Bank of America (US) institution id on Plaid. */
const BOA_INSTITUTION_ID = 'ins_127989';

let credsCache;

async function getPlaidCreds() {
  if (credsCache) return credsCache;
  let raw;
  try {
    raw = await secrets.getSecretJson(plaidSecretId, { cache: true });
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      const err = new Error(
        'Plaid not configured. Create secret R2Finance/plaid with client_id, secret, env.',
      );
      err.status = 503;
      err.code = 'plaid_not_configured';
      throw err;
    }
    throw e;
  }
  const clientId = (raw.client_id || raw.clientId || '').trim();
  const secret = (raw.secret || raw.client_secret || '').trim();
  const env = String(raw.env || plaidEnv || 'sandbox')
    .trim()
    .toLowerCase();
  if (!clientId || !secret || clientId === 'REPLACE_ME') {
    const err = new Error(
      'Plaid credentials missing. Set client_id + secret on secret R2Finance/plaid.',
    );
    err.status = 503;
    err.code = 'plaid_not_configured';
    throw err;
  }
  if (!HOSTS[env]) {
    const err = new Error(`Invalid Plaid env "${env}" (use sandbox|development|production)`);
    err.status = 500;
    throw err;
  }
  credsCache = { clientId, secret, env, host: HOSTS[env] };
  return credsCache;
}

function clearPlaidCache() {
  credsCache = undefined;
}

async function plaidPost(path, body = {}) {
  const { clientId, secret, host } = await getPlaidCreds();
  const res = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      ...body,
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error_message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg =
      data.error_message ||
      data.display_message ||
      data.error_code ||
      `Plaid HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 500 ? 400 : 502;
    err.code = data.error_code || 'plaid_error';
    err.plaid = data;
    throw err;
  }
  return data;
}

/**
 * Create a Link token pre-filtered to Bank of America.
 * products=transactions so we can later read credit-card spend (not written to DDB yet).
 */
async function createBoaLinkToken({ clientUserId, redirectUri }) {
  const uri =
    redirectUri || `${websiteBaseUrl.replace(/\/$/, '')}/connectors`;
  const body = {
    user: { client_user_id: String(clientUserId || 'r2finance-user') },
    client_name: 'R2Finance',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
    redirect_uri: uri,
    // Pre-select Bank of America when Plaid allows institution_id on Link.
    institution_id: BOA_INSTITUTION_ID,
  };
  try {
    return await plaidPost('/link/token/create', body);
  } catch (e) {
    // Sandbox / some envs reject institution_id or OAuth redirect — retry looser.
    if (
      e.code === 'INVALID_FIELD' ||
      e.code === 'INVALID_INPUT' ||
      /institution|redirect/i.test(e.message || '')
    ) {
      const fallback = {
        user: body.user,
        client_name: body.client_name,
        products: body.products,
        country_codes: body.country_codes,
        language: body.language,
      };
      // Keep redirect only if it looked like redirect was not the problem
      if (!/redirect/i.test(e.message || '')) {
        fallback.redirect_uri = uri;
      }
      return await plaidPost('/link/token/create', fallback);
    }
    throw e;
  }
}

async function exchangePublicToken(publicToken) {
  return plaidPost('/item/public_token/exchange', {
    public_token: publicToken,
  });
}

async function getItem(accessToken) {
  return plaidPost('/item/get', { access_token: accessToken });
}

async function getAccounts(accessToken) {
  return plaidPost('/accounts/get', { access_token: accessToken });
}

async function getInstitution(institutionId) {
  return plaidPost('/institutions/get_by_id', {
    institution_id: institutionId,
    country_codes: ['US'],
  });
}

async function removeItem(accessToken) {
  return plaidPost('/item/remove', { access_token: accessToken });
}

async function isConfigured() {
  try {
    await getPlaidCreds();
    return true;
  } catch (e) {
    if (e.code === 'plaid_not_configured') return false;
    throw e;
  }
}

module.exports = {
  BOA_INSTITUTION_ID,
  getPlaidCreds,
  clearPlaidCache,
  createBoaLinkToken,
  exchangePublicToken,
  getItem,
  getAccounts,
  getInstitution,
  removeItem,
  isConfigured,
  plaidPost,
};
