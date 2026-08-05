# R2FinanceAPI — agent notes

- Product: **R2Finance** backend.
- Stack: **API Gateway + Lambda + DynamoDB only** (keep cost minimal).
- Resource names all start with `R2Finance`.
- **Offline path:** Android → `POST /v1/device/push` → DDB `PENDING_PUSH` → (later) `pushPending` / 15m schedule → YNAB.
- **Always commit + push**; watch CI green.
- Never commit YNAB PAT; use Secrets Manager `R2Finance/ynab-pat`.
