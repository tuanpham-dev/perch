// A subset of VS Code's `when` clause grammar: `!`, `&&`, `||`, parens, and
// `==`/`!=` string comparisons against a bare key. Parsed results are cached
// by trimmed expression text since evaluateWhen runs on the hot keydown path
// (every dispatch re-checks every bound command's when clause).

type Node =
  | { type: "not"; expr: Node }
  | { type: "and"; operands: Node[] }
  | { type: "or"; operands: Node[] }
  | { type: "eq"; key: string; value: string; negate: boolean }
  | { type: "key"; name: string };

type Token =
  | { type: "lparen" | "rparen" | "not" | "and" | "or" | "eq" | "neq" }
  | { type: "ident" | "string"; value: string };

const IDENT_CHAR = /[A-Za-z0-9_.\-]/;

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  const n = expr.length;
  let i = 0;
  while (i < n) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (c === "!") {
      if (expr[i + 1] === "=") {
        tokens.push({ type: "neq" });
        i += 2;
      } else {
        tokens.push({ type: "not" });
        i++;
      }
      continue;
    }
    if (c === "=" && expr[i + 1] === "=") {
      tokens.push({ type: "eq" });
      i += 2;
      continue;
    }
    if (c === "&" && expr[i + 1] === "&") {
      tokens.push({ type: "and" });
      i += 2;
      continue;
    }
    if (c === "|" && expr[i + 1] === "|") {
      tokens.push({ type: "or" });
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < n && expr[j] !== quote) {
        value += expr[j];
        j++;
      }
      if (j >= n) return null; // unterminated string literal
      tokens.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    if (IDENT_CHAR.test(c)) {
      let j = i;
      let value = "";
      while (j < n && IDENT_CHAR.test(expr[j])) {
        value += expr[j];
        j++;
      }
      tokens.push({ type: "ident", value });
      i = j;
      continue;
    }
    return null; // unrecognized character
  }
  return tokens;
}

// Recursive-descent parser, precedence low to high: || < && < ! < atom
// (bare key or == / != comparison). Any leftover/unconsumed tokens or a
// dead end mid-parse is a malformed expression, signaled by returning null.
function parseTokens(tokens: Token[]): Node | null {
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseOr(): Node | null {
    const first = parseAnd();
    if (!first) return null;
    const operands = [first];
    while (peek()?.type === "or") {
      consume();
      const next = parseAnd();
      if (!next) return null;
      operands.push(next);
    }
    return operands.length === 1 ? operands[0] : { type: "or", operands };
  }

  function parseAnd(): Node | null {
    const first = parseNot();
    if (!first) return null;
    const operands = [first];
    while (peek()?.type === "and") {
      consume();
      const next = parseNot();
      if (!next) return null;
      operands.push(next);
    }
    return operands.length === 1 ? operands[0] : { type: "and", operands };
  }

  function parseNot(): Node | null {
    if (peek()?.type === "not") {
      consume();
      const inner = parseNot();
      if (!inner) return null;
      return { type: "not", expr: inner };
    }
    return parseCmp();
  }

  function parseCmp(): Node | null {
    const left = parsePrimary();
    if (!left) return null;
    const t = peek();
    if (t?.type === "eq" || t?.type === "neq") {
      if (left.type !== "key") return null; // comparison LHS must be a bare key
      consume();
      const rhs = consume();
      if (!rhs || (rhs.type !== "ident" && rhs.type !== "string")) return null;
      return { type: "eq", key: left.name, value: rhs.value, negate: t.type === "neq" };
    }
    return left;
  }

  function parsePrimary(): Node | null {
    const t = peek();
    if (!t) return null;
    if (t.type === "lparen") {
      consume();
      const inner = parseOr();
      if (!inner) return null;
      if (peek()?.type !== "rparen") return null;
      consume();
      return inner;
    }
    if (t.type === "ident") {
      consume();
      return { type: "key", name: t.value };
    }
    return null;
  }

  const result = parseOr();
  if (!result || pos !== tokens.length) return null;
  return result;
}

const parseCache = new Map<string, Node | null>();

function getParsed(trimmed: string): Node | null {
  const cached = parseCache.get(trimmed);
  if (cached !== undefined) return cached;
  const tokens = tokenize(trimmed);
  const node = tokens ? parseTokens(tokens) : null;
  parseCache.set(trimmed, node);
  return node;
}

function evalNode(node: Node, get: (key: string) => unknown): boolean {
  switch (node.type) {
    case "not":
      return !evalNode(node.expr, get);
    case "and":
      return node.operands.every((o) => evalNode(o, get));
    case "or":
      return node.operands.some((o) => evalNode(o, get));
    case "eq": {
      const matches = String(get(node.key) ?? "") === node.value;
      return node.negate ? !matches : matches;
    }
    case "key":
      return Boolean(get(node.name));
  }
}

// No when clause (empty string) means unconditional — true. A non-empty
// string that fails to parse is malformed and evaluates false, matching VS
// Code's own behavior for an invalid when expression.
export function evaluateWhen(expr: string, get: (key: string) => unknown): boolean {
  const trimmed = expr.trim();
  if (trimmed === "") return true;
  const node = getParsed(trimmed);
  if (!node) return false;
  return evalNode(node, get);
}

// Same-type (&&/||) chains associate, so flatten nested same-type nodes
// (e.g. a parenthesized sub-expression) before sorting operands — otherwise
// `(a&&b)&&c` and `a&&(b&&c)` would normalize to different strings despite
// being the same condition.
function flattenSameType(type: "and" | "or", node: Node): Node[] {
  if (node.type === type) return node.operands.flatMap((o) => flattenSameType(type, o));
  return [node];
}

interface Serialized {
  str: string;
  prec: number;
}

function serialize(node: Node): Serialized {
  switch (node.type) {
    case "key":
      return { str: node.name, prec: 4 };
    case "eq":
      return { str: `${node.key}${node.negate ? "!=" : "=="}${node.value}`, prec: 4 };
    case "not": {
      const inner = serialize(node.expr);
      return { str: inner.prec < 3 ? `!(${inner.str})` : `!${inner.str}`, prec: 3 };
    }
    case "and": {
      const parts = flattenSameType("and", node)
        .map(serialize)
        .map((s) => (s.prec < 2 ? `(${s.str})` : s.str))
        .sort();
      return { str: parts.join("&&"), prec: 2 };
    }
    case "or": {
      const parts = flattenSameType("or", node)
        .map((o) => serialize(o).str)
        .sort();
      return { str: parts.join("||"), prec: 1 };
    }
  }
}

// Canonical form for conflict detection: commutative &&/|| operand lists are
// sorted so `a && b` and `b && a` normalize identically. A malformed
// expression normalizes to its own trimmed text (still comparable for exact
// duplicates, just not aware of logical equivalence).
export function normalizeWhen(expr: string): string {
  const trimmed = expr.trim();
  if (trimmed === "") return "";
  const node = getParsed(trimmed);
  return node ? serialize(node).str : trimmed;
}

// For the Keyboard Shortcuts editor's when-clause input: empty is valid (no
// condition); a non-empty expression is valid only if it actually parses —
// this is the same "malformed → false" boundary evaluateWhen enforces, just
// surfaced as a yes/no for error-styling an input rather than a runtime
// dispatch decision.
export function isValidWhen(expr: string): boolean {
  const trimmed = expr.trim();
  return trimmed === "" || getParsed(trimmed) !== null;
}
