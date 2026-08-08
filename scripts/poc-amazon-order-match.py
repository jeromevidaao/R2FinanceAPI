#!/usr/bin/env python3
"""
POC: match R2Finance DynamoDB ledger charges (AMAZON MKTPL* / Amazon.com*)
to Amazon consumer order/transaction history.

Amazon has **no official consumer Order History API**. This POC uses the
unofficial `amazon-orders` library (parses amazon.com order + transaction
pages after login). Credentials live in SSM only — never git.

SSM (us-east-1 SecureString):
  /r2finance/amazon              JSON {username, password, site?}
  /r2finance/amazon/username     email (optional if JSON present)
  /r2finance/amazon/password     password (optional if JSON present)

Usage (from repo root, with local venv that has amazon-orders):
  python3 -m venv .venv-amazon-poc
  .venv-amazon-poc/bin/pip install 'amazon-orders==4.4.*'
  .venv-amazon-poc/bin/python scripts/poc-amazon-order-match.py
  DAYS=90 SAMPLE=12 .venv-amazon-poc/bin/python scripts/poc-amazon-order-match.py

Does NOT write to DynamoDB. Read-only: DDB + SSM + Amazon website scrape.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from typing import Any

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
TABLE = os.environ.get("R2FINANCE_TABLE", "R2Finance")
DAYS = max(14, int(os.environ.get("DAYS", "120")))
SAMPLE = max(5, int(os.environ.get("SAMPLE", "15")))
SSM_JSON = os.environ.get("AMAZON_SSM_PARAM", "/r2finance/amazon")


def aws_json(args: list[str]) -> Any:
    cmd = ["aws", *args, "--region", REGION, "--output", "json"]
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out) if out.strip() else None


def un(v: Any) -> Any:
    if not isinstance(v, dict):
        return v
    if "S" in v:
        return v["S"]
    if "N" in v:
        return float(v["N"])
    if "BOOL" in v:
        return v["BOOL"]
    if "NULL" in v:
        return None
    if "M" in v:
        return {k: un(x) for k, x in v["M"].items()}
    if "L" in v:
        return [un(x) for x in v["L"]]
    return v


def load_amazon_creds() -> tuple[str, str]:
    """Load username/password from SSM SecureString (JSON or split params)."""
    raw = None
    try:
        p = aws_json(
            [
                "ssm",
                "get-parameter",
                "--name",
                SSM_JSON,
                "--with-decryption",
            ]
        )
        raw = (p or {}).get("Parameter", {}).get("Value")
    except subprocess.CalledProcessError:
        raw = None

    user = pwd = None
    if raw:
        try:
            obj = json.loads(raw)
            user = (obj.get("username") or obj.get("email") or "").strip()
            pwd = obj.get("password") or ""
        except json.JSONDecodeError:
            pass

    if not user or not pwd:
        u = aws_json(
            [
                "ssm",
                "get-parameter",
                "--name",
                "/r2finance/amazon/username",
                "--with-decryption",
            ]
        )
        p = aws_json(
            [
                "ssm",
                "get-parameter",
                "--name",
                "/r2finance/amazon/password",
                "--with-decryption",
            ]
        )
        user = user or (u or {}).get("Parameter", {}).get("Value", "").strip()
        pwd = pwd or (p or {}).get("Parameter", {}).get("Value", "")

    if not user or not pwd:
        raise SystemExit(
            f"Missing Amazon credentials in SSM {SSM_JSON} "
            "(or /r2finance/amazon/username + /password)"
        )
    return user, pwd


def scan_ledger_amazon_charges() -> list[dict]:
    """Scan R2Finance TXN# rows for marketplace / amazon.com card charges."""
    items: list[dict] = []
    start = None
    while True:
        cmd = [
            "dynamodb",
            "scan",
            "--table-name",
            TABLE,
            "--filter-expression",
            "begins_with(sk, :sk)",
            "--expression-attribute-values",
            json.dumps({":sk": {"S": "TXN#"}}),
            "--projection-expression",
            "sk,#d,amount,payload,ynabId,deleted",
            "--expression-attribute-names",
            json.dumps({"#d": "date"}),
        ]
        if start:
            cmd += ["--exclusive-start-key", json.dumps(start)]
        data = aws_json(cmd)
        items.extend(data.get("Items") or [])
        start = data.get("LastEvaluatedKey")
        if not start:
            break

    out: list[dict] = []
    for it in items:
        if un(it.get("deleted")) is True:
            continue
        p = un(it.get("payload")) or {}
        payee = str(p.get("payee_name") or "")
        imp = str(p.get("import_payee_name") or "")
        orig = str(p.get("import_payee_name_original") or "")
        blob = f"{payee} {imp} {orig}".upper()
        # Card marketplace / retail charges (not salary, AWS, stock, transfers)
        is_charge = any(
            x in blob
            for x in (
                "AMAZON MKTPL",
                "AMZN MKTPL",
                "AMAZON.COM*",
                "AMZN.COM",
                "AMAZON.COM ",
                "AMAZONRETAIL",
                "AMAZON PRIME*",
                "AMAZON PRIME MEMBERSHIP",
            )
        )
        is_noise = any(
            x in blob
            for x in (
                "PAYROLL",
                "DIRECT DEP",
                "WEB SERVI",
                "AWS",
                "STOCK",
                "TRANSFER",
                "FID BKG",
                "EDI PYMNTS",
                "INC. PAYMENTS",
            )
        )
        if not is_charge or is_noise:
            # Still keep raw MKTPL* payees even if categorized oddly
            if "MKTPL" not in blob and "AMAZON.COM*" not in blob.replace(" ", ""):
                if not re.search(r"AMAZON\.COM\*[A-Z0-9]", blob):
                    continue

        amount = float(un(it.get("amount")) or 0) / 1000.0
        if amount >= 0:
            continue  # outflows only for spend match

        label = orig or payee or imp
        ref = extract_amazon_ref(label)
        out.append(
            {
                "date": un(it.get("date")) or p.get("date"),
                "amount": amount,
                "abs_amount": abs(amount),
                "payee": payee,
                "import_payee": imp,
                "import_orig": orig,
                "label": label,
                "ref": ref,
                "account": p.get("account_name"),
                "category": p.get("category_name"),
                "ynabId": un(it.get("ynabId")),
                "memo": p.get("memo"),
            }
        )

    out.sort(key=lambda x: x["date"] or "", reverse=True)
    return out


