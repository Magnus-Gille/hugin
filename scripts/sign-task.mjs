#!/usr/bin/env node
// Sign a complete Hugin task document.
//
// Usage:
//   HUGIN_SIGNING_SECRET=<hex> node scripts/sign-task.mjs \
//     --task-file /tmp/task.md \
//     --task-id 20260420-180000-a1b2 \
//     [--key-id Codex-desktop]
//
// The helper reads Submitted by and Submitted at from the document metadata.
// It prints `v2:<keyId>:<hex>`. Insert it with setTaskSignature() from
// src/task-signing.ts, which places it immediately before the blank line
// preceding ### Prompt/### Pipeline (or directly before that marker).
//
// Canonical payload rules mirror src/task-signing.ts and are covered by its
// cross-language drift test. Keep both implementations in sync.

import { createHmac, createHash } from "node:crypto";
import * as fs from "node:fs";

const SIGNATURE_VERSION = "v2";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = "";
      continue;
    }
    args[key] = value;
    i++;
  }
  return args;
}

function normalizeTaskBody(content) {
  return content.replace(/\r\n/g, "\n");
}

function findTaskSectionBoundary(lines) {
  return lines.findIndex((line) => /^###[ \t]*(?:Prompt|Pipeline)[ \t]*$/i.test(line));
}

function parseSignature(raw) {
  const parts = raw.trim().split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^[0-9a-f]+$/i.test(parts[2])) return null;
  return { version: parts[0], keyId: parts[1], hex: parts[2].toLowerCase() };
}

function inspectSignatureField(content) {
  const lines = normalizeTaskBody(content).split("\n");
  const boundary = findTaskSectionBoundary(lines);
  if (boundary < 0) {
    return { status: "malformed", reason: "task body is missing a ### Prompt or ### Pipeline section" };
  }
  const prefix = lines.slice(0, boundary);
  const candidates = prefix.filter((line) => /^[ \t]*(?:-[ \t]*)?\*\*Signature(?::\*\*|\*\*)/i.test(line));
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length > 1) return { status: "malformed", reason: "duplicate metadata Signature lines" };
  const match = candidates[0].match(/^(?:- )?\*\*Signature:\*\* (\S+)$/i);
  if (!match || !parseSignature(match[1])) {
    return { status: "malformed", reason: "malformed metadata Signature line" };
  }
  return { status: "valid", raw: match[1] };
}

function splitRawTaskLines(content) {
  const lines = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ text: content.slice(start), start, end: content.length, terminator: "" });
      return lines;
    }
    const end = newline > start && content[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({
      text: content.slice(start, end),
      start,
      end,
      terminator: content.slice(end, newline + 1),
    });
    start = newline + 1;
  }
  if (content.length === 0 || content.endsWith("\n")) {
    lines.push({ text: "", start: content.length, end: content.length, terminator: "" });
  }
  return lines;
}

const SIGNATURE_VALUE_MARKER = "__HUGIN_SIGNATURE_VALUE__";

function applyTaskSignatureValue(content, signature) {
  const inspection = inspectSignatureField(content);
  if (inspection.status === "malformed") throw new Error(inspection.reason);
  const lines = splitRawTaskLines(content);
  const lineTexts = lines.map((line) => line.text);
  const boundary = findTaskSectionBoundary(lineTexts);
  if (boundary < 0) {
    throw new Error("task body is missing a ### Prompt or ### Pipeline section");
  }

  if (inspection.status === "valid") {
    const signatureLineIndex = lineTexts.findIndex(
      (line, index) => index < boundary && /^[ \t]*(?:-[ \t]*)?\*\*Signature(?::\*\*|\*\*)/i.test(line),
    );
    const line = lines[signatureLineIndex];
    const match = line?.text.match(/^((?:- )?\*\*Signature:\*\* )(\S+)$/i);
    if (!line || !match) throw new Error("metadata Signature line could not be replaced");
    const valueStart = line.start + match[1].length;
    const valueEnd = line.start + line.text.length;
    return `${content.slice(0, valueStart)}${signature}${content.slice(valueEnd)}`;
  }

  const insertionIndex = boundary > 0 && lineTexts[boundary - 1] === ""
    ? boundary - 1
    : boundary;
  const insertionPoint = lines[insertionIndex]?.start ?? content.length;
  const precedingLine = lines[insertionIndex - 1];
  const sectionLine = lines[boundary];
  const newline = precedingLine?.terminator || sectionLine?.terminator || "\n";
  return `${content.slice(0, insertionPoint)}- **Signature:** ${signature}${newline}${content.slice(insertionPoint)}`;
}

