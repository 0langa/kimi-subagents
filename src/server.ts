import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { JobManager } from "./job-manager.js";
import { safeError } from "./redaction.js";
import type { JobRecord, StartJobInput } from "./types.js";

export const SERVER_VERSION = "0.3.1";

function result(value: unknown) {
  const structuredContent = { result: value };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: safeError(error) }] };
}

function statusView(record: Awaited<ReturnType<JobManager["get"]>>) {
  return {
    id: record.id,
    status: record.status,
    jobType: record.jobType,
    effort: record.effort,
    progress: record.progress,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    blockedCount: record.blockedActions.length,
    shellCommandCount: record.shellCommands.length,
    toolViolationCount: record.toolViolations.length,
    recoveryAvailable: record.recoveryAvailable,
    error: record.error
  };
}

function clip(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > maxBytes ? `${value.slice(0, maxBytes)}\n[truncated at ${maxBytes} characters]` : value;
}

// Job records hold a full diff, the whole shell command log and up to 64 KiB of
// Kimi output. Returning all of that on every call would flood the host model's
// context, so heavy sections are opt-in.
export function resultView(record: JobRecord, include: Array<"patch" | "commands" | "message">, maxBytes: number) {
  const denied = record.shellCommands.filter((event) => event.decision === "deny");
  return {
    ...record,
    finalMessage: include.includes("message") ? clip(record.finalMessage, maxBytes) : clip(record.finalMessage, 4_000),
    diffPatch: include.includes("patch") ? clip(record.diffPatch, maxBytes) : undefined,
    shellCommands: include.includes("commands") ? record.shellCommands : denied,
    available: {
      patch: Boolean(record.diffPatch),
      patchBytes: record.diffPatch?.length ?? 0,
      commands: record.shellCommands.length,
      deniedCommands: denied.length,
      messageBytes: record.finalMessage?.length ?? 0
    }
  };
}

