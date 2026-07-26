import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GRIMNIR_FIXTURE_SET_SHA256,
  GRIMNIR_SCHEMA_SHA256,
  GRIMNIR_SOURCE_REVISION,
  checkSchemaSupported,
  loadConsumerFixtureSet,
  loadNormativeSchema,
  loadVendoredJson,
  schemaErrors,
  sha256Hex,
  type JsonValue,
} from "../src/node-substrate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path));
const workload = JSON.parse(read("docs/workload-requirement-v1.json").toString("utf8"));
const provenance = JSON.parse(
  read("docs/workload-requirement-v1.provenance.json").toString("utf8"),
);
const schema = loadNormativeSchema();

function fixture(name: string): { records: JsonValue[] } {
  return JSON.parse(read(`docs/vendor/grimnir/${name}`).toString("utf8"));
}

describe("vendored Grimnir node/substrate v1 contract", () => {
  it("pins the exact shared schema and every immutable fixture", () => {
    expect(provenance).toEqual({
      source_repository: "Magnus-Gille/grimnir",
      source_revision: GRIMNIR_SOURCE_REVISION,
      schema_path: "docs/node-substrate-contract-v1.schema.json",
      schema_sha256: GRIMNIR_SCHEMA_SHA256,
      fixture_set_path: "tests/fixtures/node-substrate-contract/consumer-fixture-set.json",
      fixture_set_sha256: GRIMNIR_FIXTURE_SET_SHA256,
      vendored_schema_path: "docs/vendor/grimnir/node-substrate-contract-v1.schema.json",
      vendored_fixture_set_path: "docs/vendor/grimnir/consumer-fixture-set.json",
      interpretation: "No consumer-specific overlay is present.",
    });
    expect(GRIMNIR_SOURCE_REVISION).toBe("6d54d49c91612eae7dce5f66286d801900c38c35");
    expect(sha256Hex(read(provenance.vendored_schema_path))).toBe(provenance.schema_sha256);
    expect(sha256Hex(read(provenance.vendored_fixture_set_path))).toBe(
      provenance.fixture_set_sha256,
    );
    expect(sha256Hex(read("docs/vendor/grimnir/positive.json"))).toBe(
      "42f34fe1c576648240cef0f7f427073e9f39c11f8bfe0cf3f2ea74899bfee234",
    );
    expect(sha256Hex(read("docs/vendor/grimnir/partial-drain.json"))).toBe(
      "b596e56fb60a0710e1653c1a7935e15a98baf818b7ce6c56421a84cfbdd21d7b",
    );
    expect(sha256Hex(read("docs/vendor/grimnir/partial-substrate.json"))).toBe(
      "3a26d123bfcb98adbd8f8f81c2736b38d485a1ac2665deb1770636f219ba6d07",
    );
    expect(sha256Hex(read("docs/vendor/grimnir/negative.json"))).toBe(
      "e67d9233a556aa6da9728e9c07ae95ac3b1bc9abe9a4ac8ad817158829b8ead5",
    );
  });

  it("consumes the named shared fixture set without a Hugin overlay", () => {
    const fixtureSet = loadConsumerFixtureSet();
    expect(fixtureSet).toEqual({
      contract: "grimnir.node-substrate/v1",
      consumers: ["brokkr", "hugin", "mimir"],
      fixtures: ["positive.json", "partial-drain.json", "partial-substrate.json"],
      interpretation:
        "Each consumer reads the same versioned records and must reject decision-driving unknown, stale, incompatible, or unsupported semantics. No consumer-specific overlay is present.",
    });
  });

  it("validates every positive shared record directly against the pinned schema", () => {
    expect(() => checkSchemaSupported(schema)).not.toThrow();
    for (const name of ["positive.json", "partial-drain.json", "partial-substrate.json"]) {
      for (const record of fixture(name).records) {
        expect(schemaErrors(schema, schema, record), name).toEqual([]);
      }
    }
  });

  it("does not reinterpret schema-valid shared negatives as a private Hugin contract", () => {
    const negative = JSON.parse(read("docs/vendor/grimnir/negative.json").toString("utf8"));
    expect(schemaErrors(schema, schema, negative.schema_unsupported_version)).not.toEqual([]);
    expect(schemaErrors(schema, schema, negative.duplicate_hook_workload)).toEqual([]);
    expect(schemaErrors(schema, schema, negative.replayed_lifecycle)).toEqual([]);
  });

  it("fails closed when a pinned artifact drifts", () => {
    expect(() =>
      loadVendoredJson(
        resolve(root, provenance.vendored_schema_path),
        "0".repeat(64),
      ),
    ).toThrow(/drifted from its pinned revision/);
  });
});

describe("Hugin workload requirement v1", () => {
  it("validates the owner manifest against the shared schema", () => {
    expect(schemaErrors(schema, schema, workload)).toEqual([]);
  });

  it("declares the required lifecycle hook shape without secret or locality fields", () => {
    expect(workload.supported_architectures).toEqual(["arm64", "x86_64"]);
    expect(workload.secrets_boundary).toBe("owner_overlay");
    expect(workload.persistent_data).toBe("required");
    expect(workload.backup_restore).toBe("required");
    expect(workload.ports).toEqual([3032]);
    expect(workload.timers).toEqual([
      "hugin-daily-exam-factory.timer",
      "hugin-experiment-cadence.timer",
    ]);
    const hooks = new Map(workload.hooks.map((hook: Record<string, JsonValue>) => [hook.name, hook]));
    expect(hooks.get("preflight")?.mode).toBe("read_only");
    expect(hooks.get("verify")?.mode).toBe("read_only");
    expect(hooks.get("drain")?.mode).toBe("mutating");
    expect(hooks.get("drain")?.compensation_hook).toBe("compensate");
    expect(hooks.get("compensate")?.mode).toBe("mutating");
    expect(JSON.stringify(workload)).not.toMatch(/huginmunin|\/home\/magnus|password|token/i);
  });
});
