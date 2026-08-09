# R2Finance AWS resources (low cost)

## Stack boundary

Allowed:

- API Gateway **HTTP API** (`R2FinanceAPI`)
- Lambda (`R2FinanceApiHandler`, `R2FinanceYnabPull`, `R2FinanceYnabPush`)
- DynamoDB on-demand table `R2Finance`
- Secrets Manager `R2Finance/ynab-pat`
- EventBridge rule `R2FinanceYnabPullSchedule`
- CloudWatch Logs (short retention)
- IAM `R2FinanceLambdaRole`

Disallowed for cost:

- Always-on compute, NAT Gateway, RDS, ElastiCache, multi-region

## Amazon order enrichment

- Chrome extension `amazon-orders-extension` scrapes amazon.com (browser session) daily
- `POST /v1/amazon/orders` → DDB `sk=AMAZON#ORDER#…` + match stamp on `TXN#…`
- Clients show item titles + order link on inbox payees (`AMAZON MKTPL*… — items`)

## Estimated personal use

Near free tier / a few dollars per month at single-user volume if:

- YNAB poll every 15–30 minutes (not every minute)
- On-demand DDB, small items
- No VPC for Lambdas

## Auth (v1)

Personal shared secret or device token in `Authorization` header (not Cognito unless needed later).

## YNAB

- Rate limit: **200 requests / hour / token**
- Delta: `last_knowledge_of_server` / `server_knowledge`
- Phase 4: delete secret, disable schedules
