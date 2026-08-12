import { describe, expect, it } from "vitest";
import { isPublicAddress, resolvePublicHost } from "../scripts/research-web-common.mjs";
import { parseDuckDuckGoResults } from "../scripts/research-web-search.mjs";

describe("research web helpers", () => {
  it("rejects private, loopback, link-local, CGNAT, and mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("fails closed when any DNS answer is non-public", async () => {
    await expect(resolvePublicHost("mixed.example", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow(/non-public/);
  });

  it("extracts bounded DuckDuckGo result links and unwraps uddg redirects", () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example &amp; Docs</a>`;
    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: "Example & Docs", url: "https://example.com/doc" },
    ]);
  });
});
