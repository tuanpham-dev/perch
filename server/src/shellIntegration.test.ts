import { describe, expect, it } from "vitest";
import { powershellScriptBody } from "./shellIntegration.js";

describe("PowerShell integration script", () => {
  it("reports to the right port and names its own source line", async () => {
    const body = await powershellScriptBody(3002);
    expect(body).toContain("http://127.0.0.1:3002/api/command-events/report");
    expect(body).not.toContain("__PORT__");
    expect(body).not.toContain("__SOURCE_LINE__");
    expect(body).toMatch(/# {3}if \(Test-Path '.*shell-integration\.ps1'\) \{ \. '.*shell-integration\.ps1' \}/);
  });

  it("does nothing outside the app's terminals", async () => {
    const body = await powershellScriptBody(3001);
    expect(body).toMatch(/if \(-not \$env:PERCH_WINDOW/);
  });
});
