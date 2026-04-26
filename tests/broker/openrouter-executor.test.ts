import { describe, expect, it } from "vitest";
import { executeOpenRouterDelegation } from "../../src/broker/openrouter-executor.js";
import {
  OpenRouterClient,
  OpenRouterError,
  type OpenRouterChatRequest,
  type OpenRouterChatResponse,
} from "../../src/openrouter-client.js";
import type { DelegationEnvelope } from "../../src/broker/types.js";

function envelope(overrides: Partial<DelegationEnvelope> = {}): DelegationEnvelope {
  return {
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the README.",
    alias_requested: "large-reasoning",
    alias_map_version: 1,
    task_id: "20260426-120000-orch-deadbeef",
    broker_principal: "claude-code",
    received_at: "2026-04-26T12:00:00Z",
    alias_resolved: {
      alias: "large-reasoning",
      family: "one-shot",
      model_requested: "openai/gpt-oss-120b",
      runtime: "openrouter",
      runtime_row_id: "openrouter",
      host: "openrouter",
      reasoning_level: "medium",
    },
    policy_version: "zdr-v1+rlv-v1",
    ...overrides,
  };
}

function stubClient(
  handler: (req: OpenRouterChatRequest) => Promise<OpenRouterChatResponse> | OpenRouterChatResponse,
): OpenRouterClient {
  const c = new OpenRouterClient({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })),
  });
  // Override the chat method directly for fine-grained control over what
  // the executor sees back from the client (and to assert on the request).
  (c as unknown as { chat: typeof handler }).chat = handler;
  return c;
}

