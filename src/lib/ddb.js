'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  BatchWriteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { region, tableName, gsi2, ledgerPlanId } = require('./config');

const raw = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});

function planPk(planId = ledgerPlanId) {
  return `PLAN#${planId}`;
}

async function putItem(item) {
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}

async function getItem(pk, sk) {
  const out = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk } }),
  );
  return out.Item;
}

async function queryPk(pk, skPrefix) {
  const params = {
    TableName: tableName,
    KeyConditionExpression: skPrefix
      ? 'pk = :pk AND begins_with(sk, :sk)'
      : 'pk = :pk',
    ExpressionAttributeValues: skPrefix
      ? { ':pk': pk, ':sk': skPrefix }
      : { ':pk': pk },
  };
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await ddb.send(
      new QueryCommand({ ...params, ExclusiveStartKey }),
    );
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function batchWrite(items) {
  // 25 per batch
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let requestItems = {
      [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })),
    };
    let attempts = 0;
    while (requestItems && Object.keys(requestItems).length) {
      const out = await ddb.send(
        new BatchWriteCommand({ RequestItems: requestItems }),
      );
      requestItems = out.UnprocessedItems;
      if (requestItems && Object.keys(requestItems).length) {
        attempts += 1;
        if (attempts > 8) throw new Error('BatchWrite unprocessed overflow');
        await new Promise((r) => setTimeout(r, 50 * attempts));
      }
    }
  }
}

async function queryPendingPush(limit = 50) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: gsi2,
      KeyConditionExpression: 'gsi2pk = :p',
      ExpressionAttributeValues: { ':p': 'PENDING_PUSH' },
      Limit: limit,
      ScanIndexForward: true,
    }),
  );
  return out.Items || [];
}

async function markSynced(pk, sk, extra = {}) {
  const now = Date.now();
  const names = { '#ss': 'syncStatus' };
  // lastPushedAt: when this row was successfully written to YNAB (outbound).
  // Callers can override via extra; default is "now" so category/approve/create
  // pushes are visible on Reflect without a separate audit table.
  const values = {
    ':s': 'SYNCED',
    ':u': now,
    ':lp': extra.lastPushedAt != null ? extra.lastPushedAt : now,
  };
  let update =
    'SET #ss = :s, updatedAt = :u, lastPushedAt = :lp REMOVE gsi2pk, gsi2sk';
  let i = 0;
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'lastPushedAt') continue; // already applied as :lp
    i += 1;
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    update = update.replace(
      'REMOVE',
      `, #k${i} = :v${i} REMOVE`,
    );
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression: update,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Mark a transaction as pending push (e.g. after local categorize).
 */
async function markTransactionPendingPush(planId, txnId, fields) {
  const pk = planPk(planId);
  const sk = `TXN#${txnId}`;
  const now = Date.now();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        'SET categoryId = :c, approved = :a, #ss = :s, updatedAt = :u, gsi2pk = :g2, gsi2sk = :g2sk, payload = :p',
      ExpressionAttributeNames: { '#ss': 'syncStatus' },
      ExpressionAttributeValues: {
        ':c': fields.categoryId ?? null,
        ':a': fields.approved ?? true,
        ':s': 'PENDING_PUSH',
        ':u': now,
        ':g2': 'PENDING_PUSH',
        ':g2sk': `${String(now).padStart(15, '0')}#${txnId}`,
        ':p': fields.payload,
      },
    }),
  );
}

module.exports = {
  ddb,
  planPk,
  putItem,
  getItem,
  queryPk,
  batchWrite,
  queryPendingPush,
  markSynced,
  markTransactionPendingPush,
  tableName,
};