def extract_amazon_ref(label: str) -> str | None:
    """
    Bank descriptors often look like AMAZON MKTPL*BP4BF1BC1 or Amazon.com*NB8GA2Q80.
    The token after * is a short charge ref, not always the full order id.
    """
    m = re.search(
        r"(?:AMAZON\s*MKTPL|AMZN\s*MKTPL|AMAZON\.COM|AMZN\.COM|AMAZONRETAIL)\*?([A-Z0-9]{6,})",
        str(label or "").upper(),
    )
    return m.group(1) if m else None


def parse_date(s: str | date | None) -> date | None:
    if s is None:
        return None
    if isinstance(s, date) and not isinstance(s, datetime):
        return s
    s = str(s)[:10]
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def days_between(a: date | None, b: date | None) -> float:
    if not a or not b:
        return 99.0
    return abs((a - b).days)


def fetch_amazon_side(username: str, password: str, days: int) -> dict[str, Any]:
    """Login + pull transaction history (+ light order history)."""
    from amazonorders.conf import AmazonOrdersConfig
    from amazonorders.session import AmazonSession
    from amazonorders.transactions import AmazonTransactions
    from amazonorders.orders import AmazonOrders
    from amazonorders.exception import AmazonOrdersError

    # Browser extras solve Amazon JS bot-detection / ACIC pages (requires
    # amazon-orders[browser] + playwright chromium). Register before blockers.
    headed = os.environ.get("HEADED", "0") == "1"
    auth_classes = [
        "amazonorders.contrib.browser.playwright.PlaywrightJSAuthForm",
        "amazonorders.contrib.browser.playwright.PlaywrightAcicForm",
    ]
    if headed:
        # Visible window for manual Puzzle / WAF if headless cannot clear it
        auth_classes.insert(
            0, "amazonorders.contrib.browser.playwright.PlaywrightManualWafForm"
        )
    config = AmazonOrdersConfig(
        data={
            "browser_timeout": int(os.environ.get("BROWSER_TIMEOUT", "90")),
            "auth_forms_classes": auth_classes,
        }
    )
    # Optional TOTP seed for authenticator 2FA (env or SSM later)
    otp = os.environ.get("AMAZON_OTP_SECRET_KEY")
    session = AmazonSession(
        username,
        password,
        debug=os.environ.get("DEBUG") == "1",
        otp_secret_key=otp,
        config=config,
    )
    if headed:
        for form in session.auth_forms:
            if hasattr(form, "headless"):
                form.headless = False
            if form.__class__.__name__ == "PlaywrightManualWafForm":
                form.manual = True
    print(f"Logging into Amazon as {username} …", flush=True)
    try:
        session.login()
    except Exception as e:
        # AmazonOrdersError, Playwright timeout/closed window, etc.
        print(f"LOGIN FAILED: {type(e).__name__}: {e}", file=sys.stderr)
        meta = getattr(e, "meta", None)
        if meta:
            print(f"  meta keys: {list(meta.keys()) if isinstance(meta, dict) else type(meta)}", file=sys.stderr)
        raise SystemExit(
            "Amazon login failed. Often OTP/2FA, CAPTCHA, or WAF puzzle. "
            "Install: pip install 'amazon-orders[browser]' && playwright install chromium. "
            "Retry with HEADED=1 on a Mac desktop and complete the puzzle. "
            "If 2FA is on, set AMAZON_OTP_SECRET_KEY (TOTP seed). "
            "Or run DRY_RUN=1 to exercise the matcher only. "
            "See docs/AMAZON_ORDER_MATCH_POC.md"
        ) from e

    if not session.is_authenticated:
        raise SystemExit("Amazon session not authenticated after login()")

    print(f"Authenticated. Fetching Amazon transactions (last {days} days)…", flush=True)
    tx_api = AmazonTransactions(session)
    try:
        amz_txns = tx_api.get_transactions(days=days)
    except AmazonOrdersError as e:
        print(f"get_transactions failed: {e}", file=sys.stderr)
        amz_txns = []

    print(f"  Amazon transactions: {len(amz_txns)}", flush=True)

    print("Fetching order history (last 3 months filter)…", flush=True)
    orders_api = AmazonOrders(session)
    try:
        orders = orders_api.get_order_history(time_filter="months-3")
    except Exception as e:
        print(f"  order history months-3 failed ({e}); trying year…", flush=True)
        try:
            orders = orders_api.get_order_history(year=date.today().year)
        except Exception as e2:
            print(f"  order history failed: {e2}", file=sys.stderr)
            orders = []

    print(f"  Amazon orders: {len(orders)}", flush=True)

    txn_rows = []
    for t in amz_txns:
        txn_rows.append(
            {
                "completed_date": t.completed_date.isoformat() if t.completed_date else None,
                "grand_total": float(t.grand_total) if t.grand_total is not None else None,
                "order_number": t.order_number,
                "seller": getattr(t, "seller", None),
                "payment_method": getattr(t, "payment_method", None),
                "payment_last4": getattr(t, "payment_method_last_4", None),
                "is_refund": bool(getattr(t, "is_refund", False)),
            }
        )

    order_rows = []
    for o in orders:
        items = []
        for it in getattr(o, "items", None) or []:
            items.append(
                {
                    "title": getattr(it, "title", None),
                    "price": getattr(it, "price", None),
                    "quantity": getattr(it, "quantity", None),
                    "asin": getattr(it, "asin", None),
                }
            )
        order_rows.append(
            {
                "order_number": o.order_number,
                "order_placed_date": o.order_placed_date.isoformat()
                if getattr(o, "order_placed_date", None)
                else None,
                "grand_total": float(o.grand_total) if o.grand_total is not None else None,
                "item_count": getattr(o, "item_count", None),
                "items": items[:8],
                "payment_last4": getattr(o, "payment_method_last_4", None),
                "cancelled": bool(getattr(o, "cancelled", False)),
            }
        )

    return {"transactions": txn_rows, "orders": order_rows}


