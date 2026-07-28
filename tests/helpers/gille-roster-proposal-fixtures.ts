type JsonObject = Record<string, unknown>;

export type RosterFixtureMutation = {
  op: "add" | "replace";
  path: string;
  value: unknown;
};

export type RosterAdversarialManifest = {
  fixture_version: "hugin-gille-roster-proposal-adversarial-v2";
  source: "gille-roster-proposal-v2-positive.json";
  source_bytes_sha256: string;
  cases: Array<{ name: string; mutations: RosterFixtureMutation[] }>;
};

const exactKeys = (value: JsonObject, keys: string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseRosterAdversarialManifest(raw: unknown): RosterAdversarialManifest {
  if (!isObject(raw) || !exactKeys(raw, ["fixture_version", "source", "source_bytes_sha256", "cases"])) {
    throw new Error("invalid roster fixture manifest shape");
  }
  if (
    raw.fixture_version !== "hugin-gille-roster-proposal-adversarial-v2"
    || raw.source !== "gille-roster-proposal-v2-positive.json"
    || typeof raw.source_bytes_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.source_bytes_sha256)
    || !Array.isArray(raw.cases)
    || raw.cases.length === 0
  ) throw new Error("invalid roster fixture manifest metadata");
  const names = new Set<string>();
  const cases = raw.cases.map((fixtureCase): RosterAdversarialManifest["cases"][number] => {
    if (!isObject(fixtureCase) || !exactKeys(fixtureCase, ["name", "mutations"])) {
      throw new Error("invalid roster fixture case shape");
    }
    if (
      typeof fixtureCase.name !== "string"
      || !/^[a-z][a-z0-9-]{2,80}$/.test(fixtureCase.name)
      || names.has(fixtureCase.name)
      || !Array.isArray(fixtureCase.mutations)
      || fixtureCase.mutations.length === 0
    ) throw new Error("invalid roster fixture case metadata");
    names.add(fixtureCase.name);
    const mutations = fixtureCase.mutations.map((mutation): RosterFixtureMutation => {
      if (!isObject(mutation) || !exactKeys(mutation, ["op", "path", "value"])) {
        throw new Error("invalid roster fixture mutation shape");
      }
      if (
        (mutation.op !== "add" && mutation.op !== "replace")
        || typeof mutation.path !== "string"
      ) throw new Error("invalid roster fixture mutation");
      parsePointer(mutation.path);
      return { op: mutation.op, path: mutation.path, value: structuredClone(mutation.value) };
    });
    return { name: fixtureCase.name, mutations };
  });
  return {
    fixture_version: raw.fixture_version,
    source: raw.source,
    source_bytes_sha256: raw.source_bytes_sha256,
    cases,
  };
}

function parsePointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") throw new Error("invalid roster fixture JSON pointer");
  return path.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("invalid roster fixture JSON pointer escape");
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded)) {
      throw new Error("unsafe roster fixture JSON pointer");
    }
    return decoded;
  });
}

export function applyRosterFixtureMutations(
  source: JsonObject,
  mutations: readonly RosterFixtureMutation[],
): JsonObject {
  const output = structuredClone(source);
  for (const mutation of mutations) {
    const parts = parsePointer(mutation.path);
    let parent: unknown = output;
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(parent)) {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= parent.length) throw new Error("roster fixture path not found");
        parent = parent[Number(part)];
      } else if (isObject(parent) && Object.hasOwn(parent, part)) {
        parent = parent[part];
      } else throw new Error("roster fixture path not found");
    }
    const leaf = parts.at(-1)!;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/.test(leaf)) throw new Error("invalid roster fixture array index");
      const index = Number(leaf);
      if (mutation.op === "replace") {
        if (index >= parent.length) throw new Error("roster fixture replace path not found");
        parent[index] = structuredClone(mutation.value);
      } else {
        if (index > parent.length) throw new Error("roster fixture add index out of bounds");
        parent.splice(index, 0, structuredClone(mutation.value));
      }
    } else if (isObject(parent)) {
      if (mutation.op === "replace" && !Object.hasOwn(parent, leaf)) throw new Error("roster fixture replace path not found");
      if (mutation.op === "add" && Object.hasOwn(parent, leaf)) throw new Error("roster fixture add path already exists");
      parent[leaf] = structuredClone(mutation.value);
    } else throw new Error("roster fixture parent is not a container");
  }
  return output;
}
