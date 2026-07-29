import path from "node:path";

import { describe, expect, it } from "vitest";

import { decidePermission, extractAction, selectPermission, type PolicyInput } from "../src/policy.js";
import fixtures from "./fixtures/acp-permission-payloads.json" with { type: "json" };

const workspace = path.resolve("C:/fixture/workspace");
const payloads = fixtures.payloads as Record<string, { title: string; content: unknown }>;

function decide(name: keyof typeof payloads, overrides: Partial<PolicyInput> = {}) {
  const payload = payloads[name]!;
  return decidePermission({
    jobType: "execute",
    toolName: payload.title,
    kind: undefined,
    content: payload.content,
    roots: [workspace],
    readOnlyRoots: [],
    allowInterpreters: [],
    workspace,
    allowCommit: false,
    allowDelete: false,
    ...overrides
  });
}

function bash(command: string, overrides: Partial<PolicyInput> = {}) {
  return decidePermission({
    jobType: "execute",
    toolName: "Bash",
    kind: "execute",
    content: [{ type: "content", content: { type: "text", text: `Requesting approval to Running: ${command}` } }],
    roots: [workspace],
    readOnlyRoots: [],
    allowInterpreters: [],
    workspace,
    allowCommit: false,
    allowDelete: false,
    ...overrides
  });
}

describe("permission payload extraction", () => {
  it("reads the command out of a real Bash approval payload", () => {
    expect(extractAction(payloads.bashShort!.content).command).toBe("cd .. && printf hi > chained.txt");
  });

  it("reads the target path out of a real Write approval payload", () => {
    expect(extractAction(payloads.writeRelative!.content).targetPath).toBe("sub/dir/note.txt");
  });

  it("reads diff paths out of a real Edit approval payload", () => {
    expect(extractAction(payloads.editAbsolute!.content).diffPaths).toEqual(["C:/fixture/workspace/probe-write.txt"]);
  });

  it("flags Kimi's 50 character command truncation", () => {
    const extracted = extractAction(payloads.bashTruncated!.content);
    expect(extracted.truncated).toBe(true);
    expect(extracted.command).toBe("npm run build && node scripts/relea");
  });

  it("returns nothing usable for an unknown payload shape", () => {
    expect(extractAction(payloads.unknownShape!.content)).toMatchObject({ action: undefined, diffPaths: [] });
  });
});

describe("execute job decisions", () => {
  it("allows ordinary development commands", () => {
    expect(bash("npm test").allow).toBe(true);
    expect(bash("git status --porcelain").allow).toBe(true);
  });

  it.each([
    ["rm -rf build", "deletion"],
    ["git clean -fd", "destructive-git"],
    ["git reset --hard HEAD~1", "destructive-git"],
    ["git push origin main", "remote-mutation"],
    ["gh pr create --title x", "remote-mutation"],
    ["npm publish --access public", "remote-mutation"],
    ["git config --global user.email evil@example.com", "global-config"],
    ["powershell -Command ls", "interpreter-escape"],
    ["cat ~/.ssh/id_rsa", "credential"],
    ["printenv | grep TOKEN", "credential"]
  ])("blocks %s", (command, rule) => {
    const decision = bash(command);
    expect(decision.allow).toBe(false);
    expect(decision.rule).toBe(rule);
  });

  it("blocks shell paths outside granted roots", () => {
    expect(bash('printf x > "C:/elsewhere/file.txt"')).toMatchObject({ allow: false, rule: "workspace-escape" });
    expect(bash("cat /c/elsewhere/file.txt")).toMatchObject({ allow: false, rule: "workspace-escape" });
  });

  it("gates commits and deletions behind explicit delegation", () => {
    expect(bash("git commit -m wip").allow).toBe(false);
    expect(bash("git commit -m wip", { allowCommit: true }).allow).toBe(true);
    expect(bash("rm obsolete.txt").allow).toBe(false);
    expect(bash("rm obsolete.txt", { allowDelete: true }).allow).toBe(true);
  });

  it("resolves relative Write targets against the workspace", () => {
    expect(decide("writeRelative")).toMatchObject({ allow: true, rule: "edit-allow" });
  });

  it("allows edits inside the roots and blocks edits outside", () => {
    expect(decide("editAbsolute").allow).toBe(true);
    expect(decide("editOutsideRoot")).toMatchObject({ allow: false, rule: "workspace-escape" });
  });

  it("refuses MCP tool calls", () => {
    expect(decide("mcpCall")).toMatchObject({ allow: false, rule: "mcp-blocked" });
  });

  it("fails closed on unparseable payloads", () => {
    expect(decide("unknownShape")).toMatchObject({ allow: false, rule: "fail-closed" });
    expect(decidePermission({
      jobType: "execute", toolName: "Bash", kind: "execute", content: [], roots: [workspace], workspace,
      readOnlyRoots: [], allowInterpreters: [], allowCommit: false, allowDelete: false
    })).toMatchObject({ allow: false, rule: "fail-closed" });
  });

  it("still blocks a destructive command that survives truncation", () => {
    expect(bash("git push --force origin main # padded".padEnd(60, "x"))).toMatchObject({ allow: false, rule: "remote-mutation" });
  });
});

