# R2FinanceAPI

AWS backend for **R2Finance** — DynamoDB ledger + YNAB bidirectional sync.

**Android:** [R2FinanceAndroid](https://github.com/jeromevidaao/R2FinanceAndroid)

## Live stack (us-east-1)

| Resource | Name / value |
|----------|----------------|
| DynamoDB | `R2Finance` (on-demand) |
| Secret | `R2Finance/ynab-pat` (Secrets Manager) |
| IAM | `R2FinanceLambdaRole` |
| Lambdas | `R2FinanceApiHandler`, `R2FinanceYnabPull`, `R2FinanceYnabPush`, `R2FinanceFullImport` |
| Schedule | `R2FinanceYnabPullSchedule` — **every 15 minutes** (pull + push) |
| HTTP API | `R2FinanceAPI` → `https://x0wiir7m27.execute-api.us-east-1.amazonaws.com` |

## Sync model

1. **Full import** (`R2FinanceFullImport` or `POST /v1/sync/import`) — all accounts, categories, payees, transactions, scheduled → DDB  
2. **Delta pull** (`R2FinanceYnabPull` / `POST /v1/sync/pull`) — YNAB `last_knowledge_of_server` → upsert DDB  
3. **Push** (`R2FinanceYnabPush` / `POST /v1/sync/push`) — items with `syncStatus=PENDING_PUSH` (e.g. categorize) → YNAB API  
4. **Categorize API** — `POST /v1/transactions/categorize` with `{ ynabTxnId, categoryYnabId }` marks pending + optional immediate push  

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health |
| GET | `/v1/stats` | Counts by entity type |
| GET | `/v1/accounts` | Accounts from DDB |
| GET | `/v1/categories` | Categories from DDB |
| GET | `/v1/inbox` | Unapproved + uncategorized (YNAB-style needs-attention) |
| POST | `/v1/sync/import` | Full import |
| POST | `/v1/sync/pull` | Delta pull |
| POST | `/v1/sync/push` | Push pending |
| POST | `/v1/sync/tick` | Pull then push |
| POST | `/v1/transactions/categorize` | Categorize in DDB → push YNAB |
| POST | `/v1/transactions/approve` | Approve in DDB → push YNAB |

## Deploy

```bash
npm install
bash scripts/deploy.sh
bash scripts/invoke-import.sh   # full YNAB → DDB
```

## Cost

API Gateway HTTP + Lambda + DynamoDB on-demand only. 15‑minute schedule stays under YNAB’s **200 req/h** limit for personal use.

## Security

- PAT only in Secrets Manager — never commit tokens  
- HTTP API is currently open (personal); add auth before any public use  
