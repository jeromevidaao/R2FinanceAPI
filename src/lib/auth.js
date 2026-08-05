'use strict';

const crypto = require('crypto');
const ddb = require('./ddb');
const { PutCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const {
  tableName,
  websiteBaseUrl,
  resetTokenTtlMs,
} = require('./config');
const { sendEmail } = require('./email');

const ALLOWED_EMAIL = 'jerome.ans@gmail.com';
/** Long-lived so OTA updates never force password+MFA for months. */
const SESSION_DAYS = 180;
const RESET_COOLDOWN_MS = 60 * 1000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function userKey(email) {
  return { pk: `USER#${normalizeEmail(email)}`, sk: 'PROFILE' };
}

function sessionKey(token) {
  return { pk: `SESSION#${token}`, sk: 'META' };
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

/** RFC 6238 TOTP (6 digits, 30s, SHA1) */
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  const cleaned = str.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  for (const c of cleaned) {
    const val = alphabet.indexOf(c);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += alphabet[parseInt(chunk, 2)];
  }
  return out;
}

function totpCode(secretBase32, step = Math.floor(Date.now() / 1000 / 30)) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1e6).padStart(6, '0');
}

function verifyTotp(secretBase32, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const d of [-1, 0, 1]) {
    if (totpCode(secretBase32, step + d) === c) return true;
  }
  return false;
}

async function getUser(email) {
  const out = await ddb.ddb.send(
    new GetCommand({ TableName: tableName, Key: userKey(email) }),
  );
  return out.Item || null;
}

async function putUser(item) {
  await ddb.ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}

/**
 * Ensure the allowed user exists (must set password on first login).
 */
async function ensureUser(email = ALLOWED_EMAIL) {
  const e = normalizeEmail(email);
  if (e !== ALLOWED_EMAIL) {
    const err = new Error('This app is private; only the invited user may sign in.');
    err.status = 403;
    throw err;
  }
  let user = await getUser(e);
  if (!user) {
    user = {
      ...userKey(e),
      entityType: 'user',
      email: e,
      mustSetPassword: true,
      mfaEnabled: false,
      totpSecret: null,
      passwordHash: null,
      passwordSalt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await putUser(user);
  }
  return user;
}

async function authStatus(email) {
  const e = normalizeEmail(email);
  if (e !== ALLOWED_EMAIL) {
    return { allowed: false, exists: false };
  }
  const user = await ensureUser(e);
  return {
    allowed: true,
    exists: true,
    email: e,
    mustSetPassword: !!user.mustSetPassword || !user.passwordHash,
    mfaEnabled: !!user.mfaEnabled,
  };
}

async function setPassword(email, password) {
  const e = normalizeEmail(email);
  if (e !== ALLOWED_EMAIL) {
    const err = new Error('Not allowed');
    err.status = 403;
    throw err;
  }
  if (!password || password.length < 10) {
    const err = new Error('Password must be at least 10 characters');
    err.status = 400;
    throw err;
  }
  const user = await ensureUser(e);
  const { salt, hash } = hashPassword(password);
  await putUser({
    ...user,
    passwordHash: hash,
    passwordSalt: salt,
    mustSetPassword: false,
    updatedAt: Date.now(),
  });
  return { ok: true, next: user.mfaEnabled ? 'login' : 'mfa_setup' };
}

async function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await ddb.ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...sessionKey(token),
        entityType: 'session',
        email: normalizeEmail(email),
        expiresAt,
        createdAt: Date.now(),
      },
    }),
  );
  return { token, expiresAt };
}

async function validateSession(token) {
  if (!token) return null;
  const out = await ddb.ddb.send(
    new GetCommand({ TableName: tableName, Key: sessionKey(token) }),
  );
  const s = out.Item;
  if (!s || !s.expiresAt || s.expiresAt < Date.now()) return null;
  return s;
}

async function login(email, password) {
  const e = normalizeEmail(email);
  if (e !== ALLOWED_EMAIL) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  const user = await ensureUser(e);
  if (user.mustSetPassword || !user.passwordHash) {
    return { ok: false, next: 'set_password', email: e };
  }
  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  if (!user.mfaEnabled) {
    return { ok: false, next: 'mfa_setup', email: e, passwordOk: true };
  }
  // Issue short-lived pending token for MFA step (reuse session table with flag)
  const pending = crypto.randomBytes(24).toString('hex');
  await ddb.ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `MFA_PENDING#${pending}`,
        sk: 'META',
        entityType: 'mfa_pending',
        email: e,
        expiresAt: Date.now() + 10 * 60 * 1000,
      },
    }),
  );
  return { ok: false, next: 'mfa_verify', mfaToken: pending, email: e };
}

async function mfaSetupStart(email, password) {
  const e = normalizeEmail(email);
  const user = await ensureUser(e);
  if (user.mustSetPassword || !user.passwordHash) {
    const err = new Error('Set password first');
    err.status = 400;
    throw err;
  }
  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    const err = new Error('Invalid password');
    err.status = 401;
    throw err;
  }
  const secret = base32Encode(crypto.randomBytes(20));
  await putUser({
    ...user,
    totpSecretPending: secret,
    updatedAt: Date.now(),
  });
  const label = encodeURIComponent(`R2Finance:${e}`);
  const issuer = encodeURIComponent('R2Finance');
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;
  return { secret, otpauth };
}

