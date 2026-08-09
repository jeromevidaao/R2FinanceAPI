#!/usr/bin/env node
'use strict';

/**
 * Live E2E: seed Amazon orders that amount/date-match real AMAZON MKTPL*LR52S7I73
 * bank rows, run matchAndStampTransactions, verify DDB stamps + display payee,
 * then optionally clean up (--keep to leave stamps for UI inspection).
 *
 * Usage:
 *   node scripts/test-amazon-match-live.js           # stamp, verify, cleanup
 *   node scripts/test-amazon-match-live.js --keep    # leave stamps in place
 *   node scripts/test-amazon-match-live.js --cleanup-only
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.R2FINANCE_TABLE = process.env.R2FINANCE_TABLE || 'R2Finance';
process.env.R2FINANCE_PLAN_ID = process.env.R2FINANCE_PLAN_ID || 'default';

const amazonOrders = require('../src/lib/amazonOrders');

const KEEP = process.argv.includes('--keep');
const CLEANUP_ONLY = process.argv.includes('--cleanup-only');
const TEST_ORDER_PREFIX = '999-0000001-'; // synthetic; won't collide with real 113/114

const raw = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});
const table = process.env.R2FINANCE_TABLE;
const planPk = `PLAN#${process.env.R2FINANCE_PLAN_ID}`;

async function findLr52Txns() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression:
          'contains(payload.payee_name, :a) OR contains(payload.import_payee_name, :a)',
        ExpressionAttributeValues: { ':a': 'LR52S7I73' },
        ExclusiveStartKey,
      }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.filter((t) => !t.deleted);
}

async function cleanupTestOrdersAndStamps(txns) {
  // Delete synthetic orders
  for (let i = 0; i < 20; i++) {
    const n = `${TEST_ORDER_PREFIX}${String(i + 1).padStart(7, '0')}`;
    await ddb.send(
      new DeleteCommand({
        TableName: table,
        Key: { pk: planPk, sk: `AMAZON#ORDER#${n}` },
      }),
    );
  }
  // Clear amazon* stamps only on txns we stamped with test orders
  for (const t of txns) {
    if (
      t.amazonOrderNumber &&
      String(t.amazonOrderNumber).startsWith(TEST_ORDER_PREFIX)
    ) {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: t.pk, sk: t.sk },
          UpdateExpression:
            'REMOVE amazonOrderNumber, amazonOrderUrl, amazonItems, amazonItemsSummary, amazonShipCity, amazonShipState, amazonShipLocation, amazonMatchedAt, amazonMatchMethod SET updatedAt = :u',
          ExpressionAttributeValues: { ':u': Date.now() },
        }),
      );
    }
  }
}

async function main() {
  console.log('=== Amazon match live E2E ===');
  const txns = await findLr52Txns();
  console.log(`Found ${txns.length} bank rows with LR52S7I73`);
  if (!txns.length) {
    console.error('No LR52S7I73 transactions — abort');
    process.exit(1);
  }

  if (CLEANUP_ONLY) {
    await cleanupTestOrdersAndStamps(txns);
    console.log('Cleanup done');
    return;
  }

  // Build one synthetic order per bank charge (unique amount+date).
  const seedOrders = txns.map((t, i) => {
    const amt = Math.abs(Number(t.amount || t.payload?.amount || 0));
    const date = t.date || t.payload?.date;
    const dollars = (amt / 1000).toFixed(2);
    const orderNumber = `${TEST_ORDER_PREFIX}${String(i + 1).padStart(7, '0')}`;
    // Order placed day before bank post (common lag)
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const orderDate = d.toISOString().slice(0, 10);
    return {
      orderNumber,
      orderDate,
      grandTotal: `$${dollars}`,
      items: [`E2E test item for $${dollars}`],
      shipCity: 'Portland',
      shipState: 'ME',
      chargeRefs: ['LR52S7I73'],
      domain: 'www.amazon.com',
    };
  });

  console.log('Seeding orders:');
  for (const o of seedOrders) {
    console.log(`  ${o.orderNumber} ${o.orderDate} ${o.grandTotal} ${o.items[0]}`);
  }

  const upsert = await amazonOrders.upsertOrders(seedOrders);
  console.log('upsertOrders result:', JSON.stringify(upsert, null, 2));

  // Re-fetch LR52 rows
  const after = await findLr52Txns();
  let stamped = 0;
  const failures = [];
  for (const t of after) {
    const payee = t.payload?.payee_name || t.payload?.import_payee_name;
    const label = amazonOrders.enhanceDisplayPayee(payee, t);
    const ok =
      t.amazonOrderNumber &&
      String(t.amazonOrderNumber).startsWith(TEST_ORDER_PREFIX) &&
      t.amazonItemsSummary &&
      t.amazonShipLocation === 'Portland, ME' &&
      label &&
      label.includes('E2E test item') &&
      label.includes('Portland, ME');
    if (ok) {
      stamped += 1;
      console.log(`  OK ${t.date} ${t.amount} → ${label}`);
    } else {
      failures.push({
        sk: t.sk,
        date: t.date,
        amount: t.amount,
        amazonOrderNumber: t.amazonOrderNumber,
        amazonItemsSummary: t.amazonItemsSummary,
        amazonShipLocation: t.amazonShipLocation,
        label,
      });
      console.log(`  FAIL ${t.date} ${t.amount}`, failures[failures.length - 1]);
    }
  }

  console.log(`\nStamped OK: ${stamped}/${after.length}`);
  if (failures.length) {
    console.error('FAILURES', failures);
    if (!KEEP) await cleanupTestOrdersAndStamps(after);
    process.exit(2);
  }

  // Simulate listInbox payee enhancement for one row
  const sample = after[0];
  const display = amazonOrders.enhanceDisplayPayee(
    sample.payload?.payee_name || 'AMAZON MKTPL*LR52S7I73',
    sample,
  );
  console.log('\nSample categorize/inbox payee line:');
  console.log(`  ${display}`);
  assertLikeReal(display);

  if (KEEP) {
    console.log('\n--keep: leaving test orders + stamps for UI check. Run with --cleanup-only later.');
  } else {
    await cleanupTestOrdersAndStamps(after);
    console.log('\nCleaned up test orders + stamps.');
  }
  console.log('PASS');
}

function assertLikeReal(display) {
  if (!/AMAZON MKTPL\*LR52S7I73 — E2E test item/.test(display)) {
    throw new Error(`unexpected display: ${display}`);
  }
  if (!display.includes('Portland, ME')) {
    throw new Error(`missing ship: ${display}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
