import { describe, expect, it } from "vitest";
import { evaluateWhen, isValidWhen, normalizeWhen } from "./whenClause";

function ctx(values: Record<string, unknown>) {
  return (key: string) => values[key];
}

describe("evaluateWhen", () => {
  it("treats an empty expression as unconditional", () => {
    expect(evaluateWhen("", ctx({}))).toBe(true);
    expect(evaluateWhen("   ", ctx({}))).toBe(true);
  });

  it("evaluates a bare key as truthiness", () => {
    expect(evaluateWhen("terminalFocus", ctx({ terminalFocus: true }))).toBe(true);
    expect(evaluateWhen("terminalFocus", ctx({ terminalFocus: false }))).toBe(false);
    expect(evaluateWhen("terminalFocus", ctx({}))).toBe(false);
  });

  it("negates with !", () => {
    expect(evaluateWhen("!terminalFocus", ctx({ terminalFocus: false }))).toBe(true);
    expect(evaluateWhen("!terminalFocus", ctx({ terminalFocus: true }))).toBe(false);
  });

  it("evaluates == and !=", () => {
    expect(evaluateWhen("resourceLangId == typescript", ctx({ resourceLangId: "typescript" }))).toBe(true);
    expect(evaluateWhen("resourceLangId == typescript", ctx({ resourceLangId: "javascript" }))).toBe(false);
    expect(evaluateWhen("resourceLangId != typescript", ctx({ resourceLangId: "javascript" }))).toBe(true);
  });

  it("evaluates quoted string literals same as bare words", () => {
    expect(evaluateWhen("resourceLangId == 'typescript'", ctx({ resourceLangId: "typescript" }))).toBe(true);
    expect(evaluateWhen('resourceLangId == "typescript"', ctx({ resourceLangId: "typescript" }))).toBe(true);
  });

  it("applies && precedence over ||", () => {
    // a || (b && c), not (a || b) && c
    expect(evaluateWhen("a || b && c", ctx({ a: true, b: false, c: false }))).toBe(true);
    expect(evaluateWhen("a || b && c", ctx({ a: false, b: true, c: false }))).toBe(false);
  });

  it("respects explicit parentheses", () => {
    expect(evaluateWhen("(a || b) && c", ctx({ a: true, b: false, c: false }))).toBe(false);
    expect(evaluateWhen("(a || b) && c", ctx({ a: true, b: false, c: true }))).toBe(true);
  });

  it("unknown keys are falsy, not errors", () => {
    expect(evaluateWhen("neverSetKey", ctx({}))).toBe(false);
    expect(evaluateWhen("!neverSetKey", ctx({}))).toBe(true);
  });

  it("treats malformed expressions as false", () => {
    expect(evaluateWhen("a &&", ctx({ a: true }))).toBe(false);
    expect(evaluateWhen("(a || b", ctx({ a: true }))).toBe(false);
    expect(evaluateWhen("a == ", ctx({ a: true }))).toBe(false);
    expect(evaluateWhen("a $ b", ctx({ a: true, b: true }))).toBe(false);
    expect(evaluateWhen("'unterminated", ctx({}))).toBe(false);
  });
});

describe("normalizeWhen", () => {
  it("returns the empty string for an empty expression", () => {
    expect(normalizeWhen("")).toBe("");
    expect(normalizeWhen("   ")).toBe("");
  });

  it("sorts commutative && operands into the same canonical form", () => {
    expect(normalizeWhen("b && a")).toBe(normalizeWhen("a && b"));
  });

  it("sorts commutative || operands into the same canonical form", () => {
    expect(normalizeWhen("b || a")).toBe(normalizeWhen("a || b"));
  });

  it("flattens associative chains regardless of parenthesization", () => {
    expect(normalizeWhen("(a && b) && c")).toBe(normalizeWhen("a && (b && c)"));
    expect(normalizeWhen("c && a && b")).toBe(normalizeWhen("a && b && c"));
  });

  it("keeps && grouping distinct from || grouping (not associative across operators)", () => {
    expect(normalizeWhen("a && (b || c)")).not.toBe(normalizeWhen("(a && b) || c"));
  });

  it("normalizes != the same way regardless of operand order text", () => {
    expect(normalizeWhen("a != b && c != d")).toBe(normalizeWhen("c != d && a != b"));
  });

  it("passes through malformed input as its own trimmed text", () => {
    expect(normalizeWhen("  a &&  ")).toBe("a &&");
  });
});

describe("isValidWhen", () => {
  it("treats an empty expression as valid", () => {
    expect(isValidWhen("")).toBe(true);
    expect(isValidWhen("   ")).toBe(true);
  });

  it("accepts well-formed expressions", () => {
    expect(isValidWhen("terminalFocus")).toBe(true);
    expect(isValidWhen("a && (b || !c)")).toBe(true);
    expect(isValidWhen("resourceLangId == typescript")).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(isValidWhen("a &&")).toBe(false);
    expect(isValidWhen("(a || b")).toBe(false);
    expect(isValidWhen("a $ b")).toBe(false);
  });
});
