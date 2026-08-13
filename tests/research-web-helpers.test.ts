import { describe, expect, it } from "vitest";
import { isPublicAddress, requestPublicText, resolvePublicHost } from "../scripts/research-web-common.mjs";
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

  it("returns Node 22 lookup arrays only when the transport requests all addresses", async () => {
    const lookupOptions: boolean[] = [];
    const lookupResults: Array<{ all: boolean; address: unknown; family: unknown }> = [];
    let dnsCalls = 0;
    const requestImpl = (_url: URL, options: { lookup: (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void }, onResponse: (response: AsyncIterable<Buffer> & { statusCode: number; headers: Record<string, string> }) => void) => {
      for (const all of [true, false]) {
        options.lookup("example.com", { all }, (error, address, family) => {
          if (error) throw error;
          lookupOptions.push(all);
          lookupResults.push({ all, address, family });
        });
      }
      const response = {
        statusCode: 200,
        headers: { "content-type": "text/plain" },
        async *[Symbol.asyncIterator]() { yield Buffer.from("ok"); },
      } as AsyncIterable<Buffer> & { statusCode: number; headers: Record<string, string> };
      queueMicrotask(() => onResponse(response));
      return { setTimeout() {}, on() {}, end() {} };
    };

    const result = await requestPublicText("https://example.com", {
      lookup: async () => {
        dnsCalls += 1;
        return [
          { address: "1.1.1.1", family: 4 },
          { address: "2606:4700:4700::1111", family: 6 },
        ];
      },
      requestImpl,
    });

    expect(result.body).toBe("ok");
    expect(dnsCalls).toBe(1);
    expect(lookupOptions).toEqual([true, false]);
    expect(lookupResults).toEqual([
      { all: true, address: [{ address: "1.1.1.1", family: 4 }], family: undefined },
      { all: false, address: "1.1.1.1", family: 4 },
    ]);
  });

  it("extracts bounded DuckDuckGo result links and unwraps uddg redirects", () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example &amp; Docs</a>`;
    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: "Example & Docs", url: "https://example.com/doc" },
    ]);
  });
});
