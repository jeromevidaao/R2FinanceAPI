# R2FinanceAPI — agent notes

- Product: **R2Finance** backend.
- Stack: **API Gateway + Lambda + DynamoDB only** (keep cost minimal).
- Resource names all start with `R2Finance`.
- **Always commit + push**; watch CI green.
- Never commit YNAB PAT; use Secrets Manager `R2Finance/ynab-pat`.
