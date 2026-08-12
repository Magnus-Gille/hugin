#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { htmlToText, readJsonStdin, requestPublicText } from "./research-web-common.mjs";

async function main() {
  try {
    const input = await readJsonStdin();
    if (typeof input.url !== "string" || input.url.length > 4_096) throw new Error("url is required");
    const result = await requestPublicText(input.url);
    const title = result.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    process.stdout.write(JSON.stringify({
      url: result.url,
      title: title ? htmlToText(title) : "",
      content: htmlToText(result.body).slice(0, 120_000),
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
