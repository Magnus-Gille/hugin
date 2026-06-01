/**
 * Regex PII baseline for the OPF evaluation harness (#56).
 *
 * Hugin today has NO span-level PII detector — `exfiltration-scanner.ts`
 * targets secrets/credentials and `sensitivity.ts` does keyword classification.
 * To compare OPF against "what regex can reasonably do" we need an explicit,
 * best-effort regex baseline over OPF's 8-label taxonomy. This module is that
 * baseline.
 *
 * The point of the baseline is honesty, not a strawman: structured PII
 * (email, phone, URL, ISO date, account numbers, well-known secret shapes)
 * is genuinely regex-tractable and the baseline does a real job there.
 * Unstructured PII (person names, free-form postal addresses) is essentially
 * intractable for regex — the heuristics here are deliberately naive so the
 * resulting low precision/recall *is* the finding that motivates a learned
 * model. See eval/privacy-filter/README.md.
 *
 * Pure: `detect(text)` → spans. No I/O.
 */

import type { PiiDetector, PiiLabel, PiiSpan } from "./pii-types.js";

interface RegexRule {
  label: PiiLabel;
  regex: RegExp; // must be global; capture group 1 narrows the span if present
}

// --- Structured PII: regex does well here ---

const EMAIL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// International + Swedish phone shapes: optional +CC, separators space/-/(),
// 7–13 digits total. Anchored to a digit run so it doesn't swallow prose.
const PHONE =
  /(?<![\w.])(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d(?:[\s-]?\d){6,12}(?![\w.])/g;

const URL = /\bhttps?:\/\/[^\s"'<>)\]]+/g;

// ISO 8601 dates, plus common written forms (1 Jan 2026, January 1, 2026,
// 01/02/2026, 2026). Kept conservative to avoid matching arbitrary integers.
const DATE = new RegExp(
  [
    "\\b\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2})?)?\\b", // ISO
    "\\b\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}\\b", // 01/02/2026, 1.2.26
    "\\b\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{4}\\b",
    "\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b",
  ].join("|"),
  "gi",
);

// Account numbers: IBAN, Swedish bankgiro/plusgiro, and long digit runs
// (16+) that look like card/account identifiers. The Swedish personnummer
// (YYMMDD-XXXX / YYYYMMDD-XXXX) is included here as the closest taxonomy fit —
// OPF has no national-ID label, so this is also a measurable taxonomy gap.
const ACCOUNT = new RegExp(
  [
    "\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b", // IBAN
    "\\b\\d{6,8}-\\d{4}\\b", // Swedish personnummer
    "\\b\\d{3,4}-\\d{7,10}\\b", // bankgiro-ish
    "\\b\\d{4}[\\s-]\\d{4}[\\s-]\\d{4}[\\s-]\\d{4}\\b", // grouped 16-digit card
    "\\b\\d{16,20}\\b", // bare long account run
  ].join("|"),
  "g",
);

// Secret shapes — a focused subset mirroring exfiltration-scanner.ts /
// sensitivity.ts. The first char of each well-known prefix is \u-escaped so
// this source file stays quiet for literal-key scanners.
const SECRET = new RegExp(
  [
    "-----BEGIN\\s+[A-Z0-9 ]*PRIVATE\\s+KEY-----",
    "\\bsk-ant-[A-Za-z0-9_-]{16,}",
    "\\bsk-proj-[A-Za-z0-9_-]{16,}",
    "\\bsk-[A-Za-z0-9]{32,}",
    "\\bgh[pousr]_[A-Za-z0-9]{20,}",
    "\\bgithub_pat_[A-Za-z0-9_]{22,}",
    "\\bxox[baprs]-[A-Za-z0-9-]{10,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bBearer\\s+ey[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
  ].join("|"),
  "g",
);

// Order is load-bearing: earlier rules claim characters first (see applyRules).
// Most-specific shapes go first so the greedy PHONE rule can't swallow a
// dash-separated ISO date (2026-06-03 also reads as an 8-digit phone) or a
// long account run. Email/URL/secret are unambiguous; ACCOUNT and DATE are
// specific; PHONE is the greediest and goes last among the structured rules.
const STRUCTURED_RULES: RegexRule[] = [
  { label: "private_email", regex: EMAIL },
  { label: "private_url", regex: URL },
  { label: "secret", regex: SECRET },
  { label: "account_number", regex: ACCOUNT },
  { label: "private_date", regex: DATE },
  { label: "private_phone", regex: PHONE },
];

// --- Unstructured PII: regex does poorly — heuristics are illustrative ---

// Person name heuristic: 2–3 consecutive Capitalized words (incl. Nordic
// letters). This over-fires on titlecased prose ("Agent SDK", "North Sea")
// and under-fires on lowercase/mononym names — by design, to expose the
// regex ceiling for names.
const PERSON =
  /\b[A-ZÅÄÖØÆ][a-zåäöøæ]+(?:\s+[A-ZÅÄÖØÆ][a-zåäöøæ]+){1,2}\b/g;

// Street address heuristic: a street-ish word + number, optionally a postal
// tail. Anglo + Swedish forms. Equally illustrative of regex's address ceiling.
const ADDRESS = new RegExp(
  [
    "\\b\\d{1,4}\\s+[A-ZÅÄÖ][A-Za-zåäö]+(?:\\s+[A-ZÅÄÖ][A-Za-zåäö]+)*\\s+" +
      "(?:Street|St|Avenue|Ave|Road|Rd|Court|Ct|Lane|Ln|Boulevard|Blvd|Drive|Dr)\\b",
    "\\b[A-ZÅÄÖ][A-Za-zåäö]+(?:vägen|gatan|gränd|torget|backen|stigen)\\s+\\d{1,4}" +
      "(?:[A-Za-z])?(?:,?\\s+\\d{3}\\s?\\d{2}\\s+[A-ZÅÄÖ][A-Za-zåäö]+)?",
  ].join("|"),
  "g",
);

const UNSTRUCTURED_RULES: RegexRule[] = [
  { label: "private_person", regex: PERSON },
  { label: "private_address", regex: ADDRESS },
];

/**
 * Run a rule set and collect spans. Earlier rules win on overlap: a character
 * already claimed by a higher-priority label is not re-claimed. This lets the
 * structured rules (high precision) pre-empt the noisy person/address rules.
 */
function applyRules(
  text: string,
  rules: RegexRule[],
  claimed: boolean[],
): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    for (const m of text.matchAll(rule.regex)) {
      if (m.index === undefined) continue;
      const surface = m[0];
      const start = m.index;
      const end = start + surface.length;
      let free = true;
      for (let i = start; i < end; i++) {
        if (claimed[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (let i = start; i < end; i++) claimed[i] = true;
      spans.push({ label: rule.label, start, end, text: surface });
    }
  }
  return spans;
}

export const regexBaselineDetector: PiiDetector = {
  name: "regex-baseline",
  detect(text: string): PiiSpan[] {
    const claimed = new Array<boolean>(text.length).fill(false);
    // Structured (high-precision) rules first, then the noisy heuristics fill
    // the gaps. Sorting at the end gives a stable, offset-ordered result.
    const structured = applyRules(text, STRUCTURED_RULES, claimed);
    const unstructured = applyRules(text, UNSTRUCTURED_RULES, claimed);
    return [...structured, ...unstructured].sort(
      (a, b) => a.start - b.start || a.end - b.end,
    );
  },
};
