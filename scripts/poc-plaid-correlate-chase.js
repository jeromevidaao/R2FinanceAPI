#!/usr/bin/env node
'use strict';

/**
 * POC: sample a few R2Finance DDB ledger transactions and try to match them
 * against live Chase transactions from Plaid.
 *
 * Usage:
 *   node scripts/poc-plaid-correlate-chase.js
 *   EMAIL=jerome.ans@gmail.com SAMPLE=8 DAYS=21 node scripts/poc-plaid-correlate-chase.js
 *
 * Does NOT write to DDB. Read-only: DDB + SSM + Plaid.
 */

const ddb = require('../src/lib/ddb');
const plaid = require('../src/lib/plaid');
const connectors = require('../src/lib/connectors');
const { ledgerPlanId } = require('../src/lib/config');

const EMAIL = (process.env.EMAIL || 'jerome.ans@gmail.com').trim().toLowerCase();
const SAMPLE = Math.max(3, Number(process.env.SAMPLE || 8));
const DAYS = Math.max(7, Number(process.env.DAYS || 21));
const BANK = 'chase';

/** YNAB milliunits → dollars. */
function ynabToDollars(milli) {
  return Number(milli) / 1000;
}

/** Normalize payee / merchant for fuzzy compare. */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameScore(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(' ').filter((w) => w.length > 2));
  const tb = new Set(nb.split(' ').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

function daysBetween(d1, d2) {
  const a = Date.parse(d1);
  const b = Date.parse(d2);
  if (Number.isNaN(a) || Number.isNaN(b)) return 99;
  return Math.abs(a - b) / (24 * 3600 * 1000);
}

/**
 * Score a DDB ledger txn vs a Plaid txn.
 * YNAB: outflow negative milliunits. Plaid: money-out positive dollars.
 */
function matchScore(ledger, plaidTxn) {
  const yAmt = ynabToDollars(ledger.amount);
  const pAmt = Number(plaidTxn.amount);
  // Prefer opposite-sign equal magnitude (expense: YNAB -x, Plaid +x)
  const opposite = Math.abs(yAmt + pAmt) < 0.02;
  const sameSign = Math.abs(yAmt - pAmt) < 0.02;
  if (!opposite && !sameSign) return null;

  const dateDelta = Math.min(
    daysBetween(ledger.date, plaidTxn.date),
    daysBetween(ledger.date, plaidTxn.authorized_date || plaidTxn.date),
  );
  if (dateDelta > 4) return null;

  const ledgerName =
    ledger.payeeName || ledger.importPayeeName || ledger.memo || '';
  const plaidName =
    plaidTxn.merchant_name ||
    plaidTxn.name ||
    plaidTxn.original_description ||
    '';
  const nScore = nameScore(ledgerName, plaidName);

  // Amount match is required; name helps; date closeness helps.
  let score = opposite ? 0.55 : 0.4;
  score += Math.max(0, 0.25 - dateDelta * 0.05);
  score += nScore * 0.35;
  if (!ledgerName || !plaidName) score -= 0.05;

  return {
    score: Math.round(score * 1000) / 1000,
    dateDelta: Math.round(dateDelta * 10) / 10,
    nameScore: Math.round(nScore * 100) / 100,
    amountAlign: opposite ? 'ynab_neg_plaid_pos' : 'same_sign',
  };
}

function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const parts = [
    loc.address,
    loc.city,
    loc.region,
    loc.postal_code,
    loc.country,
  ].filter(Boolean);
  const hasCoords =
    loc.lat != null &&
    loc.lon != null &&
    !(loc.lat === 0 && loc.lon === 0);
  if (!parts.length && !hasCoords && !loc.store_number) return null;
  return {
    text: parts.join(', ') || null,
    lat: hasCoords ? loc.lat : null,
    lon: hasCoords ? loc.lon : null,
    store_number: loc.store_number || null,
  };
}

