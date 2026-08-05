'use strict';

/**
 * Firebase Cloud Messaging (HTTP v1) for R2Finance.
 * Uses shared org SSM: /fcm/project-id + /fcm/service-account-json
 * (same credentials as OTA app_update pushes).
 *
 * No google-auth-library dependency — service-account JWT via Node crypto.
 */

const crypto = require('crypto');
const ssm = require('./ssm');

const TOPIC = process.env.R2FINANCE_FCM_TOPIC || 'r2finance_updates';
const FCM_PROJECT_SSM = process.env.FCM_PROJECT_SSM || '/fcm/project-id';
const FCM_SA_SSM = process.env.FCM_SA_SSM || '/fcm/service-account-json';

let cachedToken = null; // { accessToken, expMs }

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getServiceAccount() {
  const projectId = await ssm.getParameter(FCM_PROJECT_SSM, {
    decrypt: false,
  });
  const saRaw = await ssm.getParameter(FCM_SA_SSM, { decrypt: true });
  if (!projectId || !saRaw) return null;
  let sa;
  try {
    sa = typeof saRaw === 'string' ? JSON.parse(saRaw) : saRaw;
  } catch {
    return null;
  }
  if (!sa.client_email || !sa.private_key) return null;
  return { projectId, sa };
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expMs > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = b64url(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FCM token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error('FCM token response missing access_token');
  cachedToken = {
    accessToken: json.access_token,
    expMs: Date.now() + Math.max(60, Number(json.expires_in || 3600) - 60) * 1000,
  };
  return cachedToken.accessToken;
}

/**
 * Data-only high-priority push to an FCM topic (Android onMessageReceived always runs).
 * @param {Record<string, string>} data
 * @param {{ topic?: string }} [opts]
 */
async function sendToTopic(data, opts = {}) {
  const creds = await getServiceAccount();
  if (!creds) {
    console.warn('FCM not configured (SSM /fcm/*) — skip push');
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  const topic = opts.topic || TOPIC;
  const accessToken = await getAccessToken(creds.sa);
  const payload = {
    message: {
      topic,
      data: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [String(k), String(v ?? '')]),
      ),
      android: { priority: 'HIGH' },
    },
  };
  const url = `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('FCM send failed', res.status, text.slice(0, 300));
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }
  let name = null;
  try {
    name = JSON.parse(text)?.name || null;
  } catch {
    /* ignore */
  }
  return { ok: true, topic, name };
}

function maskEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at <= 1) return e || 'someone';
  return `${e[0]}…${e.slice(at)}`;
}

/**
 * Immediate sign-in alert to every R2Finance Android install (topic).
 * Non-fatal — callers should not fail login if this errors.
 */
async function notifySignIn({
  email,
  client = 'unknown',
  ip = null,
  userAgent = null,
} = {}) {
  const when = new Date().toISOString();
  const clientLabel =
    client === 'android'
      ? 'Android app'
      : client === 'web'
        ? 'Website'
        : String(client || 'unknown');
  const title = 'R2Finance sign-in';
  const body = `${maskEmail(email)} signed in via ${clientLabel}`;
  const data = {
    type: 'login',
    title,
    body,
    email: String(email || ''),
    client: String(client || 'unknown'),
    at: when,
  };
  if (ip) data.ip = String(ip);
  if (userAgent) data.ua = String(userAgent).slice(0, 120);

  try {
    const result = await sendToTopic(data);
    console.log(
      'login FCM',
      email,
      clientLabel,
      result.ok ? 'sent' : result.reason || result.error || 'failed',
    );
    return result;
  } catch (e) {
    console.error('login FCM error', e && e.message ? e.message : e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** Clear cached OAuth token (tests). */
function clearFcmCache() {
  cachedToken = null;
}

module.exports = {
  TOPIC,
  sendToTopic,
  notifySignIn,
  maskEmail,
  clearFcmCache,
};
