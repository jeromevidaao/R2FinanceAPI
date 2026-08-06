'use strict';

/**
 * Stable category colors for Reflect / Spending Breakdown (Android + website).
 * Stored on each CAT# item in DynamoDB so both clients render identically.
 *
 * Palette inspired by YNAB Reflect screenshot:
 * indigo, green, gold, red, violet, light indigo, plus extras for long tails.
 */
const PALETTE = [
  '#6366F1', // indigo / blue-purple (Uncategorized default)
  '#22C55E', // green (Business Trips)
  '#EAB308', // yellow / gold (Airbnb Cleaning)
  '#EF4444', // red (Airbnb Professional Fees)
  '#8B5CF6', // violet (Vietnam Trip)
  '#A5B4FC', // light indigo (All Others)
  '#06B6D4', // cyan
  '#F97316', // orange
  '#EC4899', // pink
  '#14B8A6', // teal
  '#3B82F6', // blue
  '#84CC16', // lime
  '#F43F5E', // rose
  '#0EA5E9', // sky
  '#A855F7', // purple
  '#65A30D', // olive
];

const UNCATEGORIZED = '#6366F1';
const ALL_OTHERS = '#A5B4FC';

/** Prefer readable colors for known category names (first assignment only). */
const NAME_HINTS = [
  [/uncategor/i, UNCATEGORIZED],
  [/business\s*trip/i, '#22C55E'],
  [/airbnb\s*cleaning|cleaning/i, '#EAB308'],
  [/professional\s*fee/i, '#EF4444'],
  [/vietnam/i, '#8B5CF6'],
  [/\brent\b/i, '#F97316'],
  [/apparel|accessories/i, '#EC4899'],
  [/education/i, '#0EA5E9'],
  [/japan/i, '#A855F7'],
];

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
}

function hashId(id) {
  let h = 2166136261;
  const s = String(id || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Resolve color for a category. Preserves existing DDB color when set.
 * @param {{ name?: string, ynabId?: string, existingColor?: string|null }} opts
 * @returns {string} hex color
 */
function colorForCategory({ name, ynabId, existingColor } = {}) {
  if (isHexColor(existingColor)) return existingColor;
  const n = name || '';
  if (!ynabId || /uncategor/i.test(n)) return UNCATEGORIZED;
  for (const [re, hex] of NAME_HINTS) {
    if (re.test(n)) return hex;
  }
  return PALETTE[hashId(ynabId) % PALETTE.length];
}

module.exports = {
  PALETTE,
  UNCATEGORIZED,
  ALL_OTHERS,
  colorForCategory,
  isHexColor,
};
