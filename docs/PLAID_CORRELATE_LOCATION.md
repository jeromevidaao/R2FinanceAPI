# Plaid correlate + location strategy

## Goal

Link each R2Finance ledger `TXN#` (YNAB-sourced) to a Chase/BoA **Plaid**
`transaction_id`, then attach **location** when we can — without making Plaid
the ledger source of truth.

## Why the first matcher was “good enough” but incomplete

| Approach | Result (Chase, ~21–45d) |
|----------|-------------------------|
| Amount + date ±4 + fuzzy name + soft mask | ~99% match |
| **Hard account mask + tiered date + greedy rare-amounts-first** | **~100% non-transfer** |
| Plaid `location` on matched row | **~3–4%** |

So correlation is easy; **location is the hard part**. Never require location
to accept a match.

## Better correlation (implemented in `src/lib/plaidMatch.js`)

### 1. Stable account map (once)

| YNAB account (last-4 in name) | Plaid `account_id` / mask |
|-------------------------------|---------------------------|
| Family Checkin **6022** | Plaid depository *6022* |
| Family Freedom **6553** | Plaid credit *6553* |
| … | … |

**Hard filter:** only compare ledger vs Plaid rows with the **same mask**.

### 2. Amount bridge

- YNAB: milliunits, outflow **negative**
- Plaid: dollars, money-out **positive**
- Match if `abs(ynab/1000 + plaid) < $0.015` (or same-sign for edge cases)

### 3. Date bridge

Prefer **`authorized_date`** (card swipe day), else posted **`date`**.  
Empirically almost all hits are **0-day** lag; allow ±1…4 by tier.

### 4. Tiers (confidence)

| Tier | Rule | Typical confidence |
|------|------|--------------------|
| **T0** | amount + same account + date exact | ~0.92+ |
| **T1** | amount + account + date ≤ 1d | ~0.80 |
| **T2** | amount + account + date ≤ 3d + name ≥ 0.25 | ~0.70 |
| **T3** | amount + account + date ≤ 4d, unique only | ~0.55 |

### 5. Greedy 1:1, rare amounts first

Two Cleanforme $125 same week must not claim one Plaid row.  
Sort ledger by **rarity of (mask, amount)** then date; assign best unused Plaid id.

### 6. Pending chain

Plaid `pending` → later posted with `pending_transaction_id`.  
Match either; when posted arrives, **update** stored `plaidTransactionId` to the
posted id (keep location if already set).

### 7. What not to use as primary key

- YNAB `import_id` (`YNAB:-120000:2026-08-07:1`) ≠ Plaid `transaction_id`
- Payee name alone (renames, “Cleanforme” vs “Cleanforme LLC”)
- Location (usually null)

## Location cascade (attach after match)

```
1. plaid_direct       location on this Plaid txn          conf 1.0
2. merchant_entity    same merchant_entity_id ever had loc conf 0.85
3. merchant_name      same normalized merchant name        conf 0.65
4. geocode_candidate  in-store, no cache — external Places conf TBD
5. none               online / ACH / unknown               —
```

### Observed coverage (Chase ~45d)

| Channel   | Share | With Plaid location |
|-----------|-------|---------------------|
| in store  | ~62%  | **~4%**             |
| online    | ~13%  | 0%                  |
| other/ACH | ~25%  | 0%                  |

**Entity inheritance** only lifts total location a little (~+1%) unless you
build a long-lived merchant location store across months.

### Making location useful in product

1. **Always store match** (`plaidTransactionId`, tier, confidence) even when loc null.
2. **Persist merchant location cache** in DDB (`MERCHANT#entityId` → lat/lon/address)
   whenever Plaid returns a pin — reuse forever.
3. **Geocode once** for high-value in-store misses (Voyager Cafe, Nth St Cafe, 7-Eleven):
   query = `merchant_name` (+ city if Plaid ever sent city-only).
   Cache under `merchant_entity_id` or normalized name.
   Skip `payment_channel` ∈ {online, other} unless user tags a place.
4. **UI:** show pin only if `locationConfidence ≥ 0.65` (or user-confirmed).

Suggested enrichment fields on `TXN#` (or `ENRICH#TXN#{id}`):

```json
{
  "plaidTransactionId": "…",
  "plaidMerchantEntityId": "…",
  "matchTier": "T0",
  "matchConfidence": 0.94,
  "location": { "lat": 37.23, "lon": -121.98, "text": "…" },
  "locationSource": "plaid_direct",
  "locationConfidence": 1.0,
  "matchedAt": "ISO-8601"
}
```

Do **not** push location to YNAB; keep YNAB bidirectional fields clean.

## Sync job sketch

```
EventBridge 6h / on connector sync
  → Plaid /transactions/sync (cursor in DDB CONNECTOR#)
  → Load recent TXN# for masks on this item
  → plaidMatch.matchLedgerToPlaid + attachLocations
  → Write enrichment if confidence ≥ threshold
  → Upsert MERCHANT# location cache
  → Optional: queue geocode for in-store candidates (rate-limited)
```

## Expected rates (Chase-linked accounts)

| Metric | Expectation |
|--------|-------------|
| Correlate success | **~98–100%** non-transfer with payee |
| Location from Plaid direct | **~3–5%** |
| Location after entity/name cache (months) | **~5–15%** depending on merchants |
| Location after geocode of recurring in-store | **can reach majority of *physical* spend** you care about |

## Run POC

```bash
cd R2FinanceAPI
node scripts/poc-plaid-correlate-chase.js          # original sample dump
node scripts/poc-plaid-location-strategy.js        # tiered + location cascade stats
```
