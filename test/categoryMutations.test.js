const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSystemCategoryGroupName,
  isSystemCategoryName,
  mapCategory,
} = require('../src/lib/sync');

describe('category mutations helpers', () => {
  it('flags system groups', () => {
    assert.equal(isSystemCategoryGroupName('Internal Master Category'), true);
    assert.equal(isSystemCategoryGroupName('Credit Card Payments'), true);
    assert.equal(isSystemCategoryGroupName('Hidden Categories'), true);
    assert.equal(isSystemCategoryGroupName('Everyday Expenses'), false);
  });

  it('flags system category names', () => {
    assert.equal(isSystemCategoryName('Uncategorized'), true);
    assert.equal(isSystemCategoryName('Inflow: Ready to Assign'), true);
    assert.equal(isSystemCategoryName('Groceries'), false);
  });

  it('mapCategory strips internal fields', () => {
    const m = mapCategory({
      ynabId: 'c1',
      name: 'Coffee',
      categoryGroupId: 'g1',
      hidden: false,
      color: '#abc',
      deleted: false,
      userDeleted: true,
    });
    assert.deepEqual(m, {
      ynabId: 'c1',
      name: 'Coffee',
      categoryGroupId: 'g1',
      hidden: false,
      color: '#abc',
      deleted: false,
    });
  });
});
