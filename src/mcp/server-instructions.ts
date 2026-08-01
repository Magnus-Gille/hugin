export const HUGIN_MCP_SHARED_PREAMBLE =
  "Hugin fills the Broker envelope fields and safe defaults, so callers specify the task or learning event rather than protocol metadata like destination, durability, delivery, or escalation.";

export const HUGIN_MCP_SERVER_INSTRUCTIONS = [
  HUGIN_MCP_SHARED_PREAMBLE,
  "Use `hugin_models` when alias availability matters; it returns only aliases with a live Broker executor.",
  "Closed vocabularies are encoded in tool schemas as enums or discriminated unions. Prefer those fields over prose guesses.",
  "`hugin_submit` returns a durable `task_id` plus `idempotency_key`; `hugin_await` polls it; `hugin_rate` appends an exact-bound quality receipt.",
  "The `hugin_experiment_*` tools are content-blind. Prompts and fixtures stay in their owning repositories while Hugin stores versions and SHA-256 fingerprints.",
].join(" ");
