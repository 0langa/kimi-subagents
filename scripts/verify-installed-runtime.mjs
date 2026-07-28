// End-to-end check against an installed plugin copy: boots the installed MCP
// server, runs one guarded execute job in a throwaway Git repository, and
// asserts that the shell guard shipped and blocked a destructive command.
// Usage: node scripts/verify-installed-runtime.mjs <installed-plugin-root>
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(process.argv[2] ?? ".");
for (const relative of ["dist/server.mjs", "assets/shell-guard.sh"]) {
  if (!existsSync(path.join(pluginRoot, relative))) throw new Error(`Installed plugin root is missing ${relative}`);
}
if (readFileSync(path.join(pluginRoot, "assets/shell-guard.sh"), "utf8").includes("\r")) {
  throw new Error("Installed shell guard has CR characters; Git Bash would fail on every guarded command");
}

const workspace = mkdtempSync(path.join(os.tmpdir(), "kimi-installed-"));
const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
execFileSync("git", ["init", "-q", workspace]);
git("config", "user.email", "verify@example.invalid");
git("config", "user.name", "Kimi Subagents Verify");
writeFileSync(path.join(workspace, "seed.txt"), "seed\n");
git("add", "-A");
git("commit", "-qm", "seed");

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(pluginRoot, "dist", "server.mjs")],
  cwd: pluginRoot,
  stderr: "pipe"
});
const client = new Client({ name: "kimi-subagents-runtime-verify", version: "0.2.0" });
const unwrap = (response) => response.structuredContent?.result ?? JSON.parse(response.content?.[0]?.text ?? "{}").result;

try {
  await client.connect(transport);
  const started = unwrap(await client.callTool({
    name: "kimi_start",
    arguments: {
      jobType: "execute",
      workspace,
      task: [
        "Runtime verification. Run each command with the Bash tool and report the literal outcome; failures are expected data.",
        "1. Run: git status --porcelain",
        "2. Run: git clean -nd",
        `3. Run: echo ${"a".repeat(60)} && git clean -nx`,
        "4. Run: printf verified > verified.txt"
      ].join("\n")
    }
  }));
  if (!started?.id) throw new Error("kimi_start did not return a job id");

  let status = started;
  while (!["completed", "failed", "blocked", "cancelled"].includes(status.status)) {
    status = unwrap(await client.callTool({ name: "kimi_status", arguments: { jobId: started.id, waitSeconds: 55, waitForTerminal: true } }));
  }
  const record = unwrap(await client.callTool({ name: "kimi_result", arguments: { jobId: started.id, include: ["commands", "patch"] } }));

  const denied = (record.shellCommands ?? []).filter((event) => event.decision === "deny");
  const guardBlocks = (record.blockedActions ?? []).filter((action) => action.source === "shell-guard");
  const problems = [];
  if (record.status !== "completed") problems.push(`job status was ${record.status}: ${record.error ?? "no error"}`);
  if (!denied.some((event) => /git clean/.test(event.command)) && !(record.blockedActions ?? []).some((action) => /git clean|destructive/i.test(`${action.title} ${action.reason}`))) {
    problems.push("destructive command was not blocked by either layer");
  }
  // Step 3 hides the destructive verb behind Kimi's 50 character preview
  // truncation, so only the installed shell guard can catch it.
  if (!denied.some((event) => /git clean -nx/.test(event.command))) {
    problems.push("shell guard did not block a command hidden behind preview truncation");
  }
  if ((record.shellCommands ?? []).length === 0) problems.push("shell guard produced no command log; it was not active");
  if (!existsSync(path.join(workspace, "verified.txt"))) problems.push("allowed write did not happen");
  if (problems.length > 0) throw new Error(`Installed runtime verification failed:\n- ${problems.join("\n- ")}`);

  process.stdout.write(`${JSON.stringify({
    pluginRoot,
    jobId: record.id,
    status: record.status,
    commandsLogged: record.shellCommands.length,
    guardDenials: denied.map((event) => event.command),
    guardBlockedActions: guardBlocks.length,
    patchBytes: record.available?.patchBytes ?? 0
  }, null, 2)}\n`);
} finally {
  await client.close();
  rmSync(workspace, { recursive: true, force: true });
}
