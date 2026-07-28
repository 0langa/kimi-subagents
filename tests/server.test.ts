import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION, resultView } from "../src/server.js";
import type { JobRecord } from "../src/types.js";

const now = new Date().toISOString();
const record: JobRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerPid: process.pid,
  status: "completed",
  jobType: "execute",
  workspace: "C:\\fixture",
  additionalRoots: [],
  taskSummary: "test",
  allowDirty: false,
  allowCommit: false,
  allowDelete: false,
  effort: "high",
  stallSeconds: 900,
  createdAt: now,
  updatedAt: now,
  retries: 0,
  finalMessage: "m".repeat(10_000),
  diffPatch: "diff --git a/x b/x",
  blockedActions: [],
  shellCommands: [
    { at: now, decision: "allow", rule: "default", command: "npm test" },
    { at: now, decision: "deny", rule: "remote git mutation", command: "git push" }
  ],
  changedFiles: [],
  recoveryAvailable: false,
  acceptedRisk: "allow-unless-blocked"
};

describe("server scaffold", () => {
  it("reports the same version as the package manifest", async () => {
    const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(version);
  });

  it("omits heavy sections from results unless they are requested", () => {
    const view = resultView(record, [], 60_000);
    expect(view.diffPatch).toBeUndefined();
    expect(view.shellCommands).toHaveLength(1);
    expect(view.shellCommands[0]?.decision).toBe("deny");
    expect(view.finalMessage?.length).toBeLessThan(5_000);
    expect(view.available).toMatchObject({ patch: true, commands: 2, deniedCommands: 1 });
  });

  it("returns requested sections within the byte cap", () => {
    const view = resultView(record, ["patch", "commands", "message"], 6_000);
    expect(view.diffPatch).toBe("diff --git a/x b/x");
    expect(view.shellCommands).toHaveLength(2);
    expect(view.finalMessage).toContain("[truncated at 6000 characters]");
  });
});
