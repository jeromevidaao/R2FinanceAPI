'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAmazonChargeRef,
  isAmazonRetailBlob,
  parseMoneyToMilli,
  summarizeItems,
  normalizeIncomingOrder,
  matchOrderForTxn,
  enhanceDisplayPayee,
  orderUrlFor,
} = require('../src/lib/amazonOrders');

describe('amazonOrders', () => {
  it('extracts marketplace charge refs', () => {
    assert.equal(
      extractAmazonChargeRef('AMAZON MKTPL*LR52S7I73'),
      'LR52S7I73',
    );
    assert.equal(
      extractAmazonChargeRef('Amazon.com*RN0L04R61'),
      'RN0L04R61',
    );
    assert.equal(
      extractAmazonChargeRef('AMZN Mktp US*AB12C3D4E'),
      'AB12C3D4E',
    );
    assert.equal(extractAmazonChargeRef('Whole Foods'), null);
  });

  it('detects retail amazon blobs and skips salary', () => {
    assert.equal(isAmazonRetailBlob('AMAZON MKTPL*LR52S7I73'), true);
    assert.equal(isAmazonRetailBlob('Amazon.com*X'), true);
    assert.equal(isAmazonRetailBlob('Ruby Amazon Salary'), false);
    assert.equal(isAmazonRetailBlob('Jerome Amazon Stock'), false);
  });

  it('parses money to absolute milliunits', () => {
    assert.equal(parseMoneyToMilli('$19.99'), 19990);
    assert.equal(parseMoneyToMilli('1,234.50'), 1234500);
    assert.equal(parseMoneyToMilli(12.34), 12340);
  });

  it('summarizes item titles', () => {
    assert.equal(
      summarizeItems(['USB Cable', 'HDMI Adapter', 'Tape', 'Batteries'], 2),
      'USB Cable, HDMI Adapter (+2 more)',
    );
  });

  it('normalizes incoming orders', () => {
    const o = normalizeIncomingOrder({
      orderNumber: '112-1234567-8901234',
      orderDate: 'January 5, 2026',
      grandTotal: '$45.99',
      items: ['USB-C Cable'],
    });
    assert.equal(o.orderNumber, '112-1234567-8901234');
    assert.equal(o.orderDate, '2026-01-05');
    assert.equal(o.grandTotalMilli, 45990);
    assert.equal(o.items[0], 'USB-C Cable');
    assert.match(o.orderUrl, /orderID=112-1234567-8901234/);
  });

  it('matches by charge ref first', () => {
    const orders = [
      {
        orderNumber: '111-1',
        orderDate: '2026-02-01',
        grandTotalMilli: 10000,
        chargeRefs: ['LR52S7I73'],
        items: ['Widget'],
        orderUrl: orderUrlFor('111-1'),
      },
    ];
    const byRef = new Map([['LR52S7I73', orders]]);
    const hit = matchOrderForTxn(
      {
        amount: -10000,
        date: '2026-02-02',
        payload: { payee_name: 'AMAZON MKTPL*LR52S7I73' },
      },
      orders,
      byRef,
    );
    assert.equal(hit.method, 'charge_ref');
    assert.equal(hit.order.orderNumber, '111-1');
  });

  it('matches by amount + date when unique', () => {
    const orders = [
      {
        orderNumber: '222-2',
        orderDate: '2026-03-01',
        grandTotalMilli: 25990,
        chargeRefs: [],
        items: ['Book'],
        orderUrl: orderUrlFor('222-2'),
      },
    ];
    const hit = matchOrderForTxn(
      {
        amount: -25990,
        date: '2026-03-02',
        importPayeeName: 'Amazon',
        payload: { payee_name: 'Amazon.com' },
      },
      orders,
      new Map(),
    );
    assert.equal(hit.method, 'amount_date');
    assert.equal(hit.order.orderNumber, '222-2');
  });

  it('enhances display payee with items', () => {
    assert.equal(
      enhanceDisplayPayee('AMAZON MKTPL*LR52S7I73', {
        amazonItemsSummary: 'USB-C Cable, HDMI Adapter',
      }),
      'AMAZON MKTPL*LR52S7I73 — USB-C Cable, HDMI Adapter',
    );
  });

  it('enhances display payee with items + ship city/state', () => {
    assert.equal(
      enhanceDisplayPayee('AMAZON MKTPL*LR52S7I73', {
        amazonItemsSummary: 'USB-C Cable',
        amazonShipCity: 'Portland',
        amazonShipState: 'ME',
      }),
      'AMAZON MKTPL*LR52S7I73 — USB-C Cable · Portland, ME',
    );
    assert.equal(
      enhanceDisplayPayee('Amazon.com*RN0L04R61', {
        amazonShipLocation: 'Seattle, WA',
      }),
      'Amazon.com*RN0L04R61 · Seattle, WA',
    );
  });

  it('normalizes ship city/state on incoming orders', () => {
    const o = normalizeIncomingOrder({
      orderNumber: '112-1234567-8901234',
      shipCity: 'Portland',
      shipState: 'me',
      items: ['Widget'],
    });
    assert.equal(o.shipCity, 'Portland');
    assert.equal(o.shipState, 'ME');
    assert.equal(o.shipLocation, 'Portland, ME');
  });

  it('heals full-address shipCity into City, ST', () => {
    const o = normalizeIncomingOrder({
      orderNumber: '112-1234567-8901234',
      shipCity: 'Richard Mondor 53 PINE ST APT 1F PORTLAND ME',
      shipState: null,
      items: ['Widget'],
    });
    assert.equal(o.shipCity, 'Portland');
    assert.equal(o.shipState, 'ME');
    assert.equal(o.shipLocation, 'Portland, ME');
  });
});