def match_ledger_to_amazon(
    ledger: list[dict], amz: dict[str, Any], max_date_delta: int = 7
) -> list[dict]:
    """
    Match bank ledger outflow to Amazon transaction (preferred) or order total.
    Amazon transaction grand_total is negative for purchases in amazon-orders.
    """
    amz_txns = amz["transactions"]
    amz_orders = amz["orders"]
    used_txn = set()
    used_order = set()
    results = []

    for L in ledger:
        Ldate = parse_date(L["date"])
        Lamt = L["abs_amount"]
        candidates = []

        for i, t in enumerate(amz_txns):
            if i in used_txn:
                continue
            if t.get("is_refund"):
                continue
            tamt = t.get("grand_total")
            if tamt is None:
                continue
            # purchases are negative totals on Amazon txn page; also accept abs
            if abs(abs(float(tamt)) - Lamt) > 0.03:
                continue
            tdate = parse_date(t.get("completed_date"))
            dd = days_between(Ldate, tdate)
            if dd > max_date_delta:
                continue
            score = 0.55 + max(0.0, 0.25 - dd * 0.03)
            ref = L.get("ref")
            on = str(t.get("order_number") or "")
            if ref and on and (ref in on.replace("-", "") or on.replace("-", "")[-len(ref) :] == ref):
                score += 0.2
            elif ref and on and ref[:6] in on.replace("-", ""):
                score += 0.1
            candidates.append(
                {
                    "kind": "amazon_transaction",
                    "score": round(score, 3),
                    "date_delta": dd,
                    "idx": i,
                    "row": t,
                }
            )

        for j, o in enumerate(amz_orders):
            if j in used_order or o.get("cancelled"):
                continue
            oamt = o.get("grand_total")
            if oamt is None:
                continue
            if abs(abs(float(oamt)) - Lamt) > 0.03:
                continue
            odate = parse_date(o.get("order_placed_date"))
            dd = days_between(Ldate, odate)
            if dd > max_date_delta:
                continue
            score = 0.4 + max(0.0, 0.2 - dd * 0.03)
            candidates.append(
                {
                    "kind": "amazon_order",
                    "score": round(score, 3),
                    "date_delta": dd,
                    "idx": j,
                    "row": o,
                }
            )

        candidates.sort(key=lambda c: (-c["score"], c["date_delta"]))
        best = candidates[0] if candidates else None
        if best:
            if best["kind"] == "amazon_transaction":
                used_txn.add(best["idx"])
            else:
                used_order.add(best["idx"])

        results.append({"ledger": L, "match": best, "alt_count": max(0, len(candidates) - 1)})

    return results


