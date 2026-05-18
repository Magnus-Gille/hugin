import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import {
  parseDeliveryPolicy,
  loadDeliveryTargets,
  DEFAULT_DELIVERY_TARGETS,
  parseArtifactManifest,
  parseRemote,
  deliverArtifacts,
  renderArtifactDeliverySection,
  type DeliveryTarget,
} from "../src/artifact-delivery.js";
import { buildTaskResultDocument } from "../src/result-format.js";

// --- spawn mock (FIFO behaviors) -------------------------------------------

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
let spawnBehaviors: Array<{ code: number; stdout?: string; stderr?: string }> =
  [];
let spawnIdx = 0;

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() {
    /* no-op for tests */
  }
}

const mockSpawn = ((cmd: string, args: string[]) => {
  spawnCalls.push({ cmd, args });
  const child = new MockChild();
  const behavior = spawnBehaviors[spawnIdx] ?? { code: 0 };
  spawnIdx++;
  setImmediate(() => {
    if (behavior.stdout) child.stdout.emit("data", Buffer.from(behavior.stdout));
    if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
    child.emit("close", behavior.code);
  });
  return child;
}) as unknown as typeof nodeSpawn;

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnIdx = 0;
});

const TARGETS: DeliveryTarget[] = [
  {
    user: "magnus",
    host: "10.0.0.1",
    remotePathPrefix: "/home/magnus/mimir-inbox/",
    localStagingPrefix: "/home/magnus/scratch/",
  },
];

function manifestBlock(json: string, beforePrompt = true): string {
  const artifacts = `### Artifacts\n\n\`\`\`json\n${json}\n\`\`\`\n`;
  const prompt = `### Prompt\n\ndo the thing\n`;
  return beforePrompt
    ? `## Task: t\n\n${artifacts}\n${prompt}`
    : `## Task: t\n\n${prompt}\n${artifacts}`;
}

const VALID_ENTRY = JSON.stringify([
  {
    id: "report",
    local: "/home/magnus/scratch/report.md",
    remote: "magnus@10.0.0.1:/home/magnus/mimir-inbox/report.md",
    required: true,
  },
]);

// --- policy / targets ------------------------------------------------------

describe("parseDeliveryPolicy", () => {
  it("defaults to require when unset/empty", () => {
    expect(parseDeliveryPolicy(undefined)).toBe("require");
    expect(parseDeliveryPolicy("")).toBe("require");
  });
  it("accepts off | warn | require (case-insensitive)", () => {
    expect(parseDeliveryPolicy("off")).toBe("off");
    expect(parseDeliveryPolicy("WARN")).toBe("warn");
    expect(parseDeliveryPolicy(" require ")).toBe("require");
  });
  it("throws on an invalid value", () => {
    expect(() => parseDeliveryPolicy("yolo")).toThrow(/HUGIN_DELIVERY_POLICY/);
  });
});

describe("loadDeliveryTargets", () => {
  it("returns the default NAS target when unset", () => {
    expect(loadDeliveryTargets(undefined)).toEqual(DEFAULT_DELIVERY_TARGETS);
  });
  it("normalizes prefixes to a trailing slash", () => {
    const t = loadDeliveryTargets(
      JSON.stringify([
        {
          user: "u",
          host: "h",
          remotePathPrefix: "/r",
          localStagingPrefix: "/l",
        },
      ]),
    );
    expect(t[0].remotePathPrefix).toBe("/r/");
    expect(t[0].localStagingPrefix).toBe("/l/");
  });
  it("throws on malformed JSON", () => {
    expect(() => loadDeliveryTargets("{not json")).toThrow(
      /HUGIN_DELIVERY_TARGETS/,
    );
  });
});

describe("parseRemote", () => {
  it("parses user@host:/abs/path", () => {
    expect(parseRemote("a@b:/c/d")).toEqual({
      user: "a",
      host: "b",
      path: "/c/d",
    });
  });
  it("rejects relative or malformed remotes", () => {
    expect(parseRemote("a@b:rel")).toBeNull();
    expect(parseRemote("nopath")).toBeNull();
  });
});