describe("read-only job decisions", () => {
  it("denies commands and edits in analyze jobs", () => {
    expect(bash("npm test", { jobType: "analyze" })).toMatchObject({ allow: false, rule: "read-only-job" });
    expect(decide("writeRelative", { jobType: "analyze" })).toMatchObject({ allow: false, rule: "read-only-job" });
  });

  it("denies file mutation in plan jobs", () => {
    expect(decide("editAbsolute", { jobType: "plan" })).toMatchObject({ allow: false, rule: "read-only-job" });
  });

  it("denies unknown tools in read-only jobs", () => {
    expect(decide("unknownShape", { jobType: "plan" })).toMatchObject({ allow: false, rule: "fail-closed" });
  });
});

describe("permission option selection", () => {
  const request = {
    sessionId: "s",
    toolCall: { toolCallId: "1" },
    options: [
      { optionId: "approve_once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "approve_always", name: "Allow always", kind: "allow_always" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const }
    ]
  };

  it("never grants session-wide approval", () => {
    expect(selectPermission(request, true)).toEqual({ outcome: "selected", optionId: "approve_once" });
  });

  it("selects rejection when denied", () => {
    expect(selectPermission(request, false)).toEqual({ outcome: "selected", optionId: "reject" });
  });

  it("cancels when no usable option exists", () => {
    expect(selectPermission({ ...request, options: [] }, true)).toEqual({ outcome: "cancelled" });
  });
});

describe("turn control and interactive tools", () => {
  it("allows a plan job to deliver its plan", () => {
    for (const jobType of ["plan", "analyze", "execute"] as const) {
      expect(decidePermission({
        jobType, toolName: "ExitPlanMode", kind: "other", content: [], roots: [workspace],
        readOnlyRoots: [], allowInterpreters: [], workspace, allowCommit: false, allowDelete: false
      }), jobType).toMatchObject({ allow: true, rule: "turn-control" });
    }
  });

  it("refuses interactive questions with a distinct rule", () => {
    expect(decidePermission({
      jobType: "plan", toolName: "AskUserQuestion", kind: "other", content: [], roots: [workspace],
      readOnlyRoots: [], allowInterpreters: [], workspace, allowCommit: false, allowDelete: false
    })).toMatchObject({ allow: false, rule: "no-interactive-user" });
  });
});

describe("truncated roots, read roots and interpreters", () => {
  it("treats a truncated granted root as inside the root", () => {
    const cut = workspace.slice(0, workspace.length - 4);
    expect(bash(`cd ${cut}`)).toMatchObject({ allow: true });
  });

  it("still refuses a genuine path outside the roots", () => {
    expect(bash("cat C:/Windows/System32/drivers/etc/hosts")).toMatchObject({ allow: false, rule: "workspace-escape" });
  });

  it("permits paths inside a read-only root", () => {
    expect(bash("cat F:/reference/notes.md", { readOnlyRoots: [path.resolve("F:/reference")] })).toMatchObject({ allow: true });
  });

  it("blocks interpreters by default and permits delegated ones", () => {
    expect(bash("pwsh -File ./run.ps1")).toMatchObject({ allow: false, rule: "interpreter-escape" });
    expect(bash("pwsh -File ./run.ps1", { allowInterpreters: ["pwsh"] })).toMatchObject({ allow: true });
    expect(bash("wsl ls", { allowInterpreters: ["pwsh"] })).toMatchObject({ allow: false, rule: "interpreter-escape" });
  });
});
