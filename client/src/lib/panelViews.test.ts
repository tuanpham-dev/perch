import { describe, expect, it } from "vitest";
import {
  OUTPUT_VIEW_ID,
  TERMINAL_VIEW_ID,
  orderPanelViews,
  resolveActiveView,
  type PanelViewDescriptor,
} from "./panelViews";

const view = (id: string, order = 0): PanelViewDescriptor => ({ id, title: id, icon: "layout-panel", order });

describe("orderPanelViews", () => {
  it("puts TERMINAL first, OUTPUT second, then extension views by order and id", () => {
    const ids = orderPanelViews([view("ext.b.two", 5), view("ext.a.one", 5), view("ext.c.zero", 1)]).map(
      (v) => v.id,
    );
    expect(ids).toEqual([TERMINAL_VIEW_ID, OUTPUT_VIEW_ID, "ext.c.zero", "ext.a.one", "ext.b.two"]);
  });

  it("leaves OUTPUT out when asked", () => {
    expect(orderPanelViews([view("ext.a.one")], false).map((v) => v.id)).toEqual([TERMINAL_VIEW_ID, "ext.a.one"]);
  });

  it("does not mutate the input", () => {
    const input = [view("ext.b", 2), view("ext.a", 1)];
    orderPanelViews(input);
    expect(input.map((v) => v.id)).toEqual(["ext.b", "ext.a"]);
  });
});

describe("resolveActiveView", () => {
  const views = orderPanelViews([view("ext.a.one")]);

  it("keeps a stored id that still names a view", () => {
    expect(resolveActiveView("ext.a.one", views)).toBe("ext.a.one");
    expect(resolveActiveView(OUTPUT_VIEW_ID, views)).toBe(OUTPUT_VIEW_ID);
    expect(resolveActiveView(TERMINAL_VIEW_ID, views)).toBe(TERMINAL_VIEW_ID);
  });

  it("falls back to TERMINAL for an unknown, missing or malformed id", () => {
    expect(resolveActiveView("ext.gone.view", views)).toBe(TERMINAL_VIEW_ID);
    expect(resolveActiveView(null, views)).toBe(TERMINAL_VIEW_ID);
    expect(resolveActiveView(undefined, views)).toBe(TERMINAL_VIEW_ID);
  });
});