// --- manifest parsing / validation -----------------------------------------

describe("parseArtifactManifest", () => {
  it("returns absent when no ### Artifacts section", () => {
    const r = parseArtifactManifest("## Task\n\n### Prompt\nhi", TARGETS);
    expect(r.present).toBe(false);
    expect(r.manifest).toBeNull();
    expect(r.error).toBeNull();
  });

  it("parses a valid manifest placed before ### Prompt", () => {
    const r = parseArtifactManifest(manifestBlock(VALID_ENTRY), TARGETS);
    expect(r.error).toBeNull();
    expect(r.manifest?.artifacts[0].id).toBe("report");
  });

  it("rejects a manifest placed AFTER ### Prompt (grammar F11)", () => {
    const r = parseArtifactManifest(
      manifestBlock(VALID_ENTRY, false),
      TARGETS,
    );
    expect(r.manifest).toBeNull();
    expect(r.error).toMatch(/must appear before ### Prompt/);
    // Codex review #5: flagged so the dispatcher rejects it even when
    // HUGIN_DELIVERY_POLICY=off (the manifest would otherwise leak into the
    // agent prompt in rollback mode).
    expect(r.grammarViolation).toBe(true);
  });

  it("does NOT flag non-grammar errors as grammarViolation", () => {
    const r = parseArtifactManifest(manifestBlock("[not json"), TARGETS);
    expect(r.error).toBeTruthy();
    expect(r.grammarViolation).toBeFalsy();
  });

  it("the SDK prompt extraction excludes the manifest when ordered correctly", () => {
    // index.ts extracts the prompt with /###\s*Prompt\s*\n([\s\S]+)$/i
    const content = manifestBlock(VALID_ENTRY);
    const prompt = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i)?.[1] ?? "";
    expect(prompt).not.toContain("### Artifacts");
    expect(prompt).not.toContain("mimir-inbox");
  });

  it("rejects malformed JSON", () => {
    const r = parseArtifactManifest(manifestBlock("[not json"), TARGETS);
    expect(r.error).toMatch(/not valid JSON/);
  });

  it("rejects a missing required key", () => {
    const r = parseArtifactManifest(
      manifestBlock(JSON.stringify([{ id: "x", local: "/a", remote: "b" }])),
      TARGETS,
    );
    expect(r.error).toMatch(/shape invalid/);
  });

  it("rejects an un-substituted placeholder (skill template bug)", () => {
    const r = parseArtifactManifest(
      manifestBlock(
        JSON.stringify([
          {
            id: "report",
            local: "/home/magnus/scratch/<slug>.md",
            remote: "magnus@10.0.0.1:/home/magnus/mimir-inbox/r.md",
            required: true,
          },
        ]),
      ),
      TARGETS,
    );
    expect(r.error).toMatch(/placeholder/);
  });

  it("rejects a target not in the allowlist", () => {
    const r = parseArtifactManifest(
      manifestBlock(
        JSON.stringify([
          {
            id: "report",
            local: "/home/magnus/scratch/r.md",
            remote: "evil@9.9.9.9:/home/magnus/mimir-inbox/r.md",
            required: true,
          },
        ]),
      ),
      TARGETS,
    );
    expect(r.error).toMatch(/not in the HUGIN_DELIVERY_TARGETS allowlist/);
  });

  it("rejects path injection (.., newline, shell metachars)", () => {
    for (const bad of [
      "/home/magnus/scratch/../etc/passwd",
      "/home/magnus/scratch/a;rm -rf b",
      "/home/magnus/scratch/a\nb",
    ]) {
      const r = parseArtifactManifest(
        manifestBlock(
          JSON.stringify([
            {
              id: "report",
              local: bad,
              remote: "magnus@10.0.0.1:/home/magnus/mimir-inbox/r.md",
              required: true,
            },
          ]),
        ),
        TARGETS,
      );
      expect(r.error).toMatch(/unsafe/);
    }
  });

  it("rejects a local path outside the allowed staging prefix", () => {
    const r = parseArtifactManifest(
      manifestBlock(
        JSON.stringify([
          {
            id: "report",
            local: "/home/magnus/secrets/r.md",
            remote: "magnus@10.0.0.1:/home/magnus/mimir-inbox/r.md",
            required: true,
          },
        ]),
      ),
      TARGETS,
    );
    expect(r.error).toMatch(/not under the allowed staging prefix/);
  });

  it("rejects duplicate artefact ids", () => {
    const dup = JSON.stringify([
      {
        id: "report",
        local: "/home/magnus/scratch/a.md",
        remote: "magnus@10.0.0.1:/home/magnus/mimir-inbox/a.md",
        required: true,
      },
      {
        id: "report",
        local: "/home/magnus/scratch/b.md",
        remote: "magnus@10.0.0.1:/home/magnus/mimir-inbox/b.md",
        required: true,
      },
    ]);
    const r = parseArtifactManifest(manifestBlock(dup), TARGETS);
    expect(r.error).toMatch(/duplicate artefact id/);
  });
});