def synthetic_amazon_from_ledger(ledger: list[dict]) -> dict[str, Any]:
    """
    Offline dry-run: invent Amazon-side rows that *should* match the sample
    so we can exercise the matcher without a live Amazon session.
    """
    txns = []
    orders = []
    for i, L in enumerate(ledger):
        d = L["date"] or date.today().isoformat()
        # Amazon charge often posts 0–2 days after order place
        try:
            placed = date.fromisoformat(str(d)[:10]) - timedelta(days=i % 2)
        except ValueError:
            placed = date.today()
        order_num = f"111-{1000000 + i}-{2000000 + i}"
        txns.append(
            {
                "completed_date": str(d)[:10],
                "grand_total": -abs(L["abs_amount"]),
                "order_number": order_num,
                "seller": "Amazon.com",
                "payment_method": "Visa ****6129",
                "payment_last4": "6129",
                "is_refund": False,
            }
        )
        orders.append(
            {
                "order_number": order_num,
                "order_placed_date": placed.isoformat(),
                "grand_total": L["abs_amount"],
                "item_count": 1,
                "items": [
                    {
                        "title": f"[synthetic] item for {L.get('ref') or L['label']}",
                        "price": L["abs_amount"],
                        "quantity": 1,
                        "asin": None,
                    }
                ],
                "payment_last4": "6129",
                "cancelled": False,
            }
        )
    return {"transactions": txns, "orders": orders}