async function fetchPlaidTransactions(accessToken, { startDate, endDate }) {
  // Prefer /transactions/sync when available; fall back to /transactions/get.
  try {
    const all = [];
    let cursor;
    let hasMore = true;
    let guard = 0;
    while (hasMore && guard < 20) {
      guard += 1;
      const body = { access_token: accessToken, count: 500 };
      if (cursor) body.cursor = cursor;
      const res = await plaid.plaidPost('/transactions/sync', body);
      all.push(...(res.added || []));
      all.push(...(res.modified || []));
      cursor = res.next_cursor;
      hasMore = !!res.has_more;
    }
    // Include pending — YNAB often has them before Plaid posts.
    return all.filter((t) => {
      const d = t.date || t.authorized_date;
      return d && d >= startDate && d <= endDate;
    });
  } catch (e) {
    console.warn(
      'transactions/sync failed, falling back to transactions/get:',
      e.message,
    );
    const res = await plaid.plaidPost('/transactions/get', {
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count: 500,
        offset: 0,
        include_personal_finance_category: true,
        include_original_description: true,
      },
    });
    return res.transactions || [];
  }
}

function isoDateDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function resolvePayeeNames(planId) {
  const payees = await ddb.queryPk(ddb.planPk(planId), 'PAYEE#');
  const map = new Map();
  for (const p of payees) {
    const id = p.ynabId || String(p.sk || '').replace(/^PAYEE#/, '');
    map.set(id, p.name || p.payload?.name || null);
  }
  return map;
}

async function resolveAccountMeta(planId) {
  const accts = await ddb.queryPk(ddb.planPk(planId), 'ACCT#');
  const map = new Map();
  for (const a of accts) {
    const id = a.ynabId || a.payload?.id || String(a.sk || '').replace(/^ACCT#/, '');
    map.set(id, {
      name: a.name || a.payload?.name || null,
      mask: extractMask(a.name || a.payload?.name),
      type: a.payload?.type || a.type || null,
    });
  }
  return map;
}

function extractMask(name) {
  const m = String(name || '').match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

async function main() {
  console.log(
    JSON.stringify({
      msg: 'poc-plaid-correlate-chase start',
      email: EMAIL,
      bank: BANK,
      sample: SAMPLE,
      days: DAYS,
      planId: ledgerPlanId,
    }),
  );

  const bank = connectors.resolveBank(BANK);
  const status = await connectors.status(BANK, { email: EMAIL });
  if (!status.connected) {
    throw new Error(
      `Chase not connected for ${EMAIL}. Connect at finance.i-liquid.be/connectors first.`,
    );
  }

  // Access token via same path as API (not exported — re-read SSM).
  const ssm = require('../src/lib/ssm');
  const tokenPath = connectors.itemSsmParam(bank, EMAIL);
  const tokenJson = await ssm.getParameterJson(tokenPath, {
    decrypt: true,
    useCache: false,
  });
  const accessToken = (tokenJson?.access_token || '').trim();
  if (!accessToken) {
    throw new Error(`No Chase access_token at ${tokenPath}`);
  }

  const plaidAccounts = status.accountsPreview || [];
  const chaseMasks = new Set(
    plaidAccounts.map((a) => a.mask).filter(Boolean),
  );
  const plaidAcctById = new Map(
    plaidAccounts.map((a) => [a.accountId, a]),
  );
  console.log(
    'Chase Plaid accounts:',
    plaidAccounts.map((a) => `${a.name} *${a.mask} (${a.subtype})`).join(' | '),
  );

  const startDate = isoDateDaysAgo(DAYS);
  const endDate = todayIso();
  console.log(`Fetching Plaid Chase txns ${startDate} → ${endDate}…`);
  const plaidTxns = await fetchPlaidTransactions(accessToken, {
    startDate,
    endDate,
  });
  console.log(`Plaid transactions in window: ${plaidTxns.length}`);

  const withLoc = plaidTxns.filter((t) => formatLocation(t.location));
  console.log(`Plaid txns with non-empty location: ${withLoc.length}`);
  if (withLoc.length) {
    console.log('Location samples from Plaid (not necessarily matched):');
    for (const t of withLoc.slice(0, 3)) {
      const loc = formatLocation(t.location);
      console.log(
        `  ${t.date} $${t.amount} ${t.merchant_name || t.name} → ${loc.text || ''} lat=${loc.lat} lon=${loc.lon}`,
      );
    }
  }

  const payeeMap = await resolvePayeeNames(ledgerPlanId);
  const acctMap = await resolveAccountMeta(ledgerPlanId);

  // Ledger rows whose account mask overlaps Chase Plaid accounts (or any if no mask).
  const allTxns = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'TXN#');
  const ledgerCandidates = [];
  for (const t of allTxns) {
    if (t.deleted) continue;
    const p = t.payload || {};
    const date = t.date || p.date;
    if (!date || date < startDate || date > endDate) continue;
    const accountId = t.accountId || p.account_id;
    const acct = acctMap.get(accountId) || {
      name: p.account_name || null,
      mask: extractMask(p.account_name),
    };
    // Only accounts whose last-4 is on this Plaid Chase item
    // (avoids BoA Ink / other banks that share "freedom" naming).
    const mask = acct.mask;
    if (!mask || !chaseMasks.has(mask)) continue;

    const amount = t.amount ?? p.amount;
    if (amount == null) continue;
    // Skip pure transfers labels for cleaner POC sample (optional keep some)
    const payeeName =
      payeeMap.get(t.payeeId || p.payee_id) ||
      p.payee_name ||
      null;
    ledgerCandidates.push({
      ynabId: t.ynabId || String(t.sk || '').replace(/^TXN#/, ''),
      sk: t.sk,
      date,
      amount,
      dollars: ynabToDollars(amount),
      payeeName,
      importPayeeName: p.import_payee_name || null,
      memo: t.memo ?? p.memo ?? null,
      importId: p.import_id || null,
      accountId,
      accountName: acct.name || p.account_name || null,
      accountMask: mask,
    });
  }

  ledgerCandidates.sort((a, b) => b.date.localeCompare(a.date));
  // Prefer non-transfer, non-zero for interesting sample
  const samplePool = [
    ...ledgerCandidates.filter(
      (t) =>
        t.payeeName &&
        !/^transfer\s*:/i.test(t.payeeName) &&
        Math.abs(t.dollars) >= 1,
    ),
    ...ledgerCandidates,
  ];
  const seen = new Set();
  const sample = [];
  for (const t of samplePool) {
    if (seen.has(t.ynabId)) continue;
    seen.add(t.ynabId);
    sample.push(t);
    if (sample.length >= SAMPLE) break;
  }

  console.log(
    `\nLedger sample (${sample.length} of ${ledgerCandidates.length} Chase-ish in window):\n`,
  );

  // Greedy 1:1 — highest score pairs first so two $125 Cleanformes don't
  // both claim the same Plaid row.
  const pairCandidates = [];
  for (const ledger of sample) {
    for (const pt of plaidTxns) {
      const pa = plaidAcctById.get(pt.account_id);
      const m = matchScore(ledger, pt);
      if (!m) continue;
      if (ledger.accountMask && pa?.mask === ledger.accountMask) {
        m.score += 0.12;
      } else if (ledger.accountMask && pa?.mask && ledger.accountMask !== pa.mask) {
        m.score -= 0.15;
      }
      if (pt.pending) m.score -= 0.02;
      pairCandidates.push({
        ledgerId: ledger.ynabId,
        plaidId: pt.transaction_id,
        score: m.score,
        meta: m,
        ledger,
        pt,
        pa,
      });
    }
  }
  pairCandidates.sort((a, b) => b.score - a.score);
  const usedLedger = new Set();
  const usedPlaid = new Set();
  const bestByLedger = new Map();
  for (const c of pairCandidates) {
    if (usedLedger.has(c.ledgerId) || usedPlaid.has(c.plaidId)) continue;
    if (c.score < 0.5) continue;
    usedLedger.add(c.ledgerId);
    usedPlaid.add(c.plaidId);
    bestByLedger.set(c.ledgerId, {
      ...c.meta,
      score: Math.round(c.score * 1000) / 1000,
      plaid: {
        transaction_id: c.pt.transaction_id,
        account_id: c.pt.account_id,
        account: c.pa
          ? `${c.pa.name} *${c.pa.mask}`
          : c.pt.account_id,
        date: c.pt.date,
        authorized_date: c.pt.authorized_date || null,
        amount: c.pt.amount,
        name: c.pt.name,
        merchant_name: c.pt.merchant_name || null,
        pending: !!c.pt.pending,
        payment_channel: c.pt.payment_channel || null,
        location: formatLocation(c.pt.location),
        pfc:
          c.pt.personal_finance_category?.primary ||
          c.pt.category?.[0] ||
          null,
      },
    });
  }

  const results = [];
  for (const ledger of sample) {
    const best = bestByLedger.get(ledger.ynabId) || null;

    const row = {
      ledger: {
        ynabId: ledger.ynabId,
        date: ledger.date,
        amount: ledger.dollars,
        payee: ledger.payeeName,
        account: ledger.accountName,
        importId: ledger.importId,
      },
      match: best
        ? {
            score: best.score,
            dateDeltaDays: best.dateDelta,
            nameScore: best.nameScore,
            amountAlign: best.amountAlign,
            plaid: best.plaid,
          }
        : null,
    };
    results.push(row);

    const ok = best && best.score >= 0.55;
    console.log('─'.repeat(72));
    console.log(
      `${ok ? 'MATCH' : best ? 'WEAK' : 'NO MATCH'}  ledger ${ledger.date}  $${ledger.dollars.toFixed(2)}  ${ledger.payeeName || '(no payee)'}`,
    );
    console.log(
      `  ynabId=${ledger.ynabId}  acct=${ledger.accountName}  importId=${ledger.importId || '—'}`,
    );
    if (best) {
      console.log(
        `  → plaid ${best.plaid.date}  $${Number(best.plaid.amount).toFixed(2)}  ${best.plaid.merchant_name || best.plaid.name}`,
      );
      console.log(
        `    transaction_id=${best.plaid.transaction_id}  score=${best.score}  Δdays=${best.dateDelta}  name=${best.nameScore}`,
      );
      console.log(`    channel=${best.plaid.payment_channel || '—'}  pfc=${best.plaid.pfc || '—'}`);
      if (best.plaid.location) {
        console.log(
          `    LOCATION: ${best.plaid.location.text || '(coords only)'}  lat=${best.plaid.location.lat} lon=${best.plaid.location.lon} store=${best.plaid.location.store_number || '—'}`,
        );
      } else {
        console.log('    LOCATION: (none on this Plaid txn)');
      }
    }
  }

  const matched = results.filter((r) => r.match && r.match.score >= 0.55);
  const withLocation = matched.filter((r) => r.match.plaid.location);

  console.log('\n' + '═'.repeat(72));
  console.log('POC SUMMARY');
  console.log(
    JSON.stringify(
      {
        email: EMAIL,
        chaseConnected: true,
        plaidTxnCount: plaidTxns.length,
        plaidWithLocation: withLoc.length,
        ledgerChaseCandidates: ledgerCandidates.length,
        sample: results.length,
        matched: matched.length,
        matchedWithLocation: withLocation.length,
        note:
          'Heuristic match only (amount + date ±4d + name). No DDB writes. import_id is YNAB-shaped, not Plaid transaction_id.',
      },
      null,
      2,
    ),
  );

  // Machine-readable dump for follow-up
  if (process.env.JSON_OUT) {
    const fs = require('fs');
    fs.writeFileSync(
      process.env.JSON_OUT,
      JSON.stringify({ results, summary: { matched: matched.length } }, null, 2),
    );
    console.log('Wrote', process.env.JSON_OUT);
  }
}

main().catch((e) => {
  console.error('POC failed:', e.message);
  if (e.plaid) console.error(JSON.stringify(e.plaid, null, 2));
  process.exit(1);
});
