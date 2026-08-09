'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchLedgerToPlaid,
  matchVenmoDescriptions,
  parseVenmoPlaidName,
  isGenericVenmoLabel,
  isVenmoLikeLedger,
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
  it('abbreviates full US state names', () => {
    assert.equal(
      formatLocationDisplay({
        city: 'Bellevue',
        region: 'Washington',
        country: 'US',
      }),
      'Bellevue, WA',
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

  it('does not inherit when merchant has multiple cities (ambiguous)', () => {
    const multi = [
      {
        transaction_id: 'sb1',
        merchant_entity_id: 'ent-sb',
        merchant_name: 'Starbucks',
        name: 'Starbucks',
        location: { city: 'San Jose', region: 'CA', lat: 37.3, lon: -121.9 },
      },
      {
        transaction_id: 'sb2',
        merchant_entity_id: 'ent-sb',
        merchant_name: 'Starbucks',
        name: 'Starbucks',
        location: { city: 'Seattle', region: 'WA', lat: 47.6, lon: -122.3 },
      },
      {
        transaction_id: 'sb3',
        merchant_entity_id: 'ent-sb',
        merchant_name: 'Starbucks',
        name: 'STARBUCKS STORE 1234',
        payment_channel: 'in store',
        account_id: 'pa1',
        date: '2026-08-07',
        amount: 5.5,
        location: {},
      },
    ];
    const cache = buildMerchantLocationCache(multi);
    const ent = cache.byEntity.get('ent-sb');
    assert.equal(ent.ambiguous, true);
    const r = matchLedgerToPlaid(
      [
        {
          ynabId: 'ysb',
          date: '2026-08-07',
          amount: -5500,
          accountMask: '6553',
          payeeName: 'Starbucks',
        },
      ],
      multi,
      accounts,
    );
    const located = attachLocations(r, cache);
    const row = located.rows.find((x) => x.ynabId === 'ysb');
    assert.equal(row.location, null);
    assert.equal(row.locationSource, 'geocode_candidate');
  });
});

describe('merchantLocation helpers', () => {
  const {
    merchantNameKey,
    isMultiCityBrand,
    geocodeQueriesForMerchant,
    emptyCache,
    mergeIntoBucket,
    lookupEntity,
  } = require('../src/lib/merchantLocation');

  it('soft-normalizes store numbers and LLC', () => {
    assert.equal(merchantNameKey('Starbucks Store 1234'), 'starbucks');
    assert.equal(merchantNameKey('Cleanforme LLC'), 'cleanforme');
  });

  it('flags national brands', () => {
    assert.equal(isMultiCityBrand('Starbucks #99'), true);
    assert.equal(isMultiCityBrand("Don's Cafe"), false);
    assert.equal(isMultiCityBrand('Voyager Coffee'), false);
  });

  it('builds geocode queries with city priors for local merchants', () => {
    const qs = geocodeQueriesForMerchant(
      {
        merchant_name: "Don's Cafe",
        name: "DON'S CAFE",
        payment_channel: 'in store',
        location: {},
      },
      [{ city: 'Seattle', region: 'WA' }],
    );
    assert.ok(qs.some((q) => /Seattle/i.test(q)));
  });

  it('refuses bare geocode for multi-city brands without city', () => {
    const qs = geocodeQueriesForMerchant(
      {
        merchant_name: 'Starbucks',
        payment_channel: 'in store',
        location: {},
      },
      [],
    );
    assert.equal(qs.length, 0);
  });

  it('lookupEntity returns null when ambiguous', () => {
    const cache = emptyCache();
    mergeIntoBucket(
      cache.byEntity,
      'e1',
      { city: 'A', region: 'CA', lat: 1, lon: 2 },
      { merchant: 'X' },
    );
    mergeIntoBucket(
      cache.byEntity,
      'e1',
      { city: 'B', region: 'WA', lat: 3, lon: 4 },
      { merchant: 'X' },
    );
    assert.equal(lookupEntity(cache, 'e1'), null);
  });

  it('detects foreign place hints for travel merchants', () => {
    const { placeHintFromName } = require('../src/lib/merchantLocation');
    assert.equal(placeHintFromName('Singapore Food Street').country, 'SG');
    assert.equal(placeHintFromName('Jumbo Seafood Gallery').country, 'SG');
    assert.equal(placeHintFromName("Don's Cafe"), null);
  });
});

describe('Venmo description parse + match', () => {
  it('parses Person "note" into name - note display', () => {
    const p = parseVenmoPlaidName('Richard Mondor "City bags"');
    assert.equal(p.name, 'Richard Mondor');
    assert.equal(p.note, 'City bags');
    assert.equal(p.display, 'Richard Mondor - City bags');
  });

  it('detects generic Venmo bank labels', () => {
    assert.equal(isGenericVenmoLabel('Venmo'), true);
    assert.equal(isGenericVenmoLabel('VENMO PAYMENT 123 WEB ID: 1'), true);
    assert.equal(isGenericVenmoLabel('Richard Mondor - City bags'), false);
  });

  it('flags venmo-like ledger rows', () => {
    assert.equal(
      isVenmoLikeLedger({ payeeName: 'Venmo', importPayeeName: null }),
      true,
    );
    assert.equal(
      isVenmoLikeLedger({ payeeName: "Don's Cafe" }),
      false,
    );
  });

  it('matches bank Venmo ACH to Venmo Personal by amount+date', () => {
    const accounts = new Map([
      ['v1', { mask: null, name: 'Personal Profile', bankId: 'venmo' }],
      ['b1', { mask: '6803', name: 'Checkin', bankId: 'boa' }],
    ]);
    const ledger = [
      {
        ynabId: 'y-venmo',
        date: '2026-08-04',
        amount: -19000,
        payeeName: 'Venmo',
        importPayeeName: 'Venmo',
        accountMask: '6803',
      },
    ];
    const plaid = [
      {
        transaction_id: 'pt-venmo',
        account_id: 'v1',
        date: '2026-08-04',
        amount: 19,
        name: 'Richard Mondor "City bags"',
        merchant_name: null,
        category: ['Transfer', 'Third Party', 'Venmo'],
      },
      {
        transaction_id: 'pt-bank',
        account_id: 'b1',
        date: '2026-08-04',
        amount: 19,
        name: 'Venmo',
        merchant_name: 'Venmo',
      },
    ];
    const matches = matchVenmoDescriptions(ledger, plaid, accounts);
    assert.equal(matches.size, 1);
    const m = matches.get('y-venmo');
    assert.equal(m.plaid.name, 'Richard Mondor "City bags"');
    assert.equal(m.parsed.display, 'Richard Mondor - City bags');
  });
});
