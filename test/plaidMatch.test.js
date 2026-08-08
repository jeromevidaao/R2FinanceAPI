'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchLedgerToPlaid,
  attachLocations,
  buildMerchantLocationCache,
  nameScore,
  amountsAlign,
} = require('../src/lib/plaidMatch');
const { formatLocationDisplay } = require('../src/lib/plaidEnrich');

describe('formatLocationDisplay', () => {
  it('formats US as city, state', () => {
    assert.equal(
      formatLocationDisplay({
        city: 'Los Gatos',
        region: 'CA',
        country: 'US',
      }),
      'Los Gatos, CA',
    );
  });
  it('defaults missing country to US style', () => {
    assert.equal(
      formatLocationDisplay({ city: 'SeaTac', region: null }),
      'SeaTac',
    );
    assert.equal(
      formatLocationDisplay({ city: 'Kirkland', region: 'WA' }),
      'Kirkland, WA',
    );
  });
  it('formats non-US as city, country', () => {
    assert.equal(
      formatLocationDisplay({
        city: 'Phu Quoc',
        region: null,
        country: 'Vietnam',
      }),
      'Phu Quoc, Vietnam',
    );
  });
});

describe('plaidMatch amountsAlign', () => {
  it('maps YNAB outflow milliunits to Plaid positive dollars', () => {
    const r = amountsAlign(-23620, 23.62);
    assert.equal(r.ok, true);
    assert.equal(r.opposite, true);
  });
});

describe('plaidMatch nameScore', () => {
  it('scores Cleanforme variants highly', () => {
    assert.ok(nameScore('Cleanforme', 'Cleanforme LLC') >= 0.8);
  });
});

describe('plaidMatch tiered match + location', () => {
  const accounts = new Map([
    ['pa1', { mask: '6553', name: 'Freedom' }],
    ['pa2', { mask: '8053', name: 'Reserve' }],
  ]);

  const ledger = [
    {
      ynabId: 'y1',
      date: '2026-08-06',
      amount: -23620,
      accountMask: '8053',
      payeeName: 'Tesla Supercharger',
    },
    {
      ynabId: 'y2',
      date: '2026-08-07',
      amount: -120000,
      accountMask: '6553',
      payeeName: 'Cleanforme',
    },
    {
      ynabId: 'y3',
      date: '2026-08-07',
      amount: -125000,
      accountMask: '6553',
      payeeName: 'Cleanforme',
    },
  ];

  const plaidTxns = [
    {
      transaction_id: 'p-tesla',
      account_id: 'pa2',
      date: '2026-08-06',
      authorized_date: '2026-08-06',
      amount: 23.62,
      name: 'TESLA SUPERCHARGER',
      merchant_name: 'Tesla',
      merchant_entity_id: 'ent-tesla',
      payment_channel: 'in store',
      location: {
        address: null,
        city: null,
        lat: null,
        lon: null,
      },
    },
    {
      transaction_id: 'p-cf-120',
      account_id: 'pa1',
      date: '2026-08-07',
      authorized_date: '2026-08-07',
      amount: 120,
      name: 'CLEANFORME LLC',
      merchant_name: 'Cleanforme LLC',
      payment_channel: 'in store',
      location: {},
    },
    {
      transaction_id: 'p-cf-125',
      account_id: 'pa1',
      date: '2026-08-07',
      authorized_date: '2026-08-07',
      amount: 125,
      name: 'CLEANFORME LLC',
      merchant_name: 'Cleanforme LLC',
      payment_channel: 'in store',
      location: {},
    },
    // Historical pin for Tesla entity
    {
      transaction_id: 'p-tesla-old',
      account_id: 'pa2',
      date: '2026-07-01',
      amount: 10,
      name: 'TESLA',
      merchant_name: 'Tesla',
      merchant_entity_id: 'ent-tesla',
      payment_channel: 'in store',
      location: {
        address: '1 Infinite Loop',
        city: 'Cupertino',
        region: 'CA',
        lat: 37.33,
        lon: -122.03,
      },
    },
  ];

  it('matches all three 1:1 without colliding Cleanforme amounts', () => {
    const r = matchLedgerToPlaid(ledger, plaidTxns, accounts);
    assert.equal(r.matched, 3);
    assert.equal(r.matches.get('y1').plaid.transaction_id, 'p-tesla');
    assert.equal(r.matches.get('y2').plaid.transaction_id, 'p-cf-120');
    assert.equal(r.matches.get('y3').plaid.transaction_id, 'p-cf-125');
    assert.equal(r.matches.get('y1').tier, 'T0');
  });

  it('inherits location from merchant_entity_id cache', () => {
    const cache = buildMerchantLocationCache(plaidTxns);
    const r = matchLedgerToPlaid(ledger, plaidTxns, accounts);
    const located = attachLocations(r, cache);
    const tesla = located.rows.find((x) => x.ynabId === 'y1');
    assert.ok(tesla.location);
    assert.equal(tesla.locationSource, 'merchant_entity');
    assert.equal(tesla.location.city, 'Cupertino');
    // Cleanforme: no cache → geocode candidate
    const cf = located.rows.find((x) => x.ynabId === 'y2');
    assert.equal(cf.location, null);
    assert.equal(cf.locationSource, 'geocode_candidate');
  });
});
