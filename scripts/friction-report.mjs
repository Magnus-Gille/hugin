#!/usr/bin/env node
/**
 * friction-report — v1 aggregation over signals/friction.
 *
 * Lists entries in `signals/friction`, groups counts by `model:<id>`
 * tag, and prints one count table per friction type and severity. No
 * denominators in v1 — denominator joins against the orch-v1
 * delegation journal are deferred to v2 once that journal is producing
 * rated data.
 *
 * Env:
 *   MUNIN_URL     (default http://localhost:3030)
 *   MUNIN_API_KEY (required)
 *
 * Usage:
 *   npm run friction-report
 */

const MUNIN_URL = (process.env.MUNIN_URL ?? "http://localhost:3030").replace(/\/$/, "");
const MUNIN_API_KEY = process.env.MUNIN_API_KEY;
if (!MUNIN_API_KEY) {
  process.stderr.write("friction-report: MUNIN_API_KEY required\n");
  process.exit(1);
}

let rpcId = 0;

async function munin(name, args) {
  const body = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const res = await fetch(`${MUNIN_URL}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MUNIN_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Munin ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  let payload = text;
  // SSE → take last data: line
  const lines = text.split("\n");
  let last = "";
  for (const line of lines) {
    if (line.startsWith("data:")) last = line.slice(5).trimStart();
  }
  if (last) payload = last;
  const rpc = JSON.parse(payload);
  if (rpc.error) throw new Error(`Munin RPC error: ${JSON.stringify(rpc.error)}`);
  const content = rpc.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : rpc.result;
}

function tagValue(tags, prefix) {
  for (const t of tags ?? []) {
    if (typeof t === "string" && t.startsWith(prefix)) return t.slice(prefix.length);
  }
  return null;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const list = await munin("memory_list", { namespace: "signals/friction", limit: 1000 });
  const entries = Array.isArray(list?.entries) ? list.entries : Array.isArray(list) ? list : [];

  if (entries.length === 0) {
    console.log("No friction events recorded yet.");
    return;
  }

  const byModel = new Map(); // model -> { friction:Map, severity:Map, total:number }

  for (const entry of entries) {
    const tags = entry.tags ?? [];
    const model = tagValue(tags, "model:") ?? "unknown";
    const fric = tagValue(tags, "friction:") ?? "unknown";
    const sev = tagValue(tags, "severity:") ?? "unknown";
    let row = byModel.get(model);
    if (!row) {
      row = { friction: new Map(), severity: new Map(), total: 0 };
      byModel.set(model, row);
    }
    row.total++;
    row.friction.set(fric, (row.friction.get(fric) ?? 0) + 1);
    row.severity.set(sev, (row.severity.get(sev) ?? 0) + 1);
  }

  console.log(`Friction events: ${entries.length} across ${byModel.size} model(s)\n`);

  for (const [model, row] of byModel) {
    console.log(`== ${model} (n=${row.total}) ==`);
    console.log("  by friction_type:");
    const fricSorted = [...row.friction.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of fricSorted) {
      console.log(`    ${pad(k, 24)} ${v}`);
    }
    console.log("  by severity:");
    const sevSorted = [...row.severity.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sevSorted) {
      console.log(`    ${pad(k, 24)} ${v}`);
    }
    console.log("");
  }
}

main().catch((err) => {
  process.stderr.write(`friction-report: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