export function createServer(manager = new JobManager()): { server: McpServer; manager: JobManager } {
  const server = new McpServer({ name: "kimi-subagents", version: SERVER_VERSION });
  const outputSchema = { result: z.unknown() };

  server.registerTool("kimi_preflight", {
    description: "Check Node and Kimi Code versions, authenticated ACP session creation, and negotiated capabilities. Runs no model prompt.",
    inputSchema: { workspace: z.string().optional().describe("Existing absolute directory used for ACP session creation.") },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ workspace }) => {
    try { return result(await manager.preflight(workspace)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_start", {
    description: "Start one asynchronous Kimi ACP job. Execute jobs refuse dirty Git trees unless allowDirty is explicitly true. Model/thinking overrides require explicit user direction.",
    inputSchema: {
      task: z.string().min(1).max(100_000),
      jobType: z.enum(["analyze", "plan", "execute"]),
      workspace: z.string().describe("Existing absolute primary workspace path."),
      additionalRoots: z.array(z.string()).max(8).optional(),
      allowDirty: z.boolean().optional(),
      allowCommit: z.boolean().optional().describe("True only when delegated task explicitly requests a local commit."),
      allowDelete: z.boolean().optional().describe("True only when the delegated task explicitly requires deleting files inside the granted roots."),
      allowNetwork: z.boolean().optional().describe("Permit Kimi's own FetchURL/WebSearch. Off by default: a network call otherwise stops the job as a policy violation."),
      allowSubagents: z.boolean().optional().describe("Permit nested Kimi agents. Off by default, in which case Agent and AgentSwarm fail immediately."),
      readOnlyRoots: z.array(z.string()).max(8).optional().describe("Absolute paths the job may read but never write, for example a reference directory outside the workspace."),
      allowInterpreters: z.array(z.enum(["pwsh", "powershell", "cmd", "wsl"])).max(4).optional().describe("Interpreters the job may launch. Off by default; needed for PowerShell or .NET work, since the guard cannot inspect commands inside them."),
      trackUsage: z.boolean().optional().describe("Record this job in the separately installed Usage Pulse plugin. Off unless requested or KIMI_SUBAGENTS_USAGE_PULSE=1."),
      maxSteps: z.number().int().min(1).max(1_000).optional().describe("Hard ceiling on Kimi loop steps per turn. Defaults to 200."),
      timeoutSeconds: z.number().int().min(5).max(86_400).optional().describe("No timeout when omitted."),
      stallSeconds: z.number().int().min(60).max(7_200).optional().describe("Cancel the job when Kimi reports no activity for this long. Defaults to 900."),
      model: z.string().min(1).optional(),
      effort: z.enum(["low", "high", "max"]).optional().describe("Reasoning effort. Defaults to low for analyze and high for plan/execute."),
      policyMode: z.enum(["manual", "ask", "auto"]).optional()
    },
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (input) => {
    try { return result(statusView(await manager.start(input as StartJobInput))); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_followup", {
    description: "Start a follow-up job for a finished job: same workspace, roots and flags, plus a compact summary of the previous task, result, changed files and blocks. Kimi sessions are never reused, so the follow-up re-reads what it needs.",
    inputSchema: {
      jobId: z.string().uuid().describe("The job to continue."),
      task: z.string().min(1).max(100_000).describe("The new instruction, for example which check failed and what to fix."),
      jobType: z.enum(["analyze", "plan", "execute"]).optional(),
      allowCommit: z.boolean().optional(),
      allowDelete: z.boolean().optional(),
      allowNetwork: z.boolean().optional(),
      allowSubagents: z.boolean().optional(),
      readOnlyRoots: z.array(z.string()).max(8).optional(),
      allowInterpreters: z.array(z.enum(["pwsh", "powershell", "cmd", "wsl"])).max(4).optional(),
      effort: z.enum(["low", "high", "max"]).optional(),
      policyMode: z.enum(["manual", "ask", "auto"]).optional()
    },
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ jobId, task, ...overrides }) => {
    try { return result(statusView(await manager.followUp(jobId, task, overrides as Partial<StartJobInput>))); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_status", {
    description: "Get compact lifecycle state. Can wait server-side for terminal state to avoid costly host-model polling turns.",
    inputSchema: {
      jobId: z.string().uuid(),
      waitSeconds: z.number().int().min(0).max(55).default(0),
      waitForTerminal: z.boolean().default(false)
    }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId, waitSeconds, waitForTerminal }) => {
    try { return result(statusView(await manager.wait(jobId, waitSeconds, waitForTerminal))); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_list", {
    description: "List recent redacted Kimi job records, newest first.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit }) => {
    try { return result((await manager.list(limit)).map(statusView)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_cancel", {
    description: "Cancel a queued or running Kimi job and terminate its Kimi process tree.",
    inputSchema: { jobId: z.string().uuid() }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId }) => {
    try { return result(statusView(await manager.cancel(jobId))); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_result", {
    description: "Get the redacted job result: summary, changed files, blocks, usage, retries, diff attribution and recovery availability. Large sections (unified diff, shell command log, full Kimi message) are omitted unless requested through include, so results stay cheap to read.",
    inputSchema: {
      jobId: z.string().uuid(),
      include: z.array(z.enum(["patch", "commands", "message"])).optional().describe("Extra sections to return. Request patch before accepting execute output."),
      maxBytes: z.number().int().min(1_000).max(400_000).default(60_000).describe("Cap for each requested section.")
    },
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId, include, maxBytes }) => {
    try { return result(resultView(await manager.get(jobId), include ?? [], maxBytes)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_restore", {
    description: "Restore selected checkpointed paths. Call only after user explicitly confirms exact phrase returned by workflow. Never restores whole workspace automatically.",
    inputSchema: {
      jobId: z.string().uuid(),
      paths: z.array(z.string().min(1)).min(1).max(100),
      confirmation: z.string().describe("Must exactly equal RESTORE <jobId> after explicit user confirmation.")
    },
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { "anthropic/requiresUserInteraction": true }
  }, async ({ jobId, paths, confirmation }) => {
    try { return result({ restored: await manager.restore(jobId, paths, confirmation) }); } catch (error) { return failure(error); }
  });

  return { server, manager };
}

export async function main(): Promise<void> {
  const { server, manager } = createServer();
  await manager.initialize();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = (): void => { void manager.shutdown(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup failure";
    process.stderr.write(`[kimi-subagents] ${message}\n`);
    process.exitCode = 1;
  });
}
