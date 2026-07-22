import { z } from "zod";
import type { HomeserverGatewayConfig } from "./homeserver-executor.js";

const wireSha256Schema = z.string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value) => value.slice("sha256:".length));

/** Content-blind join returned by Gille's authenticated GET /ledger/{id}. */
export const m5LedgerAttemptBindingSchema = z.object({
  id: z.string().min(1),
  // Gille's ledger contract uses the explicit `sha256:` wire prefix. Hugin's
  // durable schemas use the canonical bare digest, so normalize only after
  // validating the exact upstream representation.
  evidenceIdentityHash: wireSha256Schema,
  taskInstanceId: z.string().min(1),
  attemptId: z.string().min(1),
  taskType: z.string().min(1),
  modelId: z.string().min(1),
}).strip();

export type M5LedgerAttemptBinding = z.infer<typeof m5LedgerAttemptBindingSchema>;
export type ResolveM5LedgerAttemptBinding = (
  ledgerId: string,
) => Promise<M5LedgerAttemptBinding>;

const MAX_LEDGER_RESPONSE_BYTES = 64 * 1024;
const LEDGER_LOOKUP_TIMEOUT_MS = 5_000;

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("M5 ledger binding response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_LEDGER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("M5 ledger binding response exceeded the size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchM5LedgerAttemptBinding(
  gateway: HomeserverGatewayConfig,
  ledgerId: string,
  signal?: AbortSignal,
): Promise<M5LedgerAttemptBinding> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (gateway.apiKey) headers.Authorization = `Bearer ${gateway.apiKey}`;
  const response = await fetch(`${gateway.baseUrl}/ledger/${encodeURIComponent(ledgerId)}`, {
    method: "GET",
    headers,
    signal: signal ?? AbortSignal.timeout(LEDGER_LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`M5 ledger binding lookup failed with HTTP ${response.status}`);
  }
  const text = await readBoundedResponseBody(response);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("M5 ledger binding response was not valid JSON");
  }
  const parsed = m5LedgerAttemptBindingSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== ledgerId) {
    throw new Error("M5 ledger binding response did not match the requested authoritative row");
  }
  return parsed.data;
}
