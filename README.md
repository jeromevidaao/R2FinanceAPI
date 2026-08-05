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
| POST | `/v1/auth/login` | Password login; **on session issued** → FCM sign-in alert to topic `r2finance_updates` |
| POST | `/v1/auth/mfa/verify` | MFA complete → session + same FCM sign-in alert |
| POST | `/v1/auth/forgot-password` | Email one-time reset link → finance.i-liquid.be |
| POST | `/v1/auth/reset-password` | Set new password with token from email |
| POST | `/v1/auth/invite` | Admin session only — create user + email set-password (CC admin) |
| GET | `/v1/connectors` | List bank connector statuses (session required) |
| GET | `/v1/connectors/{boa\|chase\|vanguard}` | Connection status for one bank |
| POST | `/v1/connectors/{boa\|chase\|vanguard}/link-token` | Create Plaid Link token |
| POST | `/v1/connectors/{boa\|chase\|vanguard}/exchange` | Exchange public_token → store access |
| GET | `/v1/connectors/{boa\|chase\|vanguard}/accounts` | Live probe accounts/balances (not DDB ledger) |
| POST | `/v1/connectors/{boa\|chase\|vanguard}/disconnect` | Remove Plaid item + clear stored token |

Password / invite mail is sent from **`no-reply@i-liquid.be`** (SES + DKIM on `i-liquid.be`).

### Bank connectors (Plaid) — per email × bank

Generic bank catalog: **Bank of America**, **Chase**, **Vanguard**, **Venmo**.  
Each **household member** (signed-in email) has their own independent links — so the household can have 2× each bank type.

| Layer | Keying |
|-------|--------|
| DDB metadata | `pk=USER#{email}` · `sk=CONNECTOR#{BANK}` |
| SSM item token | `/r2finance/connectors/{userKey}/{bankId}` (`userKey` = opaque hash, no email in path) |
| Session | Connect / disconnect / probe always use the bearer session email |

**Does not** write bank transactions into DynamoDB ledger `TXN#` rows yet.  
**Plaid keys never live in git** — SSM `/r2finance/plaid` only.

1. Create a Plaid account → Dashboard API keys.
2. Register OAuth redirect URI (no query string — Plaid rejects those):
   - `https://finance.i-liquid.be/connectors`
3. Put credentials in **SSM** (not the repo, not Secrets Manager):

```bash
# Replace placeholders — do not commit the real values
aws ssm put-parameter --name /r2finance/plaid --type SecureString \
  --value '{"client_id":"YOUR_ID","secret":"YOUR_SECRET","env":"production"}' \
  --overwrite --region us-east-1
# env: sandbox | development | production
```

4. Each person signs in → **Connectors** → links their own banks.
5. Item tokens: SSM `/r2finance/connectors/{userKey}/{boa|chase|vanguard|venmo}`.
6. Household matrix: `GET /v1/connectors?household=1`.

## Deploy

```bash
npm install
bash scripts/deploy.sh
bash scripts/invoke-import.sh   # full YNAB → DDB
```

## Cost

API Gateway HTTP + Lambda + DynamoDB on-demand only. 15‑minute schedule stays under YNAB’s **200 req/h** limit for personal use.

## Security (household lock)

**Only Jerome (`jerome.ans@gmail.com`) and Ngoc (`ngoc.h.dinh@gmail.com`) may use the API.**  
Hard allow-list in `src/lib/auth.js` (`ALLOWED_EMAILS`). Sessions for any other email are rejected.

| Layer | Rule |
|-------|------|
| Default deny | Every route except health + auth login/reset needs `Authorization: Bearer <session>` |
| Allow-list | `validateSession` / `createSession` / login reject non-household emails |
| Public auth | `login`, `forgot-password`, `reset-password`, `status`, first-time `set-password`, MFA steps |
| set-password | First-time only — cannot overwrite an existing password (use reset link) |
| Invite | Admin session only (`jerome.ans@gmail.com`) and still allow-list bound |
| CORS | Browser origins: `https://finance.i-liquid.be` (+ local Vite) |
| Secrets | YNAB PAT in Secrets Manager; Plaid + FCM in SSM — never git |
| Schedule | EventBridge invokes `R2FinanceYnabPull` Lambda **directly** (not HTTP) |

Website and Android always send the session bearer on ledger/sync calls.
