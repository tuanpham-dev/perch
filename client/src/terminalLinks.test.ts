import { describe, expect, it } from "vitest";
import { findCandidates, joinWrappedPath } from "./terminalLinks";

const paths = (text: string) =>
  findCandidates(text)
    .filter((c) => c.kind === "path")
    .map((c) => ({ target: c.target, line: c.line, text: c.text }));

describe("findCandidates: known extensionless names", () => {
  it("matches a bare known name", () => {
    expect(paths("cat LICENSE")).toEqual([{ target: "LICENSE", line: undefined, text: "LICENSE" }]);
  });

  it("matches a dotfile with a :line suffix", () => {
    expect(paths("error in .gitignore:3")).toEqual([{ target: ".gitignore", line: 3, text: ".gitignore:3" }]);
  });

  it("keeps a known name at the end of a sentence", () => {
    expect(paths("see Makefile.").map((p) => p.target)).toEqual(["Makefile"]);
  });

  it("rejects a known name that is only a prefix", () => {
    expect(paths("Makefile.bak README-old .envrc LICENSES")).toEqual([
      { target: "Makefile.bak", line: undefined, text: "Makefile.bak" },
    ]);
  });

  it("yields one candidate for a known name after a slash", () => {
    expect(paths("docker/Dockerfile").map((p) => p.target)).toEqual(["docker/Dockerfile"]);
  });

  it("yields one candidate for a prefixed dotfile", () => {
    expect(paths("~/.zshrc").map((p) => p.target)).toEqual(["~/.zshrc"]);
  });

  it("ignores ordinary words", () => {
    expect(paths("build notes readme license")).toEqual([]);
  });
});

describe("findCandidates: existing forms", () => {
  it.each([
    ["/abs/x.ts", "/abs/x.ts"],
    ["~/a", "~/a"],
    ["./b", "./b"],
    ["../c", "../c"],
    ["README.md", "README.md"],
    ["plans/abc.md", "plans/abc.md"],
  ])("matches %s", (text, target) => {
    expect(paths(text).map((p) => p.target)).toEqual([target]);
  });

  it("parses :line:col", () => {
    expect(paths("src/app.ts:12:4")).toEqual([{ target: "src/app.ts", line: 12, text: "src/app.ts:12:4" }]);
  });

  it("finds a path inside backticks", () => {
    expect(paths("saved to `plans/abc.md`. Proceed?").map((p) => p.target)).toEqual(["plans/abc.md"]);
  });

  it("reads a number as no candidate", () => {
    expect(paths("pi is 3.14")).toEqual([]);
  });

  it("detects URLs as url kind", () => {
    const urls = findCandidates("open https://x.y/z now").filter((c) => c.kind === "url");
    expect(urls.map((c) => c.target)).toEqual(["https://x.y/z"]);
  });
});

describe("findCandidates: Windows paths", () => {
  it("matches a drive path with a line number", () => {
    expect(paths("error in C:\\Users\\me\\src\\app.ts:12")).toEqual([
      { target: "C:\\Users\\me\\src\\app.ts", line: 12, text: "C:\\Users\\me\\src\\app.ts:12" },
    ]);
  });

  it("matches a forward-slash drive path and a dot-backslash path", () => {
    expect(paths("see D:/work/notes.md").map((p) => p.target)).toEqual(["D:/work/notes.md"]);
    expect(paths("at .\\src\\index.ts").map((p) => p.target)).toEqual([".\\src\\index.ts"]);
  });

  it("does not read a URL's scheme as a drive", () => {
    expect(paths("open https://x.y/z now").filter((p) => /^[A-Za-z]:/.test(p.target))).toEqual([]);
  });
});

describe("joinWrappedPath: a path a program broke across rows", () => {
  // Real rows from a 48-column phone pane: Claude Code wrapped its own echo
  // of the prompt mid-path, which left both halves unlinkable.
  const cols = 48;
  const head = "  else: extensions/markdown-preview/src/client.";
  const cont = "  tsx:209";

  it("rejoins the halves, suffix and all", () => {
    expect(joinWrappedPath(head.padEnd(cols), cont.padEnd(cols), cols)).toEqual({
      target: "extensions/markdown-preview/src/client.tsx",
      line: 209,
      headStart: 8,
      contStart: 2,
      contLength: 7,
    });
  });

  it("does not need the row padded out", () => {
    expect(joinWrappedPath(head, cont, cols)?.target).toBe("extensions/markdown-preview/src/client.tsx");
  });

  it("leaves a row that had room to spare alone", () => {
    expect(joinWrappedPath("  else: extensions/markdown/client.", cont, cols)).toBeNull();
  });

  it("refuses when the halves don't read as one path", () => {
    expect(joinWrappedPath("run the tests and then report back to me".padEnd(cols), "  again later", cols)).toBeNull();
  });

  it("still joins a row that only looks full, and leaves the arbitrating to the resolver", () => {
    // Two rows that were never one path can still pass the shape test: here
    // "src/app.ts" was simply the last thing that fit. The joiner can't tell
    // and doesn't try - callers ask about the unjoined path first, and a
    // "src/app.tsand" that exists nowhere is dropped by the existence check.
    expect(joinWrappedPath("open src/app.ts".padEnd(15), "  and read it", 15)?.target).toBe("src/app.tsand");
  });

  it("refuses an empty row on either side", () => {
    expect(joinWrappedPath("".padEnd(cols), cont, cols)).toBeNull();
    expect(joinWrappedPath(head, "".padEnd(cols), cols)).toBeNull();
  });

  it("rejoins a path broken right after a slash", () => {
    const j = joinWrappedPath("see client/src/components/Terminal".padEnd(34), "View.tsx now", 34);
    expect(j?.target).toBe("client/src/components/TerminalView.tsx");
    expect(j?.contLength).toBe(8);
  });
});