def main() -> int:
    print("=== R2Finance Amazon order-match POC ===")
    print(f"region={REGION} table={TABLE} days={DAYS} sample={SAMPLE}")
    dry_run = os.environ.get("DRY_RUN", "0") == "1"

    print("Scanning DynamoDB for Amazon card charges…")
    ledger_all = scan_ledger_amazon_charges()
    cutoff = date.today() - timedelta(days=DAYS)
    ledger = [x for x in ledger_all if (parse_date(x["date"]) or date.min) >= cutoff]
    print(f"  amazon card charges total={len(ledger_all)} in_window={len(ledger)}")

    if not ledger:
        print("No Amazon MKTPL/retail charges in window — nothing to match.")
        return 0

    sample = ledger[:SAMPLE]
    print(f"\nSample ledger charges ({len(sample)}):")
    for L in sample:
        print(
            f"  {L['date']} ${L['amount']:>9.2f}  {L['label']!r}  "
            f"ref={L['ref']}  acct={L['account']}  cat={L['category']}"
        )

    if dry_run:
        print("\nDRY_RUN=1 — skipping Amazon login; using synthetic Amazon rows.")
        amz = synthetic_amazon_from_ledger(sample)
    else:
        username, password = load_amazon_creds()
        print(f"SSM credentials loaded for user={username} (password not printed)")
        amz = fetch_amazon_side(username, password, DAYS)
    print("\nSample Amazon transactions:")
    for t in amz["transactions"][:10]:
        print(
            f"  {t['completed_date']} total={t['grand_total']}  "
            f"order={t['order_number']}  seller={t.get('seller')}  "
            f"pm={t.get('payment_method')} last4={t.get('payment_last4')}"
        )
    print("Sample Amazon orders:")
    for o in amz["orders"][:8]:
        titles = [i.get("title") for i in (o.get("items") or [])[:2]]
        print(
            f"  {o['order_placed_date']} total={o['grand_total']}  "
            f"#{o['order_number']}  items={titles}"
        )

    results = match_ledger_to_amazon(sample, amz)
    matched = sum(1 for r in results if r["match"])
    print(f"\n=== Match results: {matched}/{len(results)} sample charges matched ===")
    for r in results:
        L = r["ledger"]
        m = r["match"]
        print(f"\nLEDGER  {L['date']} ${L['amount']:.2f}  {L['label']}")
        if not m:
            print("  → NO MATCH (amount±$0.03 within ±7d not found on Amazon side)")
            continue
        row = m["row"]
        if m["kind"] == "amazon_transaction":
            print(
                f"  → TXN   {row.get('completed_date')} ${row.get('grand_total')}  "
                f"order#{row.get('order_number')}  seller={row.get('seller')}  "
                f"score={m['score']} Δdays={m['date_delta']}"
            )
        else:
            titles = [i.get("title") for i in (row.get("items") or [])[:3]]
            print(
                f"  → ORDER {row.get('order_placed_date')} ${row.get('grand_total')}  "
                f"#{row.get('order_number')}  items={titles}  "
                f"score={m['score']} Δdays={m['date_delta']}"
            )

    summary = {
        "poc": "amazon-order-match",
        "ledger_in_window": len(ledger),
        "sample": len(sample),
        "matched": matched,
        "amazon_transactions": len(amz["transactions"]),
        "amazon_orders": len(amz["orders"]),
        "notes": [
            "Unofficial website scrape via amazon-orders — not an official Amazon API.",
            "No DDB writes. Next step: persist match (orderId, titles) on TXN payload.",
            "2FA/OTP or CAPTCHA may block headless login; store AMAZON_OTP_SECRET_KEY if TOTP.",
        ],
    }
    print("\n" + json.dumps(summary, indent=2))
    return 0 if matched > 0 else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        raise SystemExit(130)
