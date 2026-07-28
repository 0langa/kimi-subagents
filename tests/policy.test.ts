import path from "node:path";

import { describe, expect, it } from "vitest";

import { decideTool, selectPermission } from "../src/policy.js";

const root = path.resolve("C:/fixture/workspace");

describe("permission policy", () => {
  it("denies command execution in analyze jobs", () => {
    expect(decideTool("analyze", { toolCallId: "1", kind: "execute", title: "Run tests", rawInput: { command: "npm test" } }, [root], false)).toMatchObject({ allow: false });
  });

  it("allows ordinary execute work", () => {
    expect(decideTool("execute", { toolCallId: "1", kind: "execute", title: "Run tests", rawInput: { command: "npm test" } }, [root], false)).toMatchObject({ allow: true });
  });

  it.each([
    ["delete", "Remove-Item fixture.txt"],
    ["execute", "git reset --hard HEAD"],
    ["execute", "git push origin main"],
    ["execute", "gh pr create --title test"],
    ["execute", "gh auth token"]
  ] as const)("blocks protected %s operation", (kind, command) => {
    expect(decideTool("execute", { toolCallId: "1", kind, title: command, rawInput: { command } }, [root], false).allow).toBe(false);
  });

  it("blocks paths outside granted roots", () => {
    expect(decideTool("execute", { toolCallId: "1", kind: "edit", title: "Edit", rawInput: { path: "C:/outside/file.txt" } }, [root], false)).toMatchObject({ allow: false, reason: "Workspace escape blocked" });
  });

  it("blocks unverifiable relative mutation paths", () => {
    expect(decideTool("execute", { toolCallId: "1", kind: "edit", title: "Edit", rawInput: { path: "fixture.txt" } }, [root], false))
      .toMatchObject({ allow: false, reason: "Mutating file operations require absolute paths inside granted roots" });
  });

  it("blocks shell writes outside roots and unverifiable relative shell writes", () => {
    expect(decideTool("execute", {
      toolCallId: "1", kind: "execute", title: "Set content",
      rawInput: { command: "Set-Content -LiteralPath 'C:\\\\outside\\\\file.txt' -Value changed" }
    }, [root], false)).toMatchObject({ allow: false, reason: "Workspace escape blocked" });
    expect(decideTool("execute", {
      toolCallId: "2", kind: "execute", title: "Set content",
      rawInput: { command: "Set-Content -LiteralPath .\\file.txt -Value changed" }
    }, [root], false)).toMatchObject({ allow: false, reason: "Shell file writes require an absolute path inside granted roots" });
  });

  it("allows local commits only when explicitly delegated", () => {
    const call = { toolCallId: "1", kind: "execute" as const, title: "git commit -m test", rawInput: { command: "git commit -m test" } };
    expect(decideTool("execute", call, [root], false).allow).toBe(false);
    expect(decideTool("execute", call, [root], true).allow).toBe(true);
  });

  it("selects one-shot options", () => {
    const request = { sessionId: "s", toolCall: { toolCallId: "1" }, options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" as const },
      { optionId: "no", name: "Reject", kind: "reject_once" as const }
    ] };
    expect(selectPermission(request, true)).toEqual({ outcome: "selected", optionId: "yes" });
    expect(selectPermission(request, false)).toEqual({ outcome: "selected", optionId: "no" });
  });
});
