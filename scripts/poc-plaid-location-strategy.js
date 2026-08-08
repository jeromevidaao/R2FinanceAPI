#!/usr/bin/env node
'use strict';

/**
 * POC: tiered DDB↔Chase Plaid correlate + location cascade.
 * Read-only. See docs/PLAID_CORRELATE_LOCATION.md
 *
 *   DAYS=45 EMAIL=jerome.ans@gmail.com node scripts/poc-plaid-location-strategy.js
 */

const ddb = require('../src/lib/ddb');
const plaid = require('../src/lib/plaid');
const connectors = require('../src/lib/connectors');
const ssm = require('../src/lib/ssm');
const { ledgerPlanId } = require('../src/lib/config');
const {
  extractMask,
  ynabToDollars,
  buildMerchantLocationCache,
  matchLedgerToPlaid,
  attachLocations,
  enrichmentRecord,
} = require('../src/lib/plaidMatch');

const EMAIL = (process.env.EMAIL || 'jerome.ans@gmail.com').trim().toLowerCase();
const DAYS = Math.max(7, Number(process.env.DAYS || 45));
const SHOW = Math.max(0, Number(process.env.SHOW || 6));

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchAllPlaid(accessToken) {
  const all = [];
  let cursor;
  let more = true;
  let guard = 0;
  while (more && guard < 40) {
    guard += 1;
    const body = { access_token: accessToken, count: 500 };
    if (cursor) body.cursor = cursor;
    const res = await plaid.plaidPost('/transactions/sync', body);
    all.push(...(res.added || []), ...(res.modified || []));
    cursor = res.next_cursor;
    more = !!res.has_more;
  }
  return all;
}

