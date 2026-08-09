'use strict';

/**
 * Display payee for ledger rows — especially bank imports that arrive with
 * empty YNAB payee_id but a clear Plaid / import description.
 *
 * Credit-card payments follow reconciliation practice:
 *   "Payment for credit Family Reserve (ending 8053)"
 * built from Plaid ("PAYMENT TO CHASE CARD ENDING IN 8053 …") + YNAB CC account mask.
 */

function parseImportPayeeName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // YNAB match-suggestion blobs land in import_payee_name as JSON — never show raw.
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const name = j.importedPayee || j.import_payee_name || j.payee || null;
      return name && String(name).trim() ? String(name).trim() : null;
    } catch {
      return null;
    }
  }
  return s;
}

function extractCardEnding(text) {
  if (!text) return null;
  const s = String(text);
  const m =
    s.match(/ending\s*(?:in\s*)?#?(\d{4})\b/i) ||
    s.match(/\bcard\s+#?(\d{4})\b/i) ||
    s.match(/\*{2,}(\d{4})\b/);
  return m ? m[1] : null;
}

function isCreditPaymentHint({ plaidMerchantName, plaidPfc, importPayeeName }) {
  const pfc = String(plaidPfc || '').toUpperCase();
  if (
    pfc.includes('LOAN_PAYMENT') ||
    pfc.includes('CREDIT_CARD_PAYMENT') ||
    pfc === 'LOAN_PAYMENTS'
  ) {
    return true;
  }
  const blob = `${plaidMerchantName || ''} ${importPayeeName || ''}`.toLowerCase();
  return (
    /payment\s+to\s+.*card/.test(blob) ||
    /credit\s*card/.test(blob) ||
    /autopay/.test(blob) ||
    /payment\s+thank\s+you/.test(blob) ||
    /card\s+payment/.test(blob)
  );
}

function findCreditAccountByEnding(accounts, ending) {
  if (!ending || !Array.isArray(accounts)) return null;
  const ccs = accounts.filter((a) => {
    if (a.deleted || a.closed) return false;
    const t = String(a.type || a.payload?.type || '').toLowerCase();
    return (
      t.includes('credit') ||
      t === 'creditcard' ||
      t === 'lineofcredit' ||
      t === 'line of credit'
    );
  });
  return (
    ccs.find((a) =>
      String(a.name || a.payload?.name || '').includes(ending),
    ) || null
  );
}

function accountBaseName(name, ending) {
  let n = String(name || '').trim();
  if (ending) {
    n = n.replace(new RegExp(`\\s*${ending}\\s*$`), '').trim();
  }
  return n || String(name || '').trim();
}

/**
 * @param {string} ending last-4
 * @param {Array} accounts YNAB/DDB account rows ({ name, type })
 * @returns {string}
 */
function formatCreditPaymentPayee(ending, accounts) {
  const acct = findCreditAccountByEnding(accounts, ending);
  if (acct) {
    const full =
      (acct.alias && String(acct.alias).trim()) ||
      acct.name ||
      acct.payload?.name ||
      '';
    const base = accountBaseName(full, ending);
    return `Payment for credit ${base} (ending ${ending})`;
  }
  return `Payment for credit card (ending ${ending})`;
}

/** Drop trailing bank dates; soften ALL-CAPS Plaid labels. */
function cleanPlaidMerchantName(name) {
  if (!name) return null;
  let s = String(name).trim();
  if (!s) return null;
  s = s.replace(/\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/, '').trim();
  s = s.replace(/\s+\d{4}-\d{2}-\d{2}\s*$/, '').trim();
  if (s === s.toUpperCase() && /[A-Z]/.test(s) && s.length > 3) {
    s = s
      .toLowerCase()
      .split(/\s+/)
      .map((w) => {
        if (w.length <= 2) return w.toUpperCase();
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ');
  }
  return s || null;
}

/**
 * Resolve human payee for lists / categorize UI.
 * @returns {string|null} null → UI shows "—" / "No payee"
 */
function isGenericVenmoPayee(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^venmo$/i.test(s)) return true;
  if (/^venmo\b/i.test(s) && /payment|cashout|des:|web id|ppd|orig/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * Prefer Venmo Personal note ("Person - memo") when YNAB/bank only says Venmo.
 * Only returns labels that look like Venmo Personal (quoted note or
 * "Name - note" from our enrich stamp) — never raw bank merchant strings.
 */
function venmoDescriptionLabel({
  plaidDescription,
  plaidName,
  plaidMerchantName,
} = {}) {
  if (plaidDescription && String(plaidDescription).trim()) {
    const d = String(plaidDescription).trim();
    if (!isGenericVenmoPayee(d)) return d;
  }
  for (const raw of [plaidName, plaidMerchantName]) {
    if (!raw || isGenericVenmoPayee(raw)) continue;
    const s = String(raw).trim();
    // Person "note" → Person - note (Venmo Personal style)
    const m = s.match(/^(.+?)\s+["“](.+?)["”]\s*$/);
    if (m) return `${m[1].trim()} - ${m[2].trim()}`;
    // Already stamped "Person - note" (must include " - " and look personal)
    if (/\s-\s/.test(s) && !/^venmo\b/i.test(s)) return s;
  }
  return null;
}

function resolveDisplayPayee({
  payeeName,
  transferAccountName,
  plaidMerchantName,
  plaidPfc,
  importPayeeName: importRaw,
  plaidDescription,
  plaidName,
  accounts = [],
} = {}) {
  const named = payeeName && String(payeeName).trim() ? String(payeeName).trim() : null;
  const venmoLabel = venmoDescriptionLabel({
    plaidDescription,
    plaidName,
    plaidMerchantName,
  });
  // Bank/YNAB payee is just "Venmo" — surface person + note instead.
  if (named && isGenericVenmoPayee(named) && venmoLabel) {
    return venmoLabel;
  }
  if (named) return named;
  if (transferAccountName && String(transferAccountName).trim()) {
    return `Transfer : ${String(transferAccountName).trim()}`;
  }

  const importPayeeName = parseImportPayeeName(importRaw);
  if (isGenericVenmoPayee(importPayeeName) && venmoLabel) {
    return venmoLabel;
  }

  const ending =
    extractCardEnding(plaidMerchantName) || extractCardEnding(importPayeeName);

  if (
    ending &&
    isCreditPaymentHint({ plaidMerchantName, plaidPfc, importPayeeName })
  ) {
    return formatCreditPaymentPayee(ending, accounts);
  }

  // Even without PFC, "…ENDING IN 8053" on a payment-looking string → same form.
  if (ending && /payment/i.test(`${plaidMerchantName || ''} ${importPayeeName || ''}`)) {
    return formatCreditPaymentPayee(ending, accounts);
  }

  if (venmoLabel) return venmoLabel;
  const plaidClean = cleanPlaidMerchantName(plaidMerchantName);
  if (plaidClean) return plaidClean;
  if (importPayeeName) return importPayeeName;
  return null;
}

module.exports = {
  parseImportPayeeName,
  extractCardEnding,
  isCreditPaymentHint,
  formatCreditPaymentPayee,
  cleanPlaidMerchantName,
  resolveDisplayPayee,
  findCreditAccountByEnding,
  isGenericVenmoPayee,
  venmoDescriptionLabel,
};