// --- deliverArtifacts ------------------------------------------------------

const manifestOf = parseArtifactManifest(
  manifestBlock(VALID_ENTRY),
  TARGETS,
).manifest!;

describe("deliverArtifacts", () => {
  it("succeeds: stat -> mkdir -> rsync -> sha match -> mv", async () => {
    spawnBehaviors = [
      { code: 0 }, // ssh mkdir -p
      { code: 0 }, // rsync
      { code: 0, stdout: "abc123  file" }, // ssh sha256sum
      { code: 0 }, // ssh mv
    ];
    const logs: string[] = [];
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: (l) => logs.push(l),
      spawnFn: mockSpawn,
      statFn: () => ({ size: 42 }),
      hashFn: () => "abc123",
    });
    expect(res.ok).toBe(true);
    expect(res.records[0]).toMatchObject({
      id: "report",
      status: "verified",
      bytes: 42,
      sha256: "abc123",
    });
    expect(spawnCalls.map((c) => c.cmd)).toEqual([
      "ssh",
      "rsync",
      "ssh",
      "ssh",
    ]);
  });

  it("missing local required file → terminal missing-local (the #68 bug)", async () => {
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      statFn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("missing-local");
    expect(res.records[0].status).toBe("missing-local");
    expect(spawnCalls).toHaveLength(0); // never touched the network
  });

  it("empty local required file → terminal missing-local", async () => {
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      statFn: () => ({ size: 0 }),
    });
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("missing-local");
  });

  it("rsync failure → infra delivery-failed", async () => {
    spawnBehaviors = [
      { code: 0 },
      { code: 23, stderr: "rsync: connection refused" },
    ];
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      statFn: () => ({ size: 10 }),
      hashFn: () => "h",
    });
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("infra");
    expect(res.records[0].status).toBe("delivery-failed");
  });

  it("sha mismatch → verify-failed, no mv", async () => {
    spawnBehaviors = [
      { code: 0 }, // mkdir
      { code: 0 }, // rsync
      { code: 0, stdout: "DIFFERENT  file" }, // sha256sum
    ];
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      statFn: () => ({ size: 10 }),
      hashFn: () => "localhash",
    });
    expect(res.ok).toBe(false);
    expect(res.records[0].status).toBe("verify-failed");
    // 3 calls only (mkdir, rsync, sha) — mv never ran
    expect(spawnCalls).toHaveLength(3);
  });

  it("rejects an artefact over the max size", async () => {
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      statFn: () => ({ size: 100 }),
      maxBytes: 10,
    });
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("infra");
    expect(spawnCalls).toHaveLength(0);
  });

  // Codex review #3: the string allowlist follows symlinks; a staged symlink
  // under the allowed prefix could exfiltrate any readable file.
  it("rejects a symlinked local staging path → terminal unsafe-local", async () => {
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      lstatFn: () => ({ isSymbolicLink: () => true }),
      statFn: () => ({ size: 42 }),
      hashFn: () => "h",
    });
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("unsafe-local");
    expect(res.records[0].status).toBe("unsafe-local");
    expect(spawnCalls).toHaveLength(0); // never touched the network
  });

  it("rejects a local path that realpath-resolves outside the staging root", async () => {
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      lstatFn: () => ({ isSymbolicLink: () => false }),
      realpathFn: () => "/home/magnus/.ssh/id_ed25519",
      stagingPrefixes: ["/home/magnus/scratch/"],
      statFn: () => ({ size: 42 }),
      hashFn: () => "h",
    });
    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("unsafe-local");
    expect(spawnCalls).toHaveLength(0);
  });

  it("allows a local path whose realpath stays under the staging root", async () => {
    spawnBehaviors = [
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: "abc123  file" },
      { code: 0 },
    ];
    const res = await deliverArtifacts({
      manifest: manifestOf,
      appendLog: () => {},
      spawnFn: mockSpawn,
      lstatFn: () => ({ isSymbolicLink: () => false }),
      realpathFn: (p) => p,
      stagingPrefixes: ["/home/magnus/scratch/"],
      statFn: () => ({ size: 42 }),
      hashFn: () => "abc123",
    });
    expect(res.ok).toBe(true);
  });

  it("is idempotent: a prior verified record is skipped", async () => {
    const res = await deliverArtifacts({
      manifest: manifestOf,
      priorRecords: [
        {
          id: "report",
          status: "verified",
          remote: manifestOf.artifacts[0].remote,
          bytes: 42,
          sha256: "abc123",
        },
      ],
      appendLog: () => {},
      spawnFn: mockSpawn,
      statFn: () => ({ size: 42 }),
      hashFn: () => "abc123",
    });
    expect(res.ok).toBe(true);
    expect(spawnCalls).toHaveLength(0); // skipped — no re-delivery
  });
});

