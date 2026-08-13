/* Hugin-owned Pi research tools.  This file is loaded explicitly by the
 * dedicated research runtime.  It intentionally registers no filesystem
 * reader, shell, SSH, rsync, or Munin tool. */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promises as dns } from "node:dns";
import { createHash } from "node:crypto";
import net from "node:net";

const schema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 };

function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("URL is not parseable"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".").map(Number);
  const privateV4 = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
  const literalForbidden = net.isIP(host) !== 0 && !isPublicAddress(host);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || privateV4 || literalForbidden || host === "localhost" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || host.endsWith(".local") || host.endsWith(".ts.net")) throw new Error("URL targets a forbidden host");
  const allow = (process.env.HUGIN_RESEARCH_ALLOWED_SEARCH_HOSTS || "*").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes("*") && !allow.some((h) => host === h || (h.startsWith("*.") && host.endsWith(h.slice(1))))) throw new Error(`URL host ${host} is not allowlisted`);
  return url.toString();
}

function isPublicAddress(address) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  const mapped = address.toLowerCase().split("::");
  if (mapped.length === 2) {
    const right = mapped[1].split(":");
    const groups = [...mapped[0].split(":").filter(Boolean), ...Array.from({ length: 8 - mapped[0].split(":").filter(Boolean).length - right.length }, () => "0"), ...right];
    if (groups.length === 8 && groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
      const first = Number.parseInt(groups[6], 16); const second = Number.parseInt(groups[7], 16);
      return isPublicAddress(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
  }
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (!net.isIPv6(normalized)) return true;
  return normalized !== "::" && normalized !== "::1" &&
    !normalized.startsWith("fc") && !normalized.startsWith("fd") &&
    !/^fe[89ab]/.test(normalized) && !normalized.startsWith("ff");
}

async function resolvePublicUrl(raw) {
  const checked = allowedUrl(raw);
  const host = new URL(checked).hostname;
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("URL DNS resolution returned a forbidden private address");
  return checked;
}

function helper(command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("research helper timed out")); }, 15000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > 200000) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout.slice(0, 100000)) : reject(new Error(stderr.slice(0, 1000) || `research helper exited ${code}`)); });
    child.stdin.end(JSON.stringify(payload));
  });
}

const result = (text) => ({ content: [{ type: "text", text }], details: {} });

async function recordEvidence(record) {
  const file = process.env.HUGIN_RESEARCH_EVIDENCE_FILE;
  if (!file) return;
  await writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

function parseHelperJson(raw, label) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${label} helper returned invalid JSON`); }
  if (!parsed || typeof parsed !== "object") throw new Error(`${label} helper returned invalid JSON`);
  return parsed;
}

export default function registerResearchTools(pi) {
  pi.registerTool({
    name: "web_search", label: "web_search", description: "Search the public web through the configured Hugin helper.",
    parameters: schema({ query: string }, ["query"]),
    execute: async (_id, params) => {
      const raw = await helper(process.env.HUGIN_RESEARCH_SEARCH_HELPER, { query: params.query });
      const parsed = parseHelperJson(raw, "search");
      if (!Array.isArray(parsed.results) || parsed.results.length === 0) throw new Error("search helper returned no results");
      await recordEvidence({ kind: "search" });
      return result(raw);
    },
  });
  pi.registerTool({
    name: "fetch_content", label: "fetch_content", description: "Fetch one public web page through the configured Hugin helper.",
    parameters: schema({ url: string }, ["url"]),
    execute: async (_id, params) => {
      const raw = await helper(process.env.HUGIN_RESEARCH_FETCH_HELPER, { url: await resolvePublicUrl(params.url) });
      const parsed = parseHelperJson(raw, "fetch");
      if (typeof parsed.url !== "string" || typeof parsed.content !== "string" || parsed.content.trim().length === 0) throw new Error("fetch helper returned empty content");
      const fetchedUrl = await resolvePublicUrl(parsed.url);
      await recordEvidence({
        kind: "fetch",
        url: fetchedUrl,
        sha256: createHash("sha256").update(parsed.content, "utf8").digest("hex"),
      });
      return result(raw);
    },
  });
  pi.registerTool({
    name: "write_artifact", label: "write_artifact", description: "Write a completed research artifact by declared ID.",
    parameters: schema({ id: string, content: string }, ["id", "content"]),
    execute: async (_id, params) => {
      const artifacts = JSON.parse(process.env.HUGIN_RESEARCH_ARTIFACTS || "{}");
      const file = artifacts[params.id];
      if (typeof file !== "string" || !file.startsWith("/")) throw new Error("Unknown artifact ID");
      await writeFile(file, params.content, { encoding: "utf8", mode: 0o600 });
      return result(`artifact ${params.id} written`);
    },
  });
}
