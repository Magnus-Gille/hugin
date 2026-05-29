import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Templates live in <repo-root>/templates/. Resolved relative to this module
// so the path works from both src/ (dev/vitest) and dist/ (production build).
// Both locations are one level below the repo root, so ../templates is correct.
const TEMPLATES_DIR = fileURLToPath(new URL("../templates", import.meta.url));

const TEMPLATE_EXTENSION = ".pipeline.md";

/**
 * Returns the list of available template names (derived from files in the
 * templates/ directory, without their `.pipeline.md` extension), sorted
 * alphabetically.
 */
export function listPipelineTemplates(): string[] {
  const entries = fs.readdirSync(TEMPLATES_DIR);
  return entries
    .filter((entry) => entry.endsWith(TEMPLATE_EXTENSION))
    .map((entry) => entry.slice(0, -TEMPLATE_EXTENSION.length))
    .sort();
}

/**
 * Validates a template name: must be a simple alphanumeric slug with no path
 * separators or traversal sequences. Returns the resolved absolute path on
 * success, throws on invalid input.
 */
function resolveTemplatePath(name: string): string {
  if (!name || !/^[a-z0-9-]+$/i.test(name)) {
    throw new Error(
      `Unknown template "${name}". Available: ${listPipelineTemplates().join(", ")}`,
    );
  }
  const filename = `${name}${TEMPLATE_EXTENSION}`;
  const resolved = path.resolve(TEMPLATES_DIR, filename);
  // Confirm the resolved path is still inside TEMPLATES_DIR (belt-and-suspenders).
  if (!resolved.startsWith(path.resolve(TEMPLATES_DIR) + path.sep)) {
    throw new Error(
      `Unknown template "${name}". Available: ${listPipelineTemplates().join(", ")}`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Unknown template "${name}". Available: ${listPipelineTemplates().join(", ")}`,
    );
  }
  return resolved;
}

/**
 * Returns the raw template text for a named template.
 * Throws if the name is unknown or contains path traversal sequences.
 */
export function loadPipelineTemplate(name: string): string {
  const templatePath = resolveTemplatePath(name);
  return fs.readFileSync(templatePath, "utf-8");
}

/**
 * Returns the distinct placeholder names found in a template — the `var`
 * parts of every `${var}` token. Useful for callers building the vars object
 * before calling `instantiatePipelineTemplate`.
 */
export function requiredPlaceholders(name: string): string[] {
  const raw = loadPipelineTemplate(name);
  const matches = raw.matchAll(/\$\{([^}]+)\}/g);
  const seen = new Set<string>();
  for (const match of matches) {
    if (match[1]) seen.add(match[1]);
  }
  return [...seen];
}

/**
 * Instantiates a pipeline template by substituting every `${var}` token with
 * the corresponding value from `vars`. Throws a descriptive error if any
 * placeholder remains unsubstituted after applying all provided vars.
 *
 * Returns the final task document string, ready to pass to
 * `compilePipelineTask`.
 */
export function instantiatePipelineTemplate(
  name: string,
  vars: Record<string, string>,
): string {
  const raw = loadPipelineTemplate(name);

  // Replace all ${key} occurrences using the provided vars map.
  let result = raw.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? match : match;
  });

  // Detect any leftover placeholders.
  const remaining = [...result.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]).filter(Boolean);
  if (remaining.length > 0) {
    const unique = [...new Set(remaining)];
    throw new Error(
      `Template "${name}" has unsubstituted placeholder(s): ${unique.map((p) => `\${${p}}`).join(", ")}. ` +
        `Provide values for all required placeholders: ${requiredPlaceholders(name).map((p) => `\${${p}}`).join(", ")}.`,
    );
  }

  return result;
}
