'use strict';

/**
 * Thin Plaid REST client (no SDK) for bank connectors.
 * Credentials live in SSM SecureString (/r2finance/plaid) — never in git or the browser.
 */

const ssm = require('./ssm');
const {
  plaidSsmParam,
  plaidEnv,
  websiteBaseUrl,
} = require('./config');

const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

/** Well-known US institution ids on Plaid. */
const INSTITUTIONS = {
  boa: { id: 'ins_127989', name: 'Bank of America' },
  chase: { id: 'ins_56', name: 'Chase' },
  /** Brokerage / retirement — investments product. */
  vanguard: { id: 'ins_115616', name: 'Vanguard' },
};

const BOA_INSTITUTION_ID = INSTITUTIONS.boa.id;
const CHASE_INSTITUTION_ID = INSTITUTIONS.chase.id;
const VANGUARD_INSTITUTION_ID = INSTITUTIONS.vanguard.id;

let credsCache;

async function getPlaidCreds() {
  if (credsCache) return credsCache;
  let raw;
  try {
    raw = await ssm.getParameterJson(plaidSsmParam, {
      decrypt: true,
      useCache: true,
    });
  } catch (e) {
    const err = new Error(
      `Plaid not configured. Put JSON {client_id, secret, env} in SSM ${plaidSsmParam}.`,
    );
    err.status = 503;
    err.code = 'plaid_not_configured';
    err.cause = e;
    throw err;
  }
  if (!raw || typeof raw !== 'object') {
    const err = new Error(
      `Plaid not configured. Missing SSM SecureString ${plaidSsmParam}.`,
    );
    err.status = 503;
    err.code = 'plaid_not_configured';
    throw err;
  }
  const clientId = (raw.client_id || raw.clientId || '').trim();
  const secret = (raw.secret || raw.client_secret || '').trim();
  const env = String(raw.env || plaidEnv || 'sandbox')
    .trim()
    .toLowerCase();
  if (!clientId || !secret || clientId === 'REPLACE_ME') {
    const err = new Error(
      `Plaid credentials missing. Set client_id + secret on SSM ${plaidSsmParam}.`,
    );
    err.status = 503;
    err.code = 'plaid_not_configured';
    throw err;
  }
  if (!HOSTS[env]) {
    const err = new Error(
      `Invalid Plaid env "${env}" (use sandbox|development|production)`,
    );
    err.status = 500;
    throw err;
  }
  credsCache = { clientId, secret, env, host: HOSTS[env] };
  return credsCache;
}

function clearPlaidCache() {
  credsCache = undefined;
  ssm.clearSsmCache();
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
 * Create a Link token, optionally pre-filtered to one institution.
 * products=transactions so we can later read credit-card spend (not written to DDB yet).
 */
async function createLinkToken({
  clientUserId,
  redirectUri,
  institutionId,
  bankKey,
  products,
} = {}) {
  // Plaid rejects redirect_uri with query strings — bank choice is
  // tracked in the website sessionStorage, not the redirect URL.
  const base = websiteBaseUrl.replace(/\/$/, '');
  const uri = redirectUri || `${base}/connectors`;
  const productList =
    Array.isArray(products) && products.length
      ? products
      : ['transactions'];
  const body = {
    user: { client_user_id: String(clientUserId || 'r2finance-user') },
    client_name: 'R2Finance',
    products: productList,
    country_codes: ['US'],
    language: 'en',
    redirect_uri: uri,
  };
  if (institutionId) body.institution_id = institutionId;
  void bankKey; // reserved for logging / future use

  try {
    return await plaidPost('/link/token/create', body);
  } catch (e) {
    // Common issues: redirect URI not yet registered in Plaid dashboard,
    // or institution_id not allowed for this env/plan — retry looser.
    const msg = e.message || '';
    const retryable =
      e.code === 'INVALID_FIELD' ||
      e.code === 'INVALID_INPUT' ||
      /institution|redirect|product/i.test(msg);
    if (!retryable) throw e;

    // 1) Drop institution preselect, keep redirect if it wasn't the problem
    const step1 = {
      user: body.user,
      client_name: body.client_name,
      products: body.products,
      country_codes: body.country_codes,
      language: body.language,
    };
    if (!/redirect/i.test(msg)) step1.redirect_uri = uri;
    try {
      return await plaidPost('/link/token/create', step1);
    } catch (e2) {
      // 2) Minimal token (no redirect) — works once keys are valid;
      //    OAuth institutions still need redirect registered for full flow.
      if (
        !/redirect|institution|product/i.test(e2.message || '') &&
        e2.code !== 'INVALID_FIELD'
      ) {
        throw e2;
      }
      // If investments product fails on plan, fall back to transactions.
      const fallbackProducts = body.products.includes('investments')
        ? ['transactions']
        : body.products;
      return await plaidPost('/link/token/create', {
        user: body.user,
        client_name: body.client_name,
        products: fallbackProducts,
        country_codes: body.country_codes,
        language: body.language,
      });
    }
  }
}

/** @deprecated use createLinkToken */
async function createBoaLinkToken(opts) {
  return createLinkToken({
    ...opts,
    institutionId: BOA_INSTITUTION_ID,
    bankKey: 'boa',
  });
}

async function createChaseLinkToken(opts) {
  return createLinkToken({
    ...opts,
    institutionId: CHASE_INSTITUTION_ID,
    bankKey: 'chase',
  });
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
  INSTITUTIONS,
  BOA_INSTITUTION_ID,
  CHASE_INSTITUTION_ID,
  VANGUARD_INSTITUTION_ID,
  getPlaidCreds,
  clearPlaidCache,
  createLinkToken,
  createBoaLinkToken,
  createChaseLinkToken,
  exchangePublicToken,
  getItem,
  getAccounts,
  getInstitution,
  removeItem,
  isConfigured,
  plaidPost,
};
