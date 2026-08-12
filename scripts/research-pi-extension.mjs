/* Hugin-owned Pi research tools.  This file is loaded explicitly by the
 * dedicated research runtime.  It intentionally registers no filesystem
 * reader, shell, SSH, rsync, or Munin tool. */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promises as dns } from "node:dns";

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
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || privateV4 || host === "localhost" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") || host.endsWith(".local") || host.endsWith(".ts.net")) throw new Error("URL targets a forbidden host");
  const allow = (process.env.HUGIN_RESEARCH_ALLOWED_SEARCH_HOSTS || "*").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes("*") && !allow.some((h) => host === h || (h.startsWith("*.") && host.endsWith(h.slice(1))))) throw new Error(`URL host ${host} is not allowlisted`);
  return url.toString();
}

async function resolvePublicUrl(raw) {
  const checked = allowedUrl(raw);
  const host = new URL(checked).hostname;
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => {
    const octets = address.split(".").map(Number);
    return address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:") ||
      (octets.length === 4 && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)));
  })) throw new Error("URL DNS resolution returned a forbidden private address");
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

export default function registerResearchTools(pi) {
  pi.registerTool({
    name: "web_search", label: "web_search", description: "Search the public web through the configured Hugin helper.",
    parameters: schema({ query: string }, ["query"]),
    execute: async (_id, params) => result(String(await helper(process.env.HUGIN_RESEARCH_SEARCH_HELPER, { query: params.query }))),
  });
  pi.registerTool({
    name: "fetch_content", label: "fetch_content", description: "Fetch one public web page through the configured Hugin helper.",
    parameters: schema({ url: string }, ["url"]),
    execute: async (_id, params) => result(String(await helper(process.env.HUGIN_RESEARCH_FETCH_HELPER, { url: await resolvePublicUrl(params.url) }))),
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
