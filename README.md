# R2FinanceAPI

AWS backend for **R2Finance** — personal spend ledger with temporary YNAB bidirectional sync.

**Android app:** [R2FinanceAndroid](https://github.com/cleaningbutton/R2FinanceAndroid)

## Cost rule

**API Gateway + Lambda + DynamoDB only.** No EC2, ECS, RDS, NAT, ElastiCache.

## AWS resource names

| Resource | Name |
|----------|------|
| API Gateway HTTP API | `R2FinanceAPI` |
| Lambda (device API) | `R2FinanceApiHandler` |
| Lambda (YNAB → DDB) | `R2FinanceYnabPull` |
| Lambda (DDB → YNAB) | `R2FinanceYnabPush` |
| EventBridge schedule | `R2FinanceYnabPullSchedule` |
| DynamoDB table | `R2Finance` |
| GSI | `R2Finance-GSI1-YnabId` |
| GSI | `R2Finance-GSI2-UpdatedAt` |
| Secrets Manager | `R2Finance/ynab-pat` |
| IAM role | `R2FinanceLambdaRole` |
| Log groups | `/aws/lambda/R2FinanceApiHandler`, … (7–14 day retention) |

Optional later: SQS `R2FinanceYnabPushQueue` if YNAB 200 req/h needs buffering.

## Phases

| Phase | This repo |
|-------|-----------|
| 1 | Scaffold + docs only (Android owns local Room) |
| 2 | Optional import seed into DDB |
| 3 | Deploy API + DDB + YNAB pull/push |
| 4 | Disable YNAB Lambdas |

## DynamoDB single-table (`R2Finance`)

| PK | SK | Entity |
|----|-----|--------|
| `PLAN#<id>` | `META` | Plan + `serverKnowledge` |
| `PLAN#<id>` | `ACCT#<id>` | Account |
| `PLAN#<id>` | `CGRP#<id>` | Category group |
| `PLAN#<id>` | `CAT#<id>` | Category |
| `PLAN#<id>` | `PAYEE#<id>` | Payee |
| `PLAN#<id>` | `TXN#<id>` | Transaction (+ subs) |
| `PLAN#<id>` | `SCHED#<id>` | Scheduled |
| `PLAN#<id>` | `CURSOR#ynab` | YNAB delta cursor |
| `PLAN#<id>` | `CURSOR#device#<deviceId>` | Device cursor |

## Deploy (Phase 3)

See [docs/AWS_RESOURCES.md](docs/AWS_RESOURCES.md) and `scripts/deploy.sh` (when filled in).

## Local

```bash
npm test
# handler stubs only until Phase 3
node src/handlers/apiHandler.js
```
