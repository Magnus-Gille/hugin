import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const REPO_ROOT = process.cwd();
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const INDEX_PATH = path.join(DOCS_DIR, "index.md");
const PROBES_PATH = path.join(REPO_ROOT, "tests/fixtures/instruction-probes/probes.json");
const PROBES_SHA256 = "921559344beee6320d6553f9a626ff23b6156ac36e54aff8edf08b7a072ef075";
const CONTROL_PROBE_ID = "private-orchestrator-CONTROL";
const CONTROL_PROBE = {
  id: CONTROL_PROBE_ID,
  kind: "control",
  prompt: "The prompt is private. Can Runtime: orchestrator still fan out to the usual cloud roles by default?",
  target: "AGENTS.md",
  assert_regex:
    "(?i)(must be rejected|reject(ed)? before any model call|unless every configured role uses a sovereign/local provider|default cloud fan-out must never receive private data)",
  assert_note:
    "CONTROL PROBE. This targets inline runtime-permission rules that stay in AGENTS.md in both arms. If it changes, the harness is measuring unrelated drift rather than the docs-index split.",
} as const;

interface InstructionProbe {
  id: string;
  kind: string;
  prompt: string;
  target: string;
  assert_regex?: string;
  assert_note?: string;
}

interface InstructionProbeFixture {
  $comment: string;
  version: number;
  frozen_at_base_commit: string;
  probes: InstructionProbe[];
}

function walkMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkMarkdownFiles(absolutePath);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      return [absolutePath];
    }
    return [];
  });
}

function normalizeDocPath(linkTarget: string): string {
  const cleanTarget = linkTarget.split("#", 1)[0];
  const resolved = path.resolve(path.dirname(INDEX_PATH), cleanTarget);
  return path.relative(REPO_ROOT, resolved).split(path.sep).join("/");
}

function decodeLinkTarget(linkTarget: string): string {
  try {
    return decodeURIComponent(linkTarget);
  } catch {
    return linkTarget;
  }
}

function stripAngleBrackets(linkTarget: string): string {
  if (linkTarget.startsWith("<") && linkTarget.endsWith(">")) {
    return linkTarget.slice(1, -1);
  }
  return linkTarget;
}

function getUriScheme(linkTarget: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(linkTarget);
  return match?.[1]?.toLowerCase() ?? null;
}

function isAllowedExternalMarkdownLink(linkTarget: string): boolean {
  if (linkTarget.startsWith("//")) {
    return true;
  }

  const scheme = getUriScheme(linkTarget);
  return scheme === "http" || scheme === "https";
}

