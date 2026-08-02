#!/usr/bin/env tsx
/**
 * build-pii-fixtures — generate the Grimnir-shaped OPF eval fixtures (#56).
 *
 * Authors labelled PII examples and clean (no-PII) technical examples, computes
 * all character offsets by construction (see src/privacy-filter/fixtures.ts),
 * validates every span, and writes two JSONL files in OPF's native eval format:
 *
 *   eval/privacy-filter/fixtures/grimnir-pii.jsonl       (labelled PII)
 *   eval/privacy-filter/fixtures/clean-technical.jsonl   (no PII — FP probes)
 *
 * ALL personal data here is FABRICATED. Emails use example.com / .invalid,
 * phones use reserved/synthetic ranges, personnummer/accounts are made up.
 * Never put real PII in a committed fixture.
 *
 * Usage:
 *   npm run build:pii-fixtures            # writes to the default dir
 *   tsx scripts/build-pii-fixtures.ts <outDir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExample,
  examplesToJsonl,
  pii,
  validateExample,
} from "../src/privacy-filter/fixtures.js";
import type { LabelledExample } from "../src/privacy-filter/pii-types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "eval", "privacy-filter", "fixtures");

// --- Labelled PII examples (Grimnir-shaped: email, journal, Munin, calendar) ---

const labelled: LabelledExample[] = [
  // 1. Client email (EN) — person, email, phone, date
  buildExample(
    "grimnir_pii_01",
    [
      "Hi ",
      pii("private_person", "Sarah Whitlock"),
      ", thanks for the call. I'll send the revised SOW by ",
      pii("private_date", "2026-06-12"),
      ". Reach me on ",
      pii("private_phone", "(415) 555-0173"),
      " or ",
      pii("private_email", "sarah.whitlock@northgate-labs.example.com"),
      ".",
    ],
    { lang: "en", category: "email" },
  ),

  // 2. Client email (SV) — person, email, Swedish phone, date
  buildExample(
    "grimnir_pii_02",
    [
      "Hej ",
      pii("private_person", "Anna Lindqvist"),
      ",\n\nTack för mötet idag. Jag skickar offerten senast ",
      pii("private_date", "2026-06-04"),
      ". Du når mig på ",
      pii("private_phone", "070-413 88 21"),
      " eller ",
      pii("private_email", "anna.lindqvist@uddevallaenergi.example.se"),
      ".\n\nVänliga hälsningar,\n",
      pii("private_person", "Magnus Gille"),
    ],
    { lang: "sv", category: "email" },
  ),

  // 3. Journal entry (EN) — person, date, place-as-address
  buildExample(
    "grimnir_pii_03",
    [
      "Journal — ",
      pii("private_date", "May 28, 2026"),
      ". Long day. Had coffee with ",
      pii("private_person", "Daniel Norin"),
      " near the office at ",
      pii("private_address", "42 Kungsgatan Court"),
      " and we talked through the Markus situation. Need to follow up with ",
      pii("private_person", "Markus"),
      " next week.",
    ],
    { lang: "en", category: "journal" },
  ),

  // 4. Munin people/<name> excerpt — person, email, prefs (date)
  buildExample(
    "grimnir_pii_04",
    [
      "people/erik-sundstrom — profile. ",
      pii("private_person", "Erik Sundström"),
      " prefers async updates. Main contact ",
      pii("private_email", "erik@sundstrom-consulting.example.com"),
      ". First worked together ",
      pii("private_date", "2024-11-03"),
      ".",
    ],
    { lang: "mixed", category: "munin-people" },
  ),

  // 5. Munin clients/<name> excerpt — org contact, bankgiro, person
  buildExample(
    "grimnir_pii_05",
    [
      "clients/mandaley — status. Faktura skickad, väntar betalning till bankgiro ",
      pii("account_number", "5402-1183"),
      ". Kontaktperson ",
      pii("private_person", "Petra Hallberg"),
      ", ",
      pii("private_email", "petra@mandaley.example.se"),
      ".",
    ],
    { lang: "sv", category: "munin-client" },
  ),

  // 6. Calendar event — person, date, address, phone
  buildExample(
    "grimnir_pii_06",
    [
      "Föreläsning Göteborg — ",
      pii("private_date", "2026-06-04"),
      " kl 13:00. Plats: ",
      pii("private_address", "Mässans gata 24, 412 51 Göteborg"),
      ". Värd ",
      pii("private_person", "Johan Bergqvist"),
      ", mobil ",
      pii("private_phone", "0735-22 90 14"),
      ".",
    ],
    { lang: "sv", category: "calendar" },
  ),

  // 7. Invoice (SV) — org, IBAN, amount (not PII), date
  buildExample(
    "grimnir_pii_07",
    [
      "Faktura 2026-0042. Betalas till IBAN ",
      pii("account_number", "SE35 5000 0000 0549 1000 0003"),
      " senast ",
      pii("private_date", "2026-06-30"),
      ". Belopp 18 750 SEK exkl moms. Referens ",
      pii("private_person", "Camilla Ek"),
      ".",
    ],
    { lang: "sv", category: "invoice" },
  ),

  // 8. Personnummer in an HR note (taxonomy gap: OPF has no national-ID label)
  buildExample(
    "grimnir_pii_08",
    [
      "Onboarding note for ",
      pii("private_person", "Lars Öberg"),
      " (personnummer ",
      pii("account_number", "850417-2381"),
      "). Start date ",
      pii("private_date", "2026-07-01"),
      ", email ",
      pii("private_email", "lars.oberg@gille.example.ai"),
      ".",
    ],
    { lang: "sv", category: "hr" },
  ),

  // 9. Secret leak in a pasted config snippet — secret, url
  buildExample(
    "grimnir_pii_09",
    [
      "Broker not connecting. My .env has HUGIN_BROKER_TOKEN=",
      pii("secret", "sk-" + "proj-9Qa3xKmZ7bV2tLpRfWnE4cYhUiOaSdF6"),
      " and HUGIN_BROKER_URL=",
      pii("private_url", "https://huginmunin.tail9af2.ts.net:3033"),
      ". Should it be the Tailscale name?",
    ],
    { lang: "en", category: "support" },
  ),

  // 10. Private signed URL (URL + person)
  buildExample(
    "grimnir_pii_10",
    [
      pii("private_person", "Nora Felton"),
      " shared the deck: ",
      pii(
        "private_url",
        "https://drive.example.com/file/d/1aZqP9-XbN/view?token=8fe21cba",
      ),
      " — please don't forward it.",
    ],
    { lang: "en", category: "email" },
  ),

  // 11. PEM private key paste — secret
  buildExample(
    "grimnir_pii_11",
    [
      "Deploy fails with this in the logs:\n",
      pii(
        "secret",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n-----END OPENSSH PRIVATE KEY-----",
      ),
      "\nWhy is the key being printed?",
    ],
    { lang: "en", category: "support" },
  ),

  // 12. Multi-person meeting note — several persons + date
  buildExample(
    "grimnir_pii_12",
    [
      "Standup ",
      pii("private_date", "2026-05-30"),
      ": ",
      pii("private_person", "Sara Gille"),
      " on the Scania report, ",
      pii("private_person", "Markus Lund"),
      " on hardware, ",
      pii("private_person", "Daniel Norin"),
      " blocked on Vinnova.",
    ],
    { lang: "en", category: "journal" },
  ),

  // 13. US address + phone + name (EN)
  buildExample(
    "grimnir_pii_13",
    [
      "Ship the unit to ",
      pii("private_person", "Gregory Tan"),
      ", ",
      pii("private_address", "1180 Birchwood Avenue"),
      ", Palo Alto. Confirm on ",
      pii("private_phone", "+1 650 555 0144"),
      ".",
    ],
    { lang: "en", category: "logistics" },
  ),

  // 14. Card number in a support paste — account_number
  buildExample(
    "grimnir_pii_14",
    [
      "Payment declined. I used card ",
      pii("account_number", "4539 1488 0343 6467"),
      " expiring ",
      pii("private_date", "08/2027"),
      ". Account holder ",
      pii("private_person", "Helena Voss"),
      ".",
    ],
    { lang: "en", category: "support" },
  ),

  // 15. GitHub token in a CI log — secret + url
  buildExample(
    "grimnir_pii_15",
    [
      "CI step failed; it echoed GH_TOKEN=",
      pii("secret", "gh" + "p_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78"),
      " while cloning ",
      pii("private_url", "https://github.com/Magnus-Gille/hugin"),
      ".",
    ],
    { lang: "en", category: "support" },
  ),

  // 16. Swedish journal — person, personnummer, address
  buildExample(
    "grimnir_pii_16",
    [
      "Anteckning: ringde ",
      pii("private_person", "Birgitta Holm"),
      " (",
      pii("account_number", "611128-4455"),
      ") angående bostaden på ",
      pii("private_address", "Storgatan 7B, 645 31 Strängnäs"),
      ".",
    ],
    { lang: "sv", category: "journal" },
  ),

  // 17. Email thread quoting two people + reply-to date
  buildExample(
    "grimnir_pii_17",
    [
      "On ",
      pii("private_date", "2026-05-12"),
      ", ",
      pii("private_person", "Thomas Reardon"),
      " wrote: please cc ",
      pii("private_email", "billing@adage-partners.example.com"),
      " on the next invoice.",
    ],
    { lang: "en", category: "email" },
  ),

  // 18. Mononym + handle (hard for regex person heuristic)
  buildExample(
    "grimnir_pii_18",
    [
      "ping from ",
      pii("private_person", "kasia"),
      " — she'll join from ",
      pii("private_email", "kasia@konsulter.example.io"),
      " tomorrow.",
    ],
    { lang: "en", category: "chat" },
  ),

  // 19. Plusgiro + org + date (SV)
  buildExample(
    "grimnir_pii_19",
    [
      "Betala medlemsavgiften till plusgiro ",
      pii("account_number", "90 20 03-3"),
      " före ",
      pii("private_date", "2026-12-31"),
      ".",
    ],
    { lang: "sv", category: "invoice" },
  ),

  // 20. Slack token paste — secret
  buildExample(
    "grimnir_pii_20",
    [
      "Webhook broke. Token in the alert was ",
      pii("secret", "xox" + "b-2488-90213-AbCdEfGhIjKlMnOpQrStUv"),
      ". Rotating now.",
    ],
    { lang: "en", category: "support" },
  ),

  // 21. Personal phone in signature only
  buildExample(
    "grimnir_pii_21",
    [
      "Talk soon!\n--\n",
      pii("private_person", "Oskar Wennberg"),
      "\n",
      pii("private_phone", "+46 70 982 14 55"),
      "\n",
      pii("private_email", "oskar@wennberg.example.se"),
    ],
    { lang: "mixed", category: "email-signature" },
  ),

  // 22. Date-heavy planning note (date precision)
  buildExample(
    "grimnir_pii_22",
    [
      "Schedule: kickoff ",
      pii("private_date", "2026-06-03"),
      ", review ",
      pii("private_date", "2026-06-17"),
      ", ship ",
      pii("private_date", "1 Jul 2026"),
      ". Owner ",
      pii("private_person", "Priya Raman"),
      ".",
    ],
    { lang: "en", category: "planning" },
  ),

  // 23. AWS key + S3 private url
  buildExample(
    "grimnir_pii_23",
    [
      "The backup script still has ",
      pii("secret", "AK" + "IA4Z9QXWPLMN72BVTQ"),
      " hardcoded and writes to ",
      pii(
        "private_url",
        "https://s3.eu-north-1.amazonaws.com/mimir-private/backups/2026-05.tar",
      ),
      ".",
    ],
    { lang: "en", category: "support" },
  ),

  // 24. Mixed SV/EN with name, email, phone, address
  buildExample(
    "grimnir_pii_24",
    [
      "Re: keynote. ",
      pii("private_person", "Anders Käll"),
      " på Västerås stad bekräftar lokalen ",
      pii("private_address", "Stadshusgränd 2, 721 87 Västerås"),
      ". Hans mobil: ",
      pii("private_phone", "021-39 10 00"),
      ", mail ",
      pii("private_email", "anders.kall@vasteras.example.se"),
      ".",
    ],
    { lang: "mixed", category: "email" },
  ),
];

// --- Clean technical examples (NO PII — false-positive probes) ---
// A well-behaved detector should emit ZERO spans here. These deliberately
// include credential *vocabulary* (the sensitivity.ts trap), code, configs,
// and logs — but no actual PII, secret values, real emails/phones/URLs.

const clean: LabelledExample[] = [
  buildExample(
    "grimnir_clean_01",
    [
      "We need to rotate the API key handling in the auth module and hash every " +
        "password before the bearer token check. No secrets are stored in the repo.",
    ],
    { lang: "en", category: "security-prose" },
  ),
  buildExample(
    "grimnir_clean_02",
    [
      "export async function finalizeTaskCompletion(client, taskNs, options) {\n" +
        "  await client.write(taskNs, 'status', options.statusContent, terminalTags);\n" +
        "  return { structuredResultOk: true };\n}",
    ],
    { lang: "en", category: "code" },
  ),
  buildExample(
    "grimnir_clean_03",
    [
      "fix(tasks): guarantee terminal status tag when structured-result write throws\n" +
        "The completion path now writes status first, then the structured result in a try/catch.",
    ],
    { lang: "en", category: "git-commit" },
  ),
  buildExample(
    "grimnir_clean_04",
    [
      "[Unit]\nDescription=Hugin task dispatcher\n[Service]\n" +
        "Environment=MUNIN_URL=http://localhost:3030\nExecStart=/usr/bin/node dist/main.js\n" +
        "Restart=on-failure",
    ],
    { lang: "en", category: "config" },
  ),
  buildExample(
    "grimnir_clean_05",
    [
      "poll cycle complete: queueDepth=0, heartbeat written, no pending tasks. " +
        "Worker hugin-huginmunin idle. Lease renewal stopped.",
    ],
    { lang: "en", category: "log" },
  ),
  buildExample(
    "grimnir_clean_06",
    [
      "The router filters candidates by trust tier, availability, and capabilities, " +
        "then ranks by cost (free over subscription) and model size. Auto-routing is opt-in.",
    ],
    { lang: "en", category: "docs" },
  ),
  buildExample(
    "grimnir_clean_07",
    [
      "npm run build && npm test — 877 tests passing. Strict mode clean. " +
        "No type errors in src/privacy-filter.",
    ],
    { lang: "en", category: "log" },
  ),
  buildExample(
    "grimnir_clean_08",
    [
      "Diskutera arkitekturen för sensitivity-lattice: public, internal, private. " +
        "Molnruntime cappas till internal. Ingen riktig data nämns här.",
    ],
    { lang: "sv", category: "security-prose" },
  ),
  buildExample(
    "grimnir_clean_09",
    [
      "TypeError: cannot read property 'spans' of undefined\n" +
        "    at scoreDetector (pii-scorer.ts:142)\n" +
        "    at runEval (run-pii-eval.ts:88)",
    ],
    { lang: "en", category: "stacktrace" },
  ),
  buildExample(
    "grimnir_clean_10",
    [
      "Set HUGIN_EXFIL_POLICY to warn, flag, or redact. The opf value is proposed " +
        "in issue 56 and gated on a benchmark. Default stays warn.",
    ],
    { lang: "en", category: "docs" },
  ),
];

// --- Write + validate ---

function assertValid(examples: LabelledExample[], setName: string): void {
  const issues = examples.flatMap(validateExample);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`  ✗ [${issue.exampleId}] ${issue.message}`);
    }
    throw new Error(`${setName}: ${issues.length} invalid span(s) — fix the generator`);
  }
  const ids = new Set(examples.map((e) => e.id));
  if (ids.size !== examples.length) {
    throw new Error(`${setName}: duplicate example ids`);
  }
}

function main(): void {
  const outDir = process.argv[2] ?? DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  assertValid(labelled, "grimnir-pii");
  assertValid(clean, "clean-technical");

  const piiPath = join(outDir, "grimnir-pii.jsonl");
  const cleanPath = join(outDir, "clean-technical.jsonl");
  writeFileSync(piiPath, examplesToJsonl(labelled), "utf8");
  writeFileSync(cleanPath, examplesToJsonl(clean), "utf8");

  const spanCount = labelled.reduce((n, e) => n + e.spans.length, 0);
  console.log(`Wrote ${labelled.length} labelled examples (${spanCount} spans) → ${piiPath}`);
  console.log(`Wrote ${clean.length} clean examples (0 spans) → ${cleanPath}`);
}

main();
