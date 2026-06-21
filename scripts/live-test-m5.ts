/**
 * Live integration test: fire a real task through homeserver-executor.ts
 * against the live M5 gateway over Tailscale.
 *
 * Usage:
 *   HOMESERVER_GATEWAY_URL=http://100.76.72.59:8080 \
 *   HOMESERVER_GATEWAY_API_KEY=<key> \
 *   npx tsx scripts/live-test-m5.ts
 *
 * Or load from .env:
 *   source .env && npx tsx scripts/live-test-m5.ts
 */

import * as os from "node:os";
import * as path from "node:path";

import {
  loadHomeserverGatewayConfig,
  executeHomeserverTask,
} from "../src/homeserver-executor.js";

const cfg = loadHomeserverGatewayConfig(process.env);
if (!cfg) {
  console.error(
    "ERROR: HOMESERVER_GATEWAY_URL not set (or set without an API key for a non-loopback host)."
  );
  console.error(
    "  Set HOMESERVER_GATEWAY_URL and HOMESERVER_GATEWAY_API_KEY, or source .env first."
  );
  process.exit(1);
}

console.log(`\n[live-test-m5] Gateway: ${cfg.baseUrl}`);
console.log(`[live-test-m5] API key: ${cfg.apiKey.slice(0, 12)}...`);

const logDir = path.join(os.tmpdir(), "hugin-live-test");
const taskId = `live-test-${Date.now()}`;

// --- Test 1: chat path with qwen35-a3b ---
console.log(`\n--- Test 1: chat path (qwen35-a3b) ---`);
const chatResult = await executeHomeserverTask(
  {
    prompt: "What is 12 multiplied by 7? Answer with only the number.",
    gatewayBaseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    path: "chat",
    model: "qwen35-a3b",
    timeoutMs: 120_000,
    maxOutputChars: 2_000,
    // NOTE: qwen3 is a thinking model — max_tokens must be high enough to emit
    // content after its CoT block. The executor sends stream:true but no explicit
    // max_tokens to the chat path, so the gateway/model defaults apply.
    // If resultText is empty, the budget was exhausted by CoT; use delegate path.
  },
  taskId + "-chat",
  logDir
);

console.log(`exitCode:      ${chatResult.exitCode}`);
console.log(`backpressure:  ${chatResult.backpressure}`);
console.log(`promptTokens:  ${chatResult.promptTokens ?? "unknown"}`);
console.log(`completionTokens: ${chatResult.completionTokens ?? "unknown"}`);
console.log(`inferenceMs:   ${chatResult.inferenceMs ?? "unknown"}`);
console.log(`resultText:    ${JSON.stringify(chatResult.resultText)}`);
console.log(`output (first 300 chars): ${chatResult.output.slice(0, 300)}`);

if (chatResult.exitCode !== 0 || chatResult.resultText === null) {
  console.warn(
    "\nWARN: chat path returned empty content — qwen3 thinking models require large max_tokens budgets. See logFile for gateway SSE frames."
  );
  console.log(`logFile: ${chatResult.logFile}`);
}

// --- Test 2: delegate path ---
console.log(`\n--- Test 2: delegate path ---`);
const delegateResult = await executeHomeserverTask(
  {
    prompt: "What is 12 multiplied by 7? Answer with only the number.",
    gatewayBaseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    path: "delegate",
    taskType: "extract",
    timeoutMs: 120_000,
    maxOutputChars: 2_000,
  },
  taskId + "-delegate",
  logDir
);

console.log(`exitCode:      ${delegateResult.exitCode}`);
console.log(`backpressure:  ${delegateResult.backpressure}`);
console.log(`delegated:     ${delegateResult.delegated}`);
console.log(`outcome:       ${delegateResult.outcome}`);
console.log(`decisionReason: ${delegateResult.decisionReason}`);
console.log(`ledgerId:      ${delegateResult.ledgerId}`);
console.log(`promptTokens:  ${delegateResult.promptTokens ?? "unknown"}`);
console.log(`completionTokens: ${delegateResult.completionTokens ?? "unknown"}`);
console.log(`inferenceMs:   ${delegateResult.inferenceMs ?? "unknown"}`);
console.log(`resultText:    ${JSON.stringify(delegateResult.resultText)}`);
console.log(`output (first 300 chars): ${delegateResult.output.slice(0, 300)}`);

if (delegateResult.exitCode !== 0) {
  console.log(`logFile: ${delegateResult.logFile}`);
}

const success =
  chatResult.exitCode === 0 || delegateResult.exitCode === 0;

console.log(`\n[live-test-m5] RESULT: ${success ? "PASS" : "FAIL"}`);
process.exit(success ? 0 : 1);
