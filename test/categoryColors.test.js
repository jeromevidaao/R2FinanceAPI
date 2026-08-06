'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  colorForCategory,
  UNCATEGORIZED,
  ALL_OTHERS,
  isHexColor,
} = require('../src/lib/categoryColors');

describe('categoryColors', () => {
  it('preserves existing hex color', () => {
    assert.equal(
      colorForCategory({
        name: 'Food',
        ynabId: 'abc',
        existingColor: '#112233',
      }),
      '#112233',
    );
  });

  it('maps uncategorized to indigo', () => {
    assert.equal(
      colorForCategory({ name: 'Uncategorized', ynabId: 'x' }),
      UNCATEGORIZED,
    );
  });

  it('is stable for the same ynabId', () => {
    const a = colorForCategory({ name: 'Rent', ynabId: 'cat-stable-1' });
    const b = colorForCategory({ name: 'Rent', ynabId: 'cat-stable-1' });
    assert.equal(a, b);
    assert.ok(isHexColor(a));
  });

  it('uses name hints when no existing color', () => {
    assert.equal(
      colorForCategory({ name: 'Business Trips', ynabId: 'bt-1' }),
      '#22C55E',
    );
    assert.equal(
      colorForCategory({ name: 'Airbnb Cleaning', ynabId: 'ac-1' }),
      '#EAB308',
    );
  });

  it('exports All Others color', () => {
    assert.equal(ALL_OTHERS, '#A5B4FC');
  });
});
