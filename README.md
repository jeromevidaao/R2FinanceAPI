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

```
Phone (Room)  ──POST /v1/device/push──►  DynamoDB  ──pushPending / 15m──►  YNAB
     ▲                                      │
     └──────── GET /v1/* hydrate ───────────┘
```

1. **Full import** (`R2FinanceFullImport` or `POST /v1/sync/import`) — all accounts, categories, payees, transactions, scheduled → DDB  
2. **Delta pull** (`R2FinanceYnabPull` / `POST /v1/sync/pull`) — YNAB `last_knowledge_of_server` → upsert DDB  
   - **Does not overwrite** rows with `syncStatus=PENDING_PUSH` (preserves local categorize until push)  
3. **Device push** (`POST /v1/device/push`) — Android offline queue (new txns, categorize, approve) → DDB `PENDING_PUSH`  
4. **Push to YNAB** (`R2FinanceYnabPush` / `POST /v1/sync/push`) — DDB `PENDING_PUSH` → YNAB create/update  
5. **Categorize/approve API** — still available; Android prefers device push after local Room write  
6. **Bidirectional** — phone offline for hours is fine; reconnect → DDB; YNAB ≤15 min later

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
| POST | `/v1/sync/push` | Push pending DDB → YNAB |
| POST | `/v1/sync/tick` | Pull then push |
| POST | `/v1/device/push` | **Phone → DDB** offline queue (no YNAB wait) |
| POST | `/v1/transactions/categorize` | Categorize in DDB → push YNAB |
| POST | `/v1/transactions/approve` | Approve in DDB → push YNAB |
| POST | `/v1/auth/forgot-password` | Email one-time reset link → finance.i-liquid.be |
| POST | `/v1/auth/reset-password` | Set new password with token from email |
| POST | `/v1/auth/invite` | Admin session only — create user + email set-password (CC admin) |
| GET | `/v1/connectors/boa` | Bank of America (Plaid) connection status (session required) |
| POST | `/v1/connectors/boa/link-token` | Create Plaid Link token for BoA |
| POST | `/v1/connectors/boa/exchange` | Exchange public_token → store access (Secrets Manager) |
| GET | `/v1/connectors/boa/accounts` | Live probe of BoA accounts/balances (not DDB ledger) |
| POST | `/v1/connectors/boa/disconnect` | Remove Plaid item + clear stored token |

Password / invite mail is sent from **`no-reply@i-liquid.be`** (SES + DKIM on `i-liquid.be`).

### Bank of America connector (Plaid)

Establishes read access to BoA (credit cards / deposits) via [Plaid Link](https://plaid.com).  
**Does not** write bank transactions into DynamoDB ledger `TXN#` rows yet.

1. Create a Plaid account → Dashboard API keys.
2. Register redirect URI `https://finance.i-liquid.be/connectors` for OAuth (BoA).
3. Put credentials in Secrets Manager:

```bash
aws secretsmanager create-secret --name R2Finance/plaid --secret-string '{
  "client_id": "…",
  "secret": "…",
  "env": "sandbox"
}' --region us-east-1
# env: sandbox | development | production
```

4. On the website: **Connectors → Connect Bank of America**.
5. Connected item token is stored at `R2Finance/connectors/boa` (not in the browser).

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
