import { describe, expect, it } from "vitest";
import {
  OpenRouterClient,
  OpenRouterError,
  mapChatResponse,
} from "../src/openrouter-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouterClient", () => {
  it("rejects requests for non-allowlisted models before fetching", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(
      client.chat({ model: "openai/gpt-4o", prompt: "hi" }),
    ).rejects.toThrowError(/not on the pinned ZDR allowlist/);
    expect(called).toBe(false);
  });

  it("constructor refuses an empty apiKey", () => {
    expect(() => new OpenRouterClient({ apiKey: "" })).toThrowError(/apiKey/);
  });

  it("sends a well-formed chat request and parses the choice text", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      captured = { url: url.toString(), init: init ?? {} };
      return jsonResponse({
        model: "openai/gpt-oss-120b",
        choices: [
          {
            message: { content: "answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      });
    };
    const client = new OpenRouterClient({
      apiKey: "test-key",
      fetchImpl,
      referer: "https://hugin.local",
      appTitle: "hugin-test",
    });
    const res = await client.chat({
      model: "openai/gpt-oss-120b",
      prompt: "hello",
      systemPrompt: "be terse",
      reasoningLevel: "medium",
    });

    expect(res.output).toBe("answer");
    expect(res.finishReason).toBe("stop");
    expect(res.modelEffective).toBe("openai/gpt-oss-120b");
    expect(res.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });

    expect(captured).toBeDefined();
    expect(captured!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["http-referer"]).toBe("https://hugin.local");
    expect(headers["x-title"]).toBe("hugin-test");

    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
    ]);
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("forwards temperature and max_tokens when provided", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse((init?.body as string) ?? "{}");
      return jsonResponse({
        choices: [{ message: { content: "ok" } }],
      });
    };
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await client.chat({
      model: "openai/gpt-oss-120b",
      prompt: "hi",
      temperature: 0.2,
      maxOutputTokens: 256,
    });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(256);
  });

  it("maps non-2xx responses to OpenRouterError code 'provider'", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("boom", { status: 502 });
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    try {
      await client.chat({ model: "openai/gpt-oss-120b", prompt: "hi" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenRouterError);
      const e = err as OpenRouterError;
      expect(e.code).toBe("provider");
      expect(e.httpStatus).toBe(502);
      expect(e.providerMessage).toBe("boom");
    }
  });

  it("maps fetch network failure to code 'network'", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    try {
      await client.chat({ model: "openai/gpt-oss-120b", prompt: "hi" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenRouterError);
      expect((err as OpenRouterError).code).toBe("network");
    }
  });

  it("maps abort due to timeout to code 'timeout'", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        const sig = (init?.signal as AbortSignal | undefined) ?? null;
        if (sig?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        sig?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
        setTimeout(resolve, 1000).unref?.();
      });
      return jsonResponse({});
    };
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    try {
      await client.chat({
        model: "openai/gpt-oss-120b",
        prompt: "hi",
        timeoutMs: 10,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenRouterError);
      expect((err as OpenRouterError).code).toBe("timeout");
    }
  });

  it("maps stalled response body to code 'timeout' (timer covers body parse)", async () => {
    // Headers arrive promptly; body never resolves until the abort fires.
    const fetchImpl: typeof fetch = async (_url, init) => {
      const sig = (init?.signal as AbortSignal | undefined) ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (sig?.aborted) {
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          sig?.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          // Never enqueues — body hangs until abort.
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    try {
      await client.chat({
        model: "openai/gpt-oss-120b",
        prompt: "hi",
        timeoutMs: 20,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenRouterError);
      expect((err as OpenRouterError).code).toBe("timeout");
      expect((err as OpenRouterError).message).toMatch(/stalled|timed out/);
    }
  });

  it("maps malformed JSON body to code 'parse'", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    try {
      await client.chat({ model: "openai/gpt-oss-120b", prompt: "hi" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenRouterError);
      expect((err as OpenRouterError).code).toBe("parse");
    }
  });
});

describe("mapChatResponse", () => {
  it("returns output text from the first choice", () => {
    const out = mapChatResponse({
      model: "openai/gpt-oss-120b",
      choices: [{ message: { content: "yes" }, finish_reason: "stop" }],
      usage: { total_tokens: 3 },
    });
    expect(out.output).toBe("yes");
    expect(out.finishReason).toBe("stop");
    expect(out.modelEffective).toBe("openai/gpt-oss-120b");
    expect(out.usage.total_tokens).toBe(3);
  });

  it("throws code='parse' when content is missing", () => {
    expect(() =>
      mapChatResponse({ choices: [{ message: {} }] }),
    ).toThrowError(/missing choices/);
  });

  it("throws code='parse' on non-object input", () => {
    expect(() => mapChatResponse(null)).toThrowError(/not an object/);
    expect(() => mapChatResponse("string")).toThrowError(/not an object/);
  });
});
