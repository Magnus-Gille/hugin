import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;

export function isPublicAddress(address) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!net.isIPv6(normalized)) return false;
  return !(
    normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")
  );
}

export async function resolvePublicHost(hostname, lookup = dns.lookup) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`No DNS addresses for ${hostname}`);
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error(`Refusing non-public DNS result for ${hostname}`);
  }
  return addresses[0];
}

export async function requestPublicText(rawUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const lookup = options.lookup ?? dns.lookup;
  const requestImpl = options.requestImpl;
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only credential-free HTTP(S) URLs are allowed");
  }
  const resolved = await resolvePublicHost(url.hostname, lookup);
  const transport = requestImpl ?? (url.protocol === "https:" ? https.request : http.request);
  const response = await new Promise((resolve, reject) => {
    const req = transport(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.8,*/*;q=0.1",
        "accept-encoding": "identity",
        "user-agent": "HuginResearch/1.0 (+https://github.com/Magnus-Gille/hugin)",
        ...(options.headers ?? {}),
      },
      lookup: (_host, opts, callback) => opts.all
        ? callback(null, [{ address: resolved.address, family: resolved.family }])
        : callback(null, resolved.address, resolved.family),
    }, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Research fetch timed out")));
    req.on("error", reject);
    req.end();
  });
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && response.headers.location) {
    response.resume();
    if (maxRedirects <= 0) throw new Error("Too many redirects");
    return requestPublicText(new URL(response.headers.location, url).toString(), {
      ...options,
      maxRedirects: maxRedirects - 1,
    });
  }
  if (status < 200 || status >= 300) {
    response.resume();
    throw new Error(`Research fetch returned HTTP ${status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      throw new Error(`Research fetch exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return {
    url: url.toString(),
    contentType: String(response.headers["content-type"] ?? ""),
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

export function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

export function htmlToText(html) {
  return decodeHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readJsonStdin(limit = 32_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error("Research helper input is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
