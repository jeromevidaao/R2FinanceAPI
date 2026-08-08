# Amazon order match POC

## Goal

Bank / card feed lines like `AMAZON MKTPL*BP4BF1BC1` land in YNAB → DynamoDB as ledger `TXN#` rows, but **without line-item titles**. Enrich those rows with the matching Amazon order (items, order #, payment last4).

## Is there an official Amazon API? (AWS-viable)

**Email / Gmail is out of scope** for production — R2Finance runs on Lambda; we will not depend on inbox access.

| API | What it returns | Fits household MKTPL? | AWS-friendly? |
|-----|-----------------|------------------------|---------------|
| **Amazon Data Portability** (`portability::physical_orders`) via Login with Amazon OAuth | **Item titles, ASIN, qty, orderId, orderDate, totalOwed** | **Yes — personal retail orders** | **Yes** (refresh token in SSM) |
| Data Portability physical orders schema | **No ship-to / delivery address** in published schema | Items yes; location **no** | Yes |
| **Amazon Business Reporting API** | Line items + **shipment / ship-to address** | Only if buys go through **Amazon Business** | Yes (LWA + Business app) |
| Selling Partner Orders API | Orders you *sell* on Marketplace | No | N/A |
| Username/password “Amazon API” | Does not exist | — | — |
| Website scrape (`amazon-orders`) | Items + recipient address | Fragile (WAF/bot) | Poor on Lambda |

### Recommended production path (no email)

1. **Register** an Amazon developer app with **Amazon Data Portability** (Category-2: identity + security review).  
2. Scopes: `portability::physical_orders` (items). Optionally Business Reporting if you migrate Pine supplies to AB.  
3. One-time household OAuth (Login with Amazon) → store **refresh token** in SSM (`/r2finance/amazon/portability`).  
4. Lambda job: create query → poll → download JSON → match DDB `AMAZON MKTPL*` by **amount + date** (and orderId when available).  
5. Persist on `TXN#`: `amazonOrderId`, `items[]`, `asins[]`, `matchConfidence`.  

**Delivery location gap:** official Data Portability **physical_orders** fields are product-centric (`productName`, `asin`, `quantity`, `totalOwed`, `orderId`) — **not** street address. For ship-to you need either Amazon Business shipment reports, or accept “unit / household address” from your own address book (not live from Amazon).

### Unofficial scrape (local POC only)

The `amazon-orders` script remains a **desktop** experiment. It can show items + recipient address when login works, but **do not** ship scrape-to-Lambda as the product path.

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
