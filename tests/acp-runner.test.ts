import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AcpRunner } from "../src/acp-runner.js";
import { RecoveryManager } from "../src/recovery.js";

const roots: string[] = [];
const priorMode = process.env.FAKE_ACP_MODE;
afterEach(async () => {
  if (priorMode === undefined) delete process.env.FAKE_ACP_MODE; else process.env.FAKE_ACP_MODE = priorMode;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-"));
  const storage = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-store-"));
  roots.push(workspace, storage);
  await writeFile(path.join(workspace, "fixture.txt"), "safe\n");
  const runner = new AcpRunner(new RecoveryManager(storage), process.execPath, [path.resolve("tests/fixtures/fake-acp.mjs")]);
  return { runner, workspace };
}

describe("ACP runner", () => {
  it("streams result and allows ordinary execute tool", async () => {
    process.env.FAKE_ACP_MODE = "execute";
    const { runner, workspace } = await setup();
    const result = await runner.run("33333333-3333-4333-8333-333333333333", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:allow");
    expect(result.usage?.totalTokens).toBe(12);
    expect(result.blockedActions).toEqual([]);
  });

  it("denies execute tool in analyze mode", async () => {
    process.env.FAKE_ACP_MODE = "execute";
    const { runner, workspace } = await setup();
    const result = await runner.run("44444444-4444-4444-8444-444444444444", { task: "test", jobType: "analyze", workspace });
    expect(result.finalMessage).toBe("permission:reject");
    expect(result.blockedActions[0]?.reason).toContain("Analyze jobs");
  });

  it("denies permanent deletion", async () => {
    process.env.FAKE_ACP_MODE = "delete";
    const { runner, workspace } = await setup();
    const result = await runner.run("55555555-5555-4555-8555-555555555555", { task: "test", jobType: "execute", workspace });
    expect(result.finalMessage).toBe("permission:reject");
    expect(result.blockedActions[0]?.reason).toContain("deletion");
    expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toBe("safe\n");
  });

  it("cancels active session and process", async () => {
    process.env.FAKE_ACP_MODE = "delay";
    const { runner, workspace } = await setup();
    const jobId = "66666666-6666-4666-8666-666666666666";
    const pending = runner.run(jobId, { task: "wait", jobType: "analyze", workspace });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await runner.cancel(jobId)).toBe(true);
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
  });
});
