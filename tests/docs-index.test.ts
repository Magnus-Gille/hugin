import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const REPO_ROOT = process.cwd();
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const INDEX_PATH = path.join(DOCS_DIR, "index.md");

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

function isNonLocalMarkdownLink(linkTarget: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(linkTarget) || linkTarget.startsWith("//");
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
  const links = markdown.matchAll(/\[[^\]]+\]\(([^)\s]+\.md(?:#[^)]+)?)\)/g);
  const docCounts = new Map<string, number>();
  const escapingDocLinks: string[] = [];
  const indexedDocs = new Set<string>();

  for (const [, target] of links) {
    if (isNonLocalMarkdownLink(target)) {
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

describe("docs/index.md coverage", () => {
  test("tracks duplicate indexed markdown docs instead of collapsing them", () => {
    const markdown = [
      "- [Daily exams](daily-exam-factory.md)",
      "- [Daily exams again](daily-exam-factory.md#quarantine-lanes)",
    ].join("\n");

    expect(collectIndexedMarkdownDocs(markdown)).toEqual({
      duplicateDocs: ["docs/daily-exam-factory.md"],
      escapingDocLinks: [],
      indexedDocs: new Set(["docs/daily-exam-factory.md"]),
    });
  });

  test("rejects markdown links that try to escape docs/", () => {
    const markdown = [
      "- [Lexical escape](../README.md)",
      "- [Encoded escape](subdir/%2e%2e/%2e%2e/README.md)",
      "- [External markdown](https://example.com/reference.md)",
      "- [Heading](#security-trust-and-provenance)",
      "- [PNG asset](images/overview.png)",
    ].join("\n");

    expect(collectIndexedMarkdownDocs(markdown)).toEqual({
      duplicateDocs: [],
      escapingDocLinks: ["../README.md", "subdir/%2e%2e/%2e%2e/README.md"],
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
