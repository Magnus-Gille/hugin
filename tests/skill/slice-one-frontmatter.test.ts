import { describe, it, expect } from "vitest";
import {
  normalizeFrontmatter,
  gradeFrontmatter,
} from "../../src/skill/slice-one/frontmatter-normalize.js";

describe("normalizeFrontmatter (#84 slice-one deterministic procedure)", () => {
  it("sorts keys ascending and uses canonical spacing (numbers quoted to stay strings)", () => {
    const r = normalizeFrontmatter({ document: "---\nb: 2\na: 1\n---\nbody\n" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document).toBe('---\na: "1"\nb: "2"\n---\nbody\n');
  });

  it("quotes numeric-looking and ambiguous scalars, leaves plain strings bare", () => {
    const r = normalizeFrontmatter({
      document: "---\nflag: true\nname: Hello World\nport: 8080\n---\n",
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.document).toBe(
        '---\nflag: "true"\nname: Hello World\nport: "8080"\n---\n',
      );
  });

  it("renders inline and block lists as canonical block lists, preserving order", () => {
    const r = normalizeFrontmatter({
      document: "---\ntags:  [x, y]\ntitle:Hello\n---\n# Body\n",
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.document).toBe(
        "---\ntags:\n  - x\n  - y\ntitle: Hello\n---\n# Body\n",
      );
  });

  it("preserves the body after the closing fence byte-for-byte", () => {
    const body = "\n## Section\n\nSome *markdown* with `code`.\n\n- a\n- b\n";
    const r = normalizeFrontmatter({ document: `---\nz: 1\n---${body}` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document.endsWith(body)).toBe(true);
  });

  it("is idempotent: normalizing an already-canonical document is a no-op", () => {
    const canonical = '---\na: "1"\nb: "2"\n---\nbody\n';
    const r = normalizeFrontmatter({ document: canonical });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document).toBe(canonical);
  });

  it("normalizes CRLF input to canonical LF", () => {
    const r = normalizeFrontmatter({ document: "---\r\nb: 2\r\na: 1\r\n---\r\nbody\r\n" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document.startsWith('---\na: "1"\nb: "2"\n---')).toBe(true);
  });

  it("abstains (ok:false) on a document with no frontmatter", () => {
    const r = normalizeFrontmatter({ document: "# Heading\n\nNo frontmatter.\n" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-frontmatter");
  });

  it("abstains on an unterminated frontmatter block", () => {
    const r = normalizeFrontmatter({ document: "---\na: 1\nb: 2\n" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unterminated-frontmatter");
  });

  it("abstains on nested maps (outside the supported subset)", () => {
    const r = normalizeFrontmatter({ document: "---\nnested:\n  a: 1\n---\n" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported-frontmatter");
  });
});

describe("gradeFrontmatter (deterministic exact-match oracle)", () => {
  it("passes when output document equals expected string", () => {
    const out = normalizeFrontmatter({ document: "---\nb: 2\na: 1\n---\nbody\n" });
    expect(gradeFrontmatter(out, '---\na: "1"\nb: "2"\n---\nbody\n').pass).toBe(true);
  });

  it("fails when the output differs by a single byte", () => {
    const out = normalizeFrontmatter({ document: "---\nb: 2\na: 1\n---\nbody\n" });
    expect(gradeFrontmatter(out, '---\na: "1"\nb: "2"\n---\nBODY\n').pass).toBe(false);
  });

  it("passes an abstain fixture when the normalizer abstains for the same reason", () => {
    const out = normalizeFrontmatter({ document: "no frontmatter" });
    expect(
      gradeFrontmatter(out, { abstain: true, reason: "no-frontmatter" }).pass,
    ).toBe(true);
  });

  it("fails an abstain fixture when the normalizer instead produced output", () => {
    const out = normalizeFrontmatter({ document: "---\na: 1\n---\n" });
    expect(gradeFrontmatter(out, { abstain: true, reason: "no-frontmatter" }).pass).toBe(
      false,
    );
  });
});
