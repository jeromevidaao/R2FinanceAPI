# Amazon order match POC

## Goal

Bank / card feed lines like `AMAZON MKTPL*BP4BF1BC1` land in YNAB → DynamoDB as ledger `TXN#` rows, but **without line-item titles**. Enrich those rows with the matching Amazon order (items, order #, payment last4).

## Is there an official Amazon API?

| API | Fits personal MKTPL charges? |
|-----|------------------------------|
| Selling Partner API | No — seller catalog / orders you *sell* |
| Amazon Business API | Only if Business account + approved app |
| Login with Amazon | Identity only, not order history |
| **Consumer order history** | **No public API** |

So a consumer enrichment path is either:

1. **Unofficial website session** (this POC) — parse Your Orders / Your Transactions after login  
2. Manual CSV export from Amazon order history reports  
3. Parse order-confirmation email in Gmail (future alternative)

## Credentials (SSM only — never git)

| Parameter | Type | Contents |
|-----------|------|----------|
| `/r2finance/amazon` | SecureString | `{"username":"…","password":"…","site":"amazon.com"}` |
| `/r2finance/amazon/username` | SecureString | email (redundant convenience) |
| `/r2finance/amazon/password` | SecureString | password (redundant convenience) |

```bash
aws ssm put-parameter --name /r2finance/amazon --type SecureString \
  --value '{"username":"YOU@example.com","password":"…","site":"amazon.com"}' \
  --overwrite --region us-east-1
```

If the account uses authenticator 2FA, set env `AMAZON_OTP_SECRET_KEY` (TOTP seed) when running the POC. CAPTCHA / WAF may still require interactive solve or a captcha-solver extra.

## Run the POC

```bash
cd ~/R2FinanceAPI
python3 -m venv .venv-amazon-poc
.venv-amazon-poc/bin/pip install 'amazon-orders[browser]==4.4.*'
.venv-amazon-poc/bin/playwright install chromium

# Offline matcher check (DDB real, Amazon synthetic) — no login
DAYS=220 SAMPLE=12 DRY_RUN=1 .venv-amazon-poc/bin/python scripts/poc-amazon-order-match.py

# Live Amazon session (needs browser challenge clear)
DAYS=220 SAMPLE=12 BROWSER_TIMEOUT=120 \
  .venv-amazon-poc/bin/python scripts/poc-amazon-order-match.py

# If headless JS challenge times out, open a visible browser (local Mac):
HEADED=1 BROWSER_TIMEOUT=180 DAYS=220 SAMPLE=8 \
  .venv-amazon-poc/bin/python scripts/poc-amazon-order-match.py
```

| Env | Meaning |
|-----|---------|
| `DAYS` | Ledger + Amazon lookback window (default 120; use ≥200 — recent MKTPL batch was ~Mar 2026) |
| `SAMPLE` | How many ledger charges to print/match |
| `DRY_RUN=1` | Skip Amazon login; synthetic Amazon side |
| `HEADED=1` | Non-headless Playwright + manual WAF form |
| `BROWSER_TIMEOUT` | Seconds to wait on JS challenge (default 90) |
| `AMAZON_OTP_SECRET_KEY` | TOTP seed if authenticator 2FA enabled |
| `DEBUG=1` | amazon-orders debug HTML dumps under `./output` |

**Read-only:** DynamoDB scan + SSM get + Amazon website. **No ledger writes.**

### Live-login status (POC 2026-08-08)

| Step | Result |
|------|--------|
| SSM credentials | ✅ stored `/r2finance/amazon` (+ username/password) |
| DDB scan MKTPL / Amazon.com* | ✅ **313** card charges; **29** in 220d window |
| Matcher dry-run | ✅ **12/12** sample matched (amount ±$0.03, date ±7d) |
| Headless Amazon login | ❌ JS bot challenge timed out (Playwright) |
| Headed / OTP | Needs human once (or TOTP secret in env) |

Amazon is actively bot-detecting automated logins. Production path should cache a **cookie jar** after one interactive login, or use email/CSV import as a fallback.

## Matching heuristic (v0)

1. Load DDB outflows whose import/payee looks like `AMAZON MKTPL*`, `Amazon.com*`, Prime*, retail  
2. Load Amazon **Transactions** page (best) + **Orders** history  
3. Match on **abs(amount) ± $0.03** and **date ± 7 days**  
4. Bonus score if bank descriptor ref token appears inside Amazon order id  

Amazon charge refs (`MKTPL*BP4BF1BC1`) are **not** full order numbers; amount+date is the primary key.

## Suggested production shape (later)

- Nightly (or on sync) Lambda **not** recommended for fragile scrape — better a small scheduled job on a trusted host, or on-demand from the API with cached cookie jar in SSM  
- Store on `TXN#` payload: `amazonOrderId`, `amazonTitles[]`, `amazonMatchConfidence`, `amazonMatchedAt`  
- Prefer Amazon **Transactions** feed (card charge ↔ order #) over order totals alone (multi-item / split payment)  
- Respect Amazon ToS / rate limits; this is household personal automation only

## Related

- Plaid location correlate POC: `scripts/poc-plaid-correlate-chase.js`  
- Plaid strategy notes: `docs/PLAID_CORRELATE_LOCATION.md`
