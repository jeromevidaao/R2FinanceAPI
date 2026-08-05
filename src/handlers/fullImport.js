'use strict';

const sync = require('../lib/sync');

/** One-shot full YNAB → DDB import. */
exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'R2Finance fullImport start' }));
  const report = await sync.fullImport({
    sinceDate: event?.sinceDate || '1990-01-01',
  });
  console.log(JSON.stringify({ msg: 'fullImport done', counts: report.counts }));
  return { ok: true, ...report };
};
