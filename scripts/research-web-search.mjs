#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { decodeHtml, htmlToText, readJsonStdin, requestPublicText } from "./research-web-common.mjs";

export function parseDuckDuckGoResults(html) {
  const results = [];
  const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    let target = decodeHtml(match[1]);
    try {
      const parsed = new URL(target, "https://html.duckduckgo.com");
      const redirected = parsed.searchParams.get("uddg");
      target = redirected ? decodeURIComponent(redirected) : parsed.toString();
      const targetUrl = new URL(target);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) continue;
      results.push({ title: htmlToText(match[2]), url: targetUrl.toString() });
    } catch {
      continue;
    }
    if (results.length >= 10) break;
  }
  return results;
}

async function main() {
  try {
    const input = await readJsonStdin();
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 1_000) {
      throw new Error("query is required");
    }
    // Legacy no-secret fallback only. This HTML scraper is intentionally not
    // presented as the production structured provider; activate a
    // Hugin-owned credentialed structured provider behind a host-side helper
    // before relying on broad research search again.
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", input.query.trim());
    const result = await requestPublicText(url.toString());
    const results = parseDuckDuckGoResults(result.body);
    if (results.length === 0) throw new Error("Search returned no parseable results");
    process.stdout.write(JSON.stringify({ query: input.query.trim(), results }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
