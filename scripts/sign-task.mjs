#!/usr/bin/env node
// Sign a task submission for Hugin.
//
// Usage:
//   HUGIN_SIGNING_SECRET=<hex> node scripts/sign-task.mjs \
//     --task-id 20260420-180000-a1b2 \
//     --submitter Codex-desktop \
//     --submitted-at 2026-04-20T18:00:00Z \
//     --runtime claude \
//     --prompt-file /tmp/prompt.md \
//     [--context-refs "projects/hugin/status,meta/conventions/status"] \
//     [--key-id Codex-desktop]
//
// Prints `v1:<keyId>:<hex>` on stdout. Submitters embed that as the
// `**Signature:**` field in the task body:
//
//   - **Signature:** v1:Codex-desktop:abcdef...
//
// Canonical payload and HMAC-SHA256 are kept in lockstep with
// src/task-signing.ts — do not drift these without updating both.

import { createHmac, createHash } from "node:crypto";
import * as fs from "node:fs";

const SIGNATURE_VERSION = "v1";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i++;
  }
  return args;
}

function sanitize(v) {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

function canonicalizeContextRefs(refs) {
  return refs
    .map((r) => r.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function canonicalizePrompt(raw) {
  return raw.trim();
}

function buildCanonicalPayload(params) {
  const promptSha = sha256Hex(canonicalizePrompt(params.prompt));
  const refs = params.contextRefs ?? [];
  const contextRefsSha = refs.length ? sha256Hex(canonicalizeContextRefs(refs)) : "";
  const fields = {
    "context-refs-sha256": contextRefsSha,
    "prompt-sha256": promptSha,
    runtime: sanitize(params.runtime),
    "submitted-at": sanitize(params.submittedAt),
    submitter: sanitize(params.submitter),
    "task-id": sanitize(params.taskId),
    version: SIGNATURE_VERSION,
  };
  return (
    Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n") + "\n"
  );
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

function main() {
  const args = parseArgs(process.argv);
  const required = ["task-id", "submitter", "submitted-at", "runtime"];
  for (const r of required) {
    if (!args[r]) {
      console.error(`missing --${r}`);
      process.exit(2);
    }
  }
  if (!args.prompt && !args["prompt-file"]) {
    console.error("provide --prompt or --prompt-file");
    process.exit(2);
  }

  const secret = process.env.HUGIN_SIGNING_SECRET;
  if (!secret) {
    console.error("HUGIN_SIGNING_SECRET not set");
    process.exit(2);
  }

  const prompt = args["prompt-file"]
    ? fs.readFileSync(args["prompt-file"], "utf8")
    : args.prompt;
  const contextRefs = args["context-refs"]
    ? args["context-refs"].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const keyId = args["key-id"] || args.submitter;

  const payload = buildCanonicalPayload({
    taskId: args["task-id"],
    submitter: args.submitter,
    submittedAt: args["submitted-at"],
    runtime: args.runtime,
    prompt,
    contextRefs,
  });
  const hex = createHmac("sha256", decodeSecret(secret)).update(payload).digest("hex");
  process.stdout.write(`${SIGNATURE_VERSION}:${keyId}:${hex}\n`);
}

main();
