import { describe, expect, it } from "vitest";
import { placeSettingsComponents } from "./settingsComponents";

const KEYS = ["jira.siteUrl", "jira.email", "jira.projectMap"];

interface Component {
  id: string;
  after?: string;
}

const c = (id: string, after?: string): Component => (after === undefined ? { id } : { id, after });

describe("placeSettingsComponents", () => {
  it("puts a component with no `after` at the bottom, as before placement existed", () => {
    const { anchored, trailing } = placeSettingsComponents([c("a")], KEYS);
    expect(anchored.size).toBe(0);
    expect(trailing.map((c) => c.id)).toEqual(["a"]);
  });

  it("anchors a component after the property it names", () => {
    const { anchored, trailing } = placeSettingsComponents([c("token", "jira.email")], KEYS);
    expect(anchored.get("jira.email")?.map((c) => c.id)).toEqual(["token"]);
    expect(trailing).toEqual([]);
  });

  it("falls back to the bottom when `after` names no declared property", () => {
    const { anchored, trailing } = placeSettingsComponents([c("x", "jira.gone")], KEYS);
    expect(anchored.size).toBe(0);
    expect(trailing.map((c) => c.id)).toEqual(["x"]);
  });

  it("keeps registration order for two components after the same property", () => {
    const { anchored } = placeSettingsComponents(
      [
        c("first", "jira.email"),
        c("second", "jira.email"),
      ],
      KEYS,
    );
    expect(anchored.get("jira.email")?.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("splits anchored and trailing components from one list", () => {
    const { anchored, trailing } = placeSettingsComponents(
      [
        c("token", "jira.email"),
        c("map", "jira.projectMap"),
        c("footer"),
      ],
      KEYS,
    );
    expect(anchored.get("jira.email")?.map((c) => c.id)).toEqual(["token"]);
    expect(anchored.get("jira.projectMap")?.map((c) => c.id)).toEqual(["map"]);
    expect(trailing.map((c) => c.id)).toEqual(["footer"]);
  });
});