describe("renderArtifactDeliverySection", () => {
  it("renders a verified section", () => {
    const s = renderArtifactDeliverySection({
      ok: true,
      records: [
        {
          id: "report",
          status: "verified",
          remote: "magnus@h:/p/r.md",
          bytes: 42,
          sha256: "abc",
        },
      ],
    });
    expect(s).toContain("### Artifact Delivery");
    expect(s).toContain("**Delivery:** verified");
    expect(s).toContain("`report`");
  });

  it("renders a failure section with failure kind + error", () => {
    const s = renderArtifactDeliverySection({
      ok: false,
      failureKind: "missing-local",
      error: "required artefact not produced",
      records: [
        {
          id: "report",
          status: "missing-local",
          remote: "magnus@h:/p/r.md",
          error: "no local file",
        },
      ],
    });
    expect(s).toContain("**Delivery:** FAILED");
    expect(s).toContain("**Failure kind:** missing-local");
    expect(s).toContain("required artefact not produced");
  });
});

// --- Ratatoskr compatibility guard -----------------------------------------

describe("Ratatoskr exit-code compatibility", () => {
  const RATATOSKR_RE = /\*\*Exit code:\*\*\s*(\d+)/;

  it("a delivery-failure result renders Exit code 2 → Ratatoskr reads FAILURE", () => {
    const doc = buildTaskResultDocument({
      exitCode: 2,
      failureKind: "DELIVERY_FAILED",
      startedAt: "t0",
      completedAt: "t1",
      durationSeconds: 1,
      executor: "agent-sdk",
      resultSource: "agent-sdk",
      logFile: "~/.hugin/logs/x.log",
      body: "### Response\n\nbody",
    });
    const m = doc.match(RATATOSKR_RE);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(2); // numeric, non-zero → failure (not success)
    expect(doc).toContain("- **Failure kind:** DELIVERY_FAILED");
  });

  it("a success result renders Exit code 0", () => {
    const doc = buildTaskResultDocument({
      exitCode: 0,
      startedAt: "t0",
      completedAt: "t1",
      durationSeconds: 1,
      executor: "agent-sdk",
      resultSource: "agent-sdk",
      logFile: "~/.hugin/logs/x.log",
      body: "ok",
    });
    expect(doc.match(RATATOSKR_RE)![1]).toBe("0");
    expect(doc).not.toContain("Failure kind");
  });
});
