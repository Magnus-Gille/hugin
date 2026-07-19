import { describe, expect, it } from "vitest";
import {
  applyCodeLoopPromptPrefix,
  codeLoopPromptSha256,
} from "../src/learning/m5-code-loop-prompt.js";

describe("M5 code-loop prompt contract", () => {
  it("preserves the deployed passthrough prompt fingerprint and instruction bytes", () => {
    expect(codeLoopPromptSha256(undefined)).toBe(
      "0b90fa0628704c2d775c2d805444d56be7e0afdba34250d26160f8c12b1f02c3",
    );
    expect(applyCodeLoopPromptPrefix("fix the bug\n", undefined)).toBe("fix the bug\n");
  });

  it("prepends the declared policy without normalizing either input", () => {
    expect(applyCodeLoopPromptPrefix("instruction\n", "policy\n")).toBe(
      "policy\n\n\ninstruction\n",
    );
  });

  it("binds every prefix byte and domain-separates it from passthrough", () => {
    expect(codeLoopPromptSha256("policy")).not.toBe(codeLoopPromptSha256("policy\n"));
    expect(codeLoopPromptSha256("")).not.toBe(codeLoopPromptSha256(undefined));
  });
});
