'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseImportPayeeName,
  extractCardEnding,
  formatCreditPaymentPayee,
  cleanPlaidMerchantName,
  resolveDisplayPayee,
} = require('../src/lib/displayPayee');

const accounts = [
  { name: 'Family Checkin 6022', type: 'checking' },
  { name: 'Family Reserve 8053', type: 'creditCard' },
  { name: 'Family Freedom 6553', type: 'creditCard' },
  { name: 'Amazon 6129', type: 'creditCard' },
];

describe('displayPayee', () => {
  it('parses YNAB match-suggestion JSON import_payee_name', () => {
    const raw = JSON.stringify({
      payeeId: 'x',
      importedPayee: 'Chase Credit Card',
      accepted: false,
    });
    assert.equal(parseImportPayeeName(raw), 'Chase Credit Card');
    assert.equal(parseImportPayeeName('Whole Foods'), 'Whole Foods');
    assert.equal(parseImportPayeeName('{not-json'), null);
  });

  it('extracts card ending from Plaid payment labels', () => {
    assert.equal(
      extractCardEnding('PAYMENT TO CHASE CARD ENDING IN 8053 08/07'),
      '8053',
    );
    assert.equal(extractCardEnding('Payment to card ending in 6553'), '6553');
    assert.equal(extractCardEnding('Coffee Shop'), null);
  });

  it('formats reconciliation-style credit payment payee from account map', () => {
    assert.equal(
      formatCreditPaymentPayee('8053', accounts),
      'Payment for credit Family Reserve (ending 8053)',
    );
    assert.equal(
      formatCreditPaymentPayee('6553', accounts),
      'Payment for credit Family Freedom (ending 6553)',
    );
    assert.equal(
      formatCreditPaymentPayee('9999', accounts),
      'Payment for credit card (ending 9999)',
    );
  });

  it('cleans ALL-CAPS Plaid merchant and trailing dates', () => {
    // Short tokens (TO, IN) stay uppercase; trailing MM/DD stripped.
    assert.equal(
      cleanPlaidMerchantName('PAYMENT TO CHASE CARD ENDING IN 8053 08/07'),
      'Payment TO Chase Card Ending IN 8053',
    );
  });

  it('prefers named payee over Plaid', () => {
    assert.equal(
      resolveDisplayPayee({
        payeeName: 'Transfer : Family Reserve 8053',
        plaidMerchantName: 'PAYMENT TO CHASE CARD ENDING IN 8053 08/07',
        plaidPfc: 'LOAN_PAYMENTS',
        accounts,
      }),
      'Transfer : Family Reserve 8053',
    );
  });

  it('uses Plaid LOAN_PAYMENTS + ending to build Payment for credit …', () => {
    assert.equal(
      resolveDisplayPayee({
        payeeName: null,
        plaidMerchantName: 'PAYMENT TO CHASE CARD ENDING IN 8053 08/07',
        plaidPfc: 'LOAN_PAYMENTS',
        importPayeeName: JSON.stringify({
          importedPayee: 'Chase Credit Card',
          accepted: false,
        }),
        accounts,
      }),
      'Payment for credit Family Reserve (ending 8053)',
    );
  });

  it('uses transfer account name when payee empty', () => {
    assert.equal(
      resolveDisplayPayee({
        transferAccountName: 'Family Freedom 6553',
        accounts,
      }),
      'Transfer : Family Freedom 6553',
    );
  });

  it('falls back to cleaned Plaid merchant for normal spends', () => {
    assert.equal(
      resolveDisplayPayee({
        plaidMerchantName: 'WHOLE FOODS #10234',
        plaidPfc: 'GENERAL_MERCHANDISE',
        accounts,
      }),
      'Whole Foods #10234',
    );
  });

  it('returns null when nothing known', () => {
    assert.equal(resolveDisplayPayee({ accounts }), null);
  });
});