async function mfaSetupConfirm(email, password, code) {
  const e = normalizeEmail(email);
  const user = await ensureUser(e);
  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    const err = new Error('Invalid password');
    err.status = 401;
    throw err;
  }
  const secret = user.totpSecretPending || user.totpSecret;
  if (!secret || !verifyTotp(secret, code)) {
    const err = new Error('Invalid authenticator code');
    err.status = 401;
    throw err;
  }
  await putUser({
    ...user,
    totpSecret: secret,
    totpSecretPending: null,
    mfaEnabled: true,
    updatedAt: Date.now(),
  });
  const session = await createSession(e);
  return { ok: true, ...session, email: e };
}

async function mfaVerify(mfaToken, code) {
  const out = await ddb.ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `MFA_PENDING#${mfaToken}`, sk: 'META' },
    }),
  );
  const pending = out.Item;
  if (!pending || pending.expiresAt < Date.now()) {
    const err = new Error('MFA session expired — sign in again');
    err.status = 401;
    throw err;
  }
  const user = await getUser(pending.email);
  if (!user?.totpSecret || !verifyTotp(user.totpSecret, code)) {
    const err = new Error('Invalid authenticator code');
    err.status = 401;
    throw err;
  }
  await ddb.ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { pk: `MFA_PENDING#${mfaToken}`, sk: 'META' },
    }),
  );
  const session = await createSession(pending.email);
  return { ok: true, ...session, email: pending.email };
}

function resetKey(token) {
  return { pk: `RESET#${token}`, sk: 'META' };
}

/**
 * Request a password reset email. Always returns a generic success for allowed
 * emails (and a soft message for others) so callers get a clear UX without
 * leaking extra account state beyond the private allow-list.
 */
async function requestPasswordReset(email) {
  const e = normalizeEmail(email);
  if (e !== ALLOWED_EMAIL) {
    // Generic response — do not reveal allow-list membership in detail
    return {
      ok: true,
      message:
        'If that email can reset a password, a link was sent. Check your inbox.',
    };
  }

  const user = await ensureUser(e);
  const now = Date.now();
  if (
    user.lastResetEmailAt &&
    now - Number(user.lastResetEmailAt) < RESET_COOLDOWN_MS
  ) {
    return {
      ok: true,
      message:
        'If that email can reset a password, a link was sent. Check your inbox.',
      throttled: true,
    };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = now + resetTokenTtlMs;
  await ddb.ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...resetKey(token),
        entityType: 'password_reset',
        email: e,
        expiresAt,
        createdAt: now,
        used: false,
      },
    }),
  );

  await putUser({
    ...user,
    lastResetEmailAt: now,
    updatedAt: now,
  });

  const base = String(websiteBaseUrl || 'https://finance.i-liquid.be').replace(
    /\/$/,
    '',
  );
  const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
  const minutes = Math.max(1, Math.round(resetTokenTtlMs / 60000));

  const text = [
    'R2Finance password reset',
    '',
    'Someone requested a password reset for your R2Finance account.',
    `Open this link on the R2Finance website to choose a new password (expires in ${minutes} minutes):`,
    '',
    link,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
      <h2 style="margin:0 0 12px">R2Finance password reset</h2>
      <p>Someone requested a password reset for your R2Finance account.</p>
      <p>
        <a href="${link}" style="display:inline-block;background:#2a9f6f;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">
          Reset password on finance.i-liquid.be
        </a>
      </p>
      <p style="color:#555;font-size:14px">This link expires in ${minutes} minutes.</p>
      <p style="color:#555;font-size:13px;word-break:break-all">${link}</p>
      <p style="color:#777;font-size:13px">If you did not request this, you can ignore this email.</p>
    </div>
  `;

  try {
    await sendEmail({
      to: e,
      subject: 'Reset your R2Finance password',
      text,
      html,
    });
  } catch (err) {
    console.error('password reset email failed', err);
    const e2 = new Error('Could not send reset email — try again later');
    e2.status = 502;
    throw e2;
  }

  return {
    ok: true,
    message:
      'Check your email for a link to reset your password on the R2Finance website.',
    website: base,
  };
}

/**
 * Complete password reset using the one-time token from email.
 */
async function resetPasswordWithToken(token, password) {
  const t = String(token || '').trim();
  if (!t || t.length < 32) {
    const err = new Error('Invalid or expired reset link');
    err.status = 400;
    throw err;
  }
  if (!password || password.length < 10) {
    const err = new Error('Password must be at least 10 characters');
    err.status = 400;
    throw err;
  }

  const out = await ddb.ddb.send(
    new GetCommand({ TableName: tableName, Key: resetKey(t) }),
  );
  const row = out.Item;
  if (!row || row.used || !row.expiresAt || row.expiresAt < Date.now()) {
    const err = new Error('Invalid or expired reset link');
    err.status = 400;
    throw err;
  }

  const e = normalizeEmail(row.email);
  if (e !== ALLOWED_EMAIL) {
    const err = new Error('Invalid or expired reset link');
    err.status = 400;
    throw err;
  }

  const user = await ensureUser(e);
  const { salt, hash } = hashPassword(password);
  await putUser({
    ...user,
    passwordHash: hash,
    passwordSalt: salt,
    mustSetPassword: false,
    updatedAt: Date.now(),
  });

  // One-time use
  await ddb.ddb.send(
    new DeleteCommand({ TableName: tableName, Key: resetKey(t) }),
  );

  return {
    ok: true,
    email: e,
    message: 'Password updated. Sign in with your new password.',
  };
}

module.exports = {
  ALLOWED_EMAIL,
  ensureUser,
  authStatus,
  setPassword,
  login,
  mfaSetupStart,
  mfaSetupConfirm,
  mfaVerify,
  validateSession,
  normalizeEmail,
  requestPasswordReset,
  resetPasswordWithToken,
};
