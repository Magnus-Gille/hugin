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

function collectIndexedMarkdownDocs(markdown: string): Set<string> {
  const links = markdown.matchAll(/\[[^\]]+\]\(([^)\s]+\.md(?:#[^)]+)?)\)/g);
  const indexedDocs = new Set<string>();

  for (const [, target] of links) {
    if (target.startsWith("http://") || target.startsWith("https://")) {
      continue;
    }
    const normalized = normalizeDocPath(target);
    if (normalized.startsWith("docs/")) {
      indexedDocs.add(normalized);
    }
  }

  return indexedDocs;
}

describe("docs/index.md coverage", () => {
  test("indexes every markdown doc under docs/ and avoids stale markdown links", () => {
    const markdown = readFileSync(INDEX_PATH, "utf8");
    const indexedDocs = collectIndexedMarkdownDocs(markdown);
    indexedDocs.delete("docs/index.md");

    const existingDocs = walkMarkdownFiles(DOCS_DIR)
      .map((absolutePath) => path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"))
      .filter((relativePath) => relativePath !== "docs/index.md")
      .sort();

    const missingDocs = existingDocs.filter((relativePath) => !indexedDocs.has(relativePath));
    const staleDocs = [...indexedDocs].filter((relativePath) => !existingDocs.includes(relativePath)).sort();

    expect(missingDocs, `docs/index.md is missing markdown docs: ${missingDocs.join(", ")}`).toEqual([]);
    expect(staleDocs, `docs/index.md references stale markdown docs: ${staleDocs.join(", ")}`).toEqual([]);
  });
});