describe("executeOpenRouterDelegation", () => {
  it("returns a DelegationResult with provenance on success", async () => {
    const client = stubClient(async (req) => ({
      output: "the answer",
      finishReason: "stop",
      modelEffective: req.model,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      raw: {},
    }));
    const out = await executeOpenRouterDelegation(envelope(), { client });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.output).toBe("the answer");
    expect(out.result.runtime_effective).toBe("openrouter");
    expect(out.result.runtime_row_id_effective).toBe("openrouter");
    expect(out.result.host_effective).toBe("openrouter");
    expect(out.result.model_effective).toBe("openai/gpt-oss-120b");
    expect(out.result.alias_requested).toBe("large-reasoning");
    expect(out.result.prompt_tokens).toBe(10);
    expect(out.result.completion_tokens).toBe(5);
    expect(out.result.total_tokens).toBe(15);
    expect(out.result.provenance.policy_version).toBe("zdr-v1+rlv-v1");
    expect(out.result.provenance.scanner_pass).toBe("clean");
    expect(out.result.result_kind).toBe("text");
  });

  it("forwards reasoning level + max_output_tokens + timeout_ms from the envelope", async () => {
    let captured: OpenRouterChatRequest | undefined;
    const client = stubClient(async (req) => {
      captured = req;
      return {
        output: "ok",
        finishReason: "stop",
        modelEffective: req.model,
        usage: {},
        raw: {},
      };
    });
    await executeOpenRouterDelegation(
      envelope({ max_output_tokens: 256, timeout_ms: 30_000 }),
      { client },
    );
    expect(captured?.reasoningLevel).toBe("medium");
    expect(captured?.maxOutputTokens).toBe(256);
    expect(captured?.timeoutMs).toBe(30_000);
    expect(captured?.model).toBe("openai/gpt-oss-120b");
  });

  it("maps zdr_blocked to policy_rejected (non-retryable)", async () => {
    const client = stubClient(async () => {
      throw new OpenRouterError("zdr_blocked", "model 'evil/foo' is not on the pinned ZDR allowlist");
    });
    const out = await executeOpenRouterDelegation(envelope(), { client });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error.kind).toBe("policy_rejected");
    expect(out.error.retryable).toBe(false);
  });

  it("maps timeout to kind 'timeout' (retryable)", async () => {
    const client = stubClient(async () => {
      throw new OpenRouterError("timeout", "OpenRouter request timed out after 30s");
    });
    const out = await executeOpenRouterDelegation(envelope(), { client });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error.kind).toBe("timeout");
    expect(out.error.retryable).toBe(true);
  });

  it("maps network failures to executor_failed (retryable)", async () => {
    const client = stubClient(async () => {
      throw new OpenRouterError("network", "connect ECONNREFUSED");
    });
    const out = await executeOpenRouterDelegation(envelope(), { client });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error.kind).toBe("executor_failed");
    expect(out.error.retryable).toBe(true);
  });

  it("treats provider 5xx as retryable, 4xx (non-429) as not", async () => {
    const client500 = stubClient(async () => {
      throw new OpenRouterError("provider", "OpenRouter returned HTTP 503", {
        httpStatus: 503,
        providerMessage: "upstream busy",
      });
    });
    const out500 = await executeOpenRouterDelegation(envelope(), { client: client500 });
    expect(out500.ok).toBe(false);
    if (out500.ok) throw new Error("expected error");
    expect(out500.error.kind).toBe("executor_failed");
    expect(out500.error.retryable).toBe(true);
    expect(out500.error.message).toContain("upstream busy");

    const client400 = stubClient(async () => {
      throw new OpenRouterError("provider", "OpenRouter returned HTTP 400", {
        httpStatus: 400,
      });
    });
    const out400 = await executeOpenRouterDelegation(envelope(), { client: client400 });
    expect(out400.ok).toBe(false);
    if (out400.ok) throw new Error("expected error");
    expect(out400.error.retryable).toBe(false);

    const client429 = stubClient(async () => {
      throw new OpenRouterError("provider", "OpenRouter returned HTTP 429", {
        httpStatus: 429,
      });
    });
    const out429 = await executeOpenRouterDelegation(envelope(), { client: client429 });
    expect(out429.ok).toBe(false);
    if (out429.ok) throw new Error("expected error");
    expect(out429.error.retryable).toBe(true);
  });

  it("rejects envelopes whose resolved runtime is not openrouter", async () => {
    const client = stubClient(async () => {
      throw new Error("should not be called");
    });
    const out = await executeOpenRouterDelegation(
      envelope({
        alias_resolved: {
          alias: "tiny",
          family: "one-shot",
          model_requested: "qwen2.5:3b",
          runtime: "ollama",
          runtime_row_id: "ollama-pi",
          host: "pi",
        },
      }),
      { client },
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error.kind).toBe("internal");
    expect(out.error.message).toContain("openrouter");
  });

  it("rejects harness-family envelopes (deferred to pi-harness executor)", async () => {
    const client = stubClient(async () => {
      throw new Error("should not be called");
    });
    const out = await executeOpenRouterDelegation(
      envelope({
        alias_resolved: {
          alias: "pi-large-coder",
          family: "harness",
          harness: "pi",
          model_requested: "qwen/qwen3-coder-next",
          runtime: "openrouter",
          runtime_row_id: "openrouter",
          host: "openrouter",
        },
      }),
      { client },
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error.kind).toBe("internal");
    expect(out.error.message).toContain("one-shot");
  });

  it("respects scanner_policy: redact replaces matches in output", async () => {
    const client = stubClient(async () => ({
      output: "Here is a key: sk-ant-api03-secrettokensecrettokensecrettokensecrettokensecrettokensecrettokensecret-tokenAA",
      finishReason: "stop",
      modelEffective: "openai/gpt-oss-120b",
      usage: {},
      raw: {},
    }));
    const out = await executeOpenRouterDelegation(envelope(), {
      client,
      scannerPolicy: "redact",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.provenance.scanner_pass).toBe("redact");
    expect(out.result.output).not.toContain("sk-ant-api03-secrettokensecrettokensecrettokensecrettokensecrettokensecrettokensecret-token");
  });
});