function isMarkdownDocTarget(linkTarget: string): boolean {
  return /\.md$/i.test(linkTarget.split("#", 1)[0]);
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectReferenceDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  const definitionPattern =
    /^[ \t]{0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|[^\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*$/gm;

  for (const match of markdown.matchAll(definitionPattern)) {
    const [, label, rawTarget] = match;
    definitions.set(normalizeReferenceLabel(label), stripAngleBrackets(rawTarget));
  }

  return definitions;
}

function collectMarkdownDocTargets(markdown: string): string[] {
  const extractedTargets: Array<{ index: number; target: string }> = [];
  const inlinePattern =
    /\[[^\]]+\]\(\s*(<[^>\n]+>|[^()\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;

  for (const match of markdown.matchAll(inlinePattern)) {
    extractedTargets.push({
      index: match.index ?? 0,
      target: stripAngleBrackets(match[1]),
    });
  }

  const referenceDefinitions = collectReferenceDefinitions(markdown);
  const referencePattern = /\[([^\]]+)\]\[([^\]]*)\]/g;

  for (const match of markdown.matchAll(referencePattern)) {
    const [, text, rawLabel] = match;
    const resolvedLabel = normalizeReferenceLabel(rawLabel === "" ? text : rawLabel);
    const target = referenceDefinitions.get(resolvedLabel);
    if (!target) {
      continue;
    }

    extractedTargets.push({
      index: match.index ?? 0,
      target,
    });
  }

  return extractedTargets.sort((left, right) => left.index - right.index).map(({ target }) => target);
}

function lexicallyEscapesDocs(linkTarget: string): boolean {
  if (path.isAbsolute(linkTarget)) {
    return true;
  }

  let depth = 0;
  for (const segment of linkTarget.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
      continue;
    }
    depth += 1;
  }

  return false;
}

function resolvesOutsideDocs(linkTarget: string): boolean {
  const resolved = path.resolve(path.dirname(INDEX_PATH), linkTarget);
  const relativeToDocs = path.relative(DOCS_DIR, resolved);
  return relativeToDocs === ".." || relativeToDocs.startsWith(`..${path.sep}`);
}

function collectIndexedMarkdownDocs(markdown: string): {
  duplicateDocs: string[];
  escapingDocLinks: string[];
  indexedDocs: Set<string>;
} {
  const docCounts = new Map<string, number>();
  const escapingDocLinks: string[] = [];
  const indexedDocs = new Set<string>();

  for (const target of collectMarkdownDocTargets(markdown)) {
    if (!isMarkdownDocTarget(target)) {
      continue;
    }

    if (isAllowedExternalMarkdownLink(target)) {
      continue;
    }

    if (getUriScheme(target) !== null || target.startsWith("//")) {
      escapingDocLinks.push(target);
      continue;
    }

    const cleanTarget = decodeLinkTarget(target.split("#", 1)[0]);
    if (lexicallyEscapesDocs(cleanTarget) || resolvesOutsideDocs(cleanTarget)) {
      escapingDocLinks.push(target);
      continue;
    }

    const normalized = normalizeDocPath(cleanTarget);
    if (!normalized.startsWith("docs/")) {
      escapingDocLinks.push(target);
      continue;
    }

    indexedDocs.add(normalized);
    docCounts.set(normalized, (docCounts.get(normalized) ?? 0) + 1);
  }

  const duplicateDocs = [...docCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([docPath]) => docPath)
    .sort();

  return { duplicateDocs, escapingDocLinks, indexedDocs };
}

function loadInstructionProbes(): {
  bytes: Buffer;
  digest: string;
  fixture: InstructionProbeFixture;
} {
  const bytes = readFileSync(PROBES_PATH);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fixture = JSON.parse(bytes.toString("utf8")) as InstructionProbeFixture;
  return { bytes, digest, fixture };
}

describe("docs/index.md coverage", () => {
  test("tracks duplicate indexed markdown docs across titled and angle-bracket links", () => {
    const markdown = [
      '- [Daily exams](daily-exam-factory.md "overview")',
      "- [Daily exams again](<daily-exam-factory.md#quarantine-lanes>)",
    ].join("\n");

    expect(collectIndexedMarkdownDocs(markdown)).toEqual({
      duplicateDocs: ["docs/daily-exam-factory.md"],
      escapingDocLinks: [],
      indexedDocs: new Set(["docs/daily-exam-factory.md"]),
    });
  });

  test("rejects markdown links that use angle brackets to escape docs/", () => {
    const markdown = "- [Lexical escape](<../README.md>)";

    expect(collectIndexedMarkdownDocs(markdown)).toEqual({
      duplicateDocs: [],
      escapingDocLinks: ["../README.md"],
      indexedDocs: new Set(),
    });
  });

  test("rejects reference-style escapes and still tracks duplicate reference targets", () => {
    const markdown = [
      "- [Daily exams][daily]",
      "- [Daily exams again][daily-dup]",
      "- [Reference escape][escape]",
      "",
      "[daily]: daily-exam-factory.md",
      '[daily-dup]: <daily-exam-factory.md#quarantine-lanes> "overview"',
      "[escape]: ../README.md",
    ].join("\n");

    expect(collectIndexedMarkdownDocs(markdown)).toEqual({
      duplicateDocs: ["docs/daily-exam-factory.md"],
      escapingDocLinks: ["../README.md"],
      indexedDocs: new Set(["docs/daily-exam-factory.md"]),
    });
  });

  test("rejects encoded escapes and non-http markdown schemes while allowing legitimate external links", () => {
    const markdown = [
      "- [Encoded escape](subdir/%2e%2e/%2e%2e/README.md)",
      "- [File scheme](file:../README.md)",
      "- [Unknown scheme](custom:reference.md)",
      "- [External markdown](https://example.com/reference.md)",
      "- [External markdown http](http://example.com/reference.md)",
      "- [Heading](#security-trust-and-provenance)",
      "- [PNG asset](images/overview.png)",
    ].join("\n");

    expect(collectIndexedMarkdownDocs(markdown)).toEqual({
      duplicateDocs: [],
      escapingDocLinks: ["subdir/%2e%2e/%2e%2e/README.md", "file:../README.md", "custom:reference.md"],
      indexedDocs: new Set(),
    });
  });

  test("indexes every markdown doc under docs/ and avoids stale markdown links", () => {
    const markdown = readFileSync(INDEX_PATH, "utf8");
    const { duplicateDocs, escapingDocLinks, indexedDocs } = collectIndexedMarkdownDocs(markdown);
    indexedDocs.delete("docs/index.md");

    const existingDocs = walkMarkdownFiles(DOCS_DIR)
      .map((absolutePath) => path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"))
      .filter((relativePath) => relativePath !== "docs/index.md")
      .sort();

    const missingDocs = existingDocs.filter((relativePath) => !indexedDocs.has(relativePath));
    const staleDocs = [...indexedDocs].filter((relativePath) => !existingDocs.includes(relativePath)).sort();

    expect(duplicateDocs, `docs/index.md contains duplicate markdown doc entries: ${duplicateDocs.join(", ")}`).toEqual([]);
    expect(
      escapingDocLinks,
      `docs/index.md contains markdown links that escape docs/: ${escapingDocLinks.join(", ")}`
    ).toEqual([]);
    expect(missingDocs, `docs/index.md is missing markdown docs: ${missingDocs.join(", ")}`).toEqual([]);
    expect(staleDocs, `docs/index.md references stale markdown docs: ${staleDocs.join(", ")}`).toEqual([]);
  });
});

describe("instruction probes fixture", () => {
  test("matches the reviewed frozen fixture bytes", () => {
    const { digest } = loadInstructionProbes();
    expect(digest).toBe(PROBES_SHA256);
  });

  test("enforces schema, target, and routing invariants", () => {
    const { bytes, fixture } = loadInstructionProbes();

    expect(bytes.length).toBeGreaterThan(0);
    expect(fixture.version).toBe(1);
    expect(fixture.frozen_at_base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.isArray(fixture.probes)).toBe(true);
    expect(typeof fixture.$comment).toBe("string");
    expect(fixture.$comment).toContain("FROZEN 2026-08-01");

    const ids = fixture.probes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+(?:-CONTROL)?$/.test(id))).toBe(true);

    const targets = fixture.probes.map((probe) => probe.target);
    expect(new Set(targets).size).toBe(targets.length);

    const control = fixture.probes.find((probe) => probe.id === CONTROL_PROBE_ID);
    expect(control).toEqual(CONTROL_PROBE);

    for (const probe of fixture.probes) {
      const absoluteTarget = path.join(REPO_ROOT, probe.target);
      expect(existsSync(absoluteTarget), `${probe.id} target is missing: ${probe.target}`).toBe(true);

      if (probe.id === CONTROL_PROBE_ID) {
        expect(probe.kind).toBe("control");
        expect(probe.target).toBe("AGENTS.md");
        continue;
      }

      expect(probe.kind).toBe("retrieval");
      expect(probe.target.startsWith("docs/"), `${probe.id} target must live under docs/: ${probe.target}`).toBe(true);

      const relativeToDocs = path.relative(DOCS_DIR, absoluteTarget);
      expect(
        relativeToDocs !== ".." && !relativeToDocs.startsWith(`..${path.sep}`),
        `${probe.id} target escapes docs/: ${probe.target}`,
      ).toBe(true);

      const prompt = probe.prompt.toLowerCase();
      const basename = path.basename(probe.target).toLowerCase();
      const basenameWithoutExtension = path.basename(probe.target, path.extname(probe.target)).toLowerCase();
      expect(prompt).not.toContain(probe.target.toLowerCase());
      expect(prompt).not.toContain(basename);
      expect(prompt).not.toContain(basenameWithoutExtension);
    }
  });
});