async function main() {
  const bank = connectors.resolveBank('chase');
  const status = await connectors.status('chase', { email: EMAIL });
  if (!status.connected) throw new Error(`Chase not connected for ${EMAIL}`);

  const tokenJson = await ssm.getParameterJson(
    connectors.itemSsmParam(bank, EMAIL),
    { decrypt: true, useCache: false },
  );
  const accessToken = (tokenJson?.access_token || '').trim();
  if (!accessToken) throw new Error('missing Chase access_token');

  const startDate = isoDaysAgo(DAYS);
  const endDate = new Date().toISOString().slice(0, 10);

  console.log(
    JSON.stringify({
      msg: 'poc-plaid-location-strategy',
      email: EMAIL,
      days: DAYS,
      startDate,
      endDate,
    }),
  );

  const allPlaid = await fetchAllPlaid(accessToken);
  // Cache from full history (better entity inheritance)
  const locationCache = buildMerchantLocationCache(allPlaid);

  const plaidTxns = allPlaid.filter((t) => {
    const d = t.date || t.authorized_date;
    return d && d >= startDate && d <= endDate;
  });

  const plaidAccounts = status.accountsPreview || [];
  const chaseMasks = new Set(plaidAccounts.map((a) => a.mask).filter(Boolean));
  const plaidAccountById = new Map(
    plaidAccounts.map((a) => [
      a.accountId,
      { mask: a.mask, name: a.name },
    ]),
  );

  const payees = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'PAYEE#');
  const payeeMap = new Map();
  for (const p of payees) {
    const id = p.ynabId || String(p.sk || '').replace(/^PAYEE#/, '');
    payeeMap.set(id, p.name || p.payload?.name || null);
  }
  const accts = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'ACCT#');
  const acctMap = new Map();
  for (const a of accts) {
    const id =
      a.ynabId || a.payload?.id || String(a.sk || '').replace(/^ACCT#/, '');
    acctMap.set(id, {
      name: a.name || a.payload?.name || null,
      mask: extractMask(a.name || a.payload?.name),
    });
  }

  const allTxns = await ddb.queryPk(ddb.planPk(ledgerPlanId), 'TXN#');
  const ledger = [];
  for (const t of allTxns) {
    if (t.deleted) continue;
    const p = t.payload || {};
    const date = t.date || p.date;
    if (!date || date < startDate || date > endDate) continue;
    const accountId = t.accountId || p.account_id;
    const acct = acctMap.get(accountId) || {
      name: p.account_name,
      mask: extractMask(p.account_name),
    };
    if (!acct.mask || !chaseMasks.has(acct.mask)) continue;
    const amount = t.amount ?? p.amount;
    if (amount == null) continue;
    const payeeName =
      payeeMap.get(t.payeeId || p.payee_id) || p.payee_name || null;
    const isTransfer =
      /^transfer\s*:/i.test(payeeName || '') ||
      !!(p.transfer_account_id || p.transfer_transaction_id);
    ledger.push({
      ynabId: t.ynabId || String(t.sk || '').replace(/^TXN#/, ''),
      date,
      amount,
      accountMask: acct.mask,
      accountName: acct.name,
      payeeName,
      importPayeeName: p.import_payee_name || null,
      memo: t.memo ?? p.memo ?? null,
      isTransfer,
    });
  }

  const nonTransfer = ledger.filter((t) => !t.isTransfer);
  const matchResult = matchLedgerToPlaid(
    nonTransfer,
    plaidTxns,
    plaidAccountById,
  );
  const located = attachLocations(matchResult, locationCache, {
    offerGeocode: true,
  });

  const summary = {
    plaidInWindow: plaidTxns.length,
    plaidHistoryForCache: allPlaid.length,
    merchantCache: {
      byEntity: locationCache.byEntity.size,
      byName: locationCache.byName.size,
    },
    ledgerChase: ledger.length,
    nonTransfer: nonTransfer.length,
    matched: matchResult.matched,
    matchRatePct: Math.round(matchResult.rate * 1000) / 10,
    tierCounts: matchResult.tierCounts,
    location: {
      withLocation: located.withLocation,
      withLocationPct: Math.round(located.withLocationRate * 1000) / 10,
      bySource: located.bySource,
      geocodeCandidates: located.geocodeCandidates,
      geocodeCandidatePct: matchResult.matched
        ? Math.round(
            (located.geocodeCandidates / matchResult.matched) * 1000,
          ) / 10
        : 0,
    },
    strategy:
      'T0–T3 account+amount+date; location = direct → entity → name → geocode candidate',
  };

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  // Examples: has location, geocode candidate, match only
  const withLoc = located.rows.filter((r) => r.location);
  const geo = located.rows.filter((r) => r.locationSource === 'geocode_candidate');
  const matchOnly = located.rows.filter(
    (r) => !r.location && r.locationSource !== 'geocode_candidate',
  );

  function printEx(title, rows) {
    console.log(`\n=== ${title} (up to ${SHOW}) ===`);
    for (const r of rows.slice(0, SHOW)) {
      const L = nonTransfer.find((x) => x.ynabId === r.ynabId);
      console.log(
        `${r.tier} conf=${r.confidence}  ledger ${L?.date} $${L ? ynabToDollars(L.amount).toFixed(2) : '?'} ${L?.payeeName || ''}`,
      );
      console.log(
        `  → plaid ${r.plaid.date} $${r.plaid.amount} ${r.plaid.merchant_name || r.plaid.name}  id=${r.plaid.transaction_id}`,
      );
      if (r.location) {
        console.log(
          `  LOC[${r.locationSource}] ${r.location.text || ''} lat=${r.location.lat} lon=${r.location.lon}`,
        );
      } else if (r.geocodeQuery) {
        console.log(`  GEOCODE CANDIDATE: "${r.geocodeQuery}" channel=${r.plaid.payment_channel}`);
      } else {
        console.log(`  no location (${r.plaid.payment_channel || 'channel?'})`);
      }
      if (process.env.SHOW_ENRICH) {
        console.log('  enrich', JSON.stringify(enrichmentRecord(r)));
      }
    }
  }

  printEx('WITH LOCATION', withLoc);
  printEx('GEOCODE CANDIDATES (in-store, no pin yet)', geo);
  printEx('MATCH ONLY (online/ACH/no path)', matchOnly);

  console.log('\nDone. No DDB writes.');
}

main().catch((e) => {
  console.error('POC failed:', e.message);
  if (e.plaid) console.error(JSON.stringify(e.plaid));
  process.exit(1);
});