function canonicalizeTaskBody(content) {
  return normalizeTaskBody(applyTaskSignatureValue(content, SIGNATURE_VALUE_MARKER));
}

function extractTaskSigningMetadata(content) {
  const lines = normalizeTaskBody(content).split("\n");
  const boundary = findTaskSectionBoundary(lines);
  const prefix = lines.slice(0, boundary < 0 ? lines.length : boundary).join("\n");
  const submitter = prefix.match(/^[ \t]*(?:-[ \t]*)?\*\*Submitted by:\*\*[ \t]*(.+)$/im)?.[1]?.trim();
  const submittedAt = prefix.match(/^[ \t]*(?:-[ \t]*)?\*\*Submitted at:\*\*[ \t]*(.+)$/im)?.[1]?.trim();
  return { submitter: submitter || null, submittedAt: submittedAt || null };
}

function sanitize(v) {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

function buildCanonicalPayload(params) {
  const fields = {
    "task-body-sha256": sha256Hex(canonicalizeTaskBody(params.taskBody)),
    "submitted-at": sanitize(params.submittedAt),
    submitter: sanitize(params.submitter),
    "task-id": sanitize(params.taskId),
    version: SIGNATURE_VERSION,
  };
  return Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n") + "\n";
}

function decodeSecret(raw) {
  const trimmed = raw.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 32) {
    return Buffer.from(trimmed, "hex");
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 24) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length >= 16) return decoded;
  }
  return Buffer.from(trimmed, "utf8");
}

function fail(message) {
  console.error(message);
  process.exitCode = 2;
}

function main() {
  const args = parseArgs(process.argv);

  // Check required full-document inputs before reading the signing secret.
  if (!args["task-file"]) return fail("missing --task-file (v2 signs a complete task document)");
  if (!args["task-id"]) return fail("missing --task-id");
  for (const legacy of ["submitter", "submitted-at", "runtime", "prompt", "prompt-file", "context-refs"]) {
    if (Object.hasOwn(args, legacy)) {
      return fail(`--${legacy} is no longer accepted; derive signing metadata from --task-file`);
    }
  }

  let taskBody;
  try {
    taskBody = fs.readFileSync(args["task-file"], "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`failed to read --task-file: ${detail}`);
  }

  const inspection = inspectSignatureField(taskBody);
  if (inspection.status === "malformed") return fail(inspection.reason);
  const metadata = extractTaskSigningMetadata(taskBody);
  if (!metadata.submitter) return fail("missing Submitted by metadata in --task-file");
  if (!metadata.submittedAt) return fail("missing Submitted at metadata in --task-file");
  if (Number.isNaN(Date.parse(metadata.submittedAt))) return fail("invalid Submitted at metadata in --task-file");

  const keyId = args["key-id"] || metadata.submitter;
  if (keyId !== metadata.submitter && !keyId.startsWith(`${metadata.submitter}-`)) {
    return fail(`--key-id must equal Submitted by or be a rotation alias for ${metadata.submitter}`);
  }

  const secret = process.env.HUGIN_SIGNING_SECRET;
  if (!secret) return fail("HUGIN_SIGNING_SECRET not set");

  const payload = buildCanonicalPayload({
    taskId: args["task-id"],
    submitter: metadata.submitter,
    submittedAt: metadata.submittedAt,
    taskBody,
  });
  const hex = createHmac("sha256", decodeSecret(secret)).update(payload).digest("hex");
  process.stdout.write(`${SIGNATURE_VERSION}:${keyId}:${hex}\n`);
}

main();
