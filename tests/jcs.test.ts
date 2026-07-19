import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../src/jcs.js";

describe("canonicalizeJcs", () => {
  it("matches the RFC 8785 section 3.2.2 sample", () => {
    expect(canonicalizeJcs({
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    })).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
  });

  it("uses RFC 8785 UTF-16 property ordering independent of insertion order", () => {
    const value = {
      "\ue000": 1,
      "😀": 2,
      "€": 3,
      "1": 4,
      "\r": 5,
    };

    expect(canonicalizeJcs(value)).toBe(
      "{\"\\r\":5,\"1\":4,\"€\":3,\"😀\":2,\"\":1}",
    );
    expect(canonicalizeJcs({ b: { y: 2, x: 1 }, a: true })).toBe(
      "{\"a\":true,\"b\":{\"x\":1,\"y\":2}}",
    );
  });

  it("uses ECMAScript number serialization and rejects non-I-JSON values", () => {
    expect(canonicalizeJcs([-0, 1e30, 0.002, 1e-27])).toBe(
      "[0,1e+30,0.002,1e-27]",
    );
    expect(() => canonicalizeJcs(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalizeJcs("\ud800")).toThrow("lone high surrogate");
    expect(() => canonicalizeJcs([undefined])).toThrow("undefined array");
  });
});
