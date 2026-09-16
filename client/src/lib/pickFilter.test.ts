import { describe, expect, it } from "vitest";
import { filterPickItems, type PickItem } from "./pickFilter";

const items: PickItem[] = [
  { id: "account", label: "account", keywords: ["person", "user", "user"] },
  { id: "github", label: "github", keywords: ["git", "octocat"] },
  { id: "git-commit", label: "git-commit", keywords: ["commit"] },
  { id: "t-1", label: "Review" },
];

describe("filterPickItems", () => {
  it("returns every item for an empty or blank query", () => {
    expect(filterPickItems(items, "")).toEqual(items);
    expect(filterPickItems(items, "   ")).toEqual(items);
  });

  it("matches a keyword the row never shows", () => {
    expect(filterPickItems(items, "person").map((i) => i.id)).toEqual(["account"]);
  });

  it("matches labels case-insensitively, and ids", () => {
    expect(filterPickItems(items, "REVIEW").map((i) => i.id)).toEqual(["t-1"]);
    expect(filterPickItems(items, "t-1").map((i) => i.id)).toEqual(["t-1"]);
  });

  it("puts label-prefix matches ahead of other matches", () => {
    expect(filterPickItems(items, "git").map((i) => i.id)).toEqual(["github", "git-commit"]);
    expect(filterPickItems(items, "commit").map((i) => i.id)).toEqual(["git-commit"]);
    expect(filterPickItems(items, "hub").map((i) => i.id)).toEqual(["github"]);
  });
});
