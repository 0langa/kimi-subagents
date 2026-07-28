import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { JobManager } from "./job-manager.js";
import { safeError } from "./redaction.js";
import type { StartJobInput } from "./types.js";

export const SERVER_VERSION = "0.1.0";

function result(value: unknown) {
  const structuredContent = { result: value };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: safeError(error) }] };
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
      timeoutSeconds: z.number().int().min(5).max(86_400).optional().describe("No timeout when omitted."),
      model: z.string().min(1).optional(),
      thinking: z.string().min(1).optional(),
      policyMode: z.enum(["manual", "ask", "auto"]).optional()
    },
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (input) => {
    try { return result(await manager.start(input as StartJobInput)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_status", {
    description: "Get current lifecycle state and latest redacted progress for one Kimi job.",
    inputSchema: { jobId: z.string().uuid() }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId }) => {
    try { return result(await manager.get(jobId)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_list", {
    description: "List recent redacted Kimi job records, newest first.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit }) => {
    try { return result(await manager.list(limit)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_cancel", {
    description: "Cancel a queued or running Kimi job and terminate its Kimi process tree.",
    inputSchema: { jobId: z.string().uuid() }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId }) => {
    try { return result(await manager.cancel(jobId)); } catch (error) { return failure(error); }
  });

  server.registerTool("kimi_result", {
    description: "Get structured redacted job result: summary, changed files, tests reported by Kimi, blocks, usage, retries, diff attribution, and recovery availability.",
    inputSchema: { jobId: z.string().uuid() }, outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ jobId }) => {
    try { return result(await manager.get(jobId)); } catch (error) { return failure(error); }
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
