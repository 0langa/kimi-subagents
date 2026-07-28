import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCall,
  type ToolCallUpdate,
  type Usage
} from "@agentclientprotocol/sdk";

import { decideTool, selectPermission } from "./policy.js";
import { redact, safeError } from "./redaction.js";
import type { RecoveryManager } from "./recovery.js";
import { runFile, sanitizedChildEnv, terminateProcessTree } from "./process.js";
import type { BlockedAction, PreflightResult, RunResult, StartJobInput } from "./types.js";

interface ActiveConnection { child: ChildProcessWithoutNullStreams; connection: ClientSideConnection; sessionId?: string }
interface RunnerCallbacks { onSession?: (sessionId: string) => Promise<void>; onProgress?: (progress: string) => Promise<void> }

function versionTuple(value: string): [number, number, number] | undefined {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function versionAtLeast(value: string, minimum: [number, number, number]): boolean {
  const current = versionTuple(value);
  if (!current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

function childStream(child: ChildProcessWithoutNullStreams) {
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  return ndJsonStream(output, input);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function promptFor(input: StartJobInput): string {
  const common = [
    "You are a delegated Kimi Code worker. Complete only the declared task inside granted roots.",
    "Never permanently delete files, run destructive Git, mutate GitHub/remotes, or expose credentials.",
    "Do not use GitHub credentials or remote mutation commands. Report blocks instead.",
    "You may use at most two nested agents. Finish with a concise summary, changed files, and checks run."
  ];
  if (input.jobType === "analyze") common.push("READ-ONLY ANALYZE JOB: read and search only. Do not edit files or execute commands.");
  if (input.jobType === "plan") common.push("PLAN JOB: use native ACP plan mode. Do not modify files.");
  if (input.jobType === "execute") {
    common.push("EXECUTE JOB: local edits, tests, builds, installs, and development commands are allowed unless blocked by policy.");
    common.push(input.allowCommit ? "A local Git commit is explicitly allowed." : "Do not create a Git commit.");
  }
  common.push(`TASK:\n${input.task}`);
  return common.join("\n\n");
}

function spawnAgent(command: string, args: string[], workspace: string): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd: workspace,
    env: sanitizedChildEnv(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export class AcpRunner {
  private readonly active = new Map<string, ActiveConnection>();
  private readonly cancelling = new Set<string>();

  constructor(
    private readonly recovery: RecoveryManager,
    private readonly command = "kimi",
    private readonly commandArgs = ["acp"]
  ) {}

  async preflight(workspace: string): Promise<PreflightResult> {
    const errors: string[] = [];
    const nodeVersion = process.versions.node;
    let kimiVersion: string | undefined;
    try { kimiVersion = (await runFile("kimi", ["--version"])).stdout.trim(); } catch (error) { errors.push(`Kimi CLI unavailable: ${safeError(error)}`); }
    const result: PreflightResult = {
      ok: false,
      node: { found: true, version: nodeVersion, supported: versionAtLeast(nodeVersion, [20, 0, 0]) },
      kimi: { found: Boolean(kimiVersion), version: kimiVersion, supported: Boolean(kimiVersion && versionAtLeast(kimiVersion, [0, 29, 2])), authenticated: false },
      errors
    };
    if (!result.node.supported) errors.push("Node 20 or newer required");
    if (kimiVersion && !result.kimi.supported) errors.push("Kimi Code 0.29.2 or newer required");
    if (!result.node.supported || !result.kimi.supported) return result;
    const child = spawnAgent(this.command, this.commandArgs, workspace);
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8192); });
    const client: Client = { requestPermission: () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: () => undefined };
    const connection = new ClientSideConnection(() => client, childStream(child));
    try {
      const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "kimi-subagents", version: "0.1.0" } });
      const session = await connection.newSession({ cwd: workspace, mcpServers: [] });
      result.kimi.authenticated = true;
      result.acp = { protocolVersion: initialized.protocolVersion, sessionCreated: Boolean(session.sessionId), capabilities: initialized.agentCapabilities };
      result.ok = true;
    } catch (error) {
      errors.push(`ACP session failed: ${safeError(error)}${diagnostics ? `; ${redact(diagnostics)}` : ""}`);
      result.acp = { sessionCreated: false };
    } finally {
      child.stdin.end();
      await Promise.race([waitForExit(child).catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]);
      if (child.pid && child.exitCode === null) await terminateProcessTree(child.pid);
    }
    return result;
  }

  async run(jobId: string, input: StartJobInput, callbacks: RunnerCallbacks = {}): Promise<RunResult> {
    const child = spawnAgent(this.command, this.commandArgs, input.workspace);
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8192); });
    const roots = [input.workspace, ...(input.additionalRoots ?? [])];
    const tools = new Map<string, ToolCall | ToolCallUpdate>();
    const blockedActions: BlockedAction[] = [];
    let finalMessage = "";
    let usage: Usage | undefined;

    const client: Client = {
      sessionUpdate: async ({ update }: SessionNotification) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          finalMessage = `${finalMessage}${update.content.text}`.slice(-64 * 1024);
          await callbacks.onProgress?.(redact(finalMessage.slice(-240)));
        } else if (update.sessionUpdate === "tool_call") {
          tools.set(update.toolCallId, update);
          await callbacks.onProgress?.(`${update.kind ?? "tool"}: ${redact(update.title).slice(0, 180)}`);
        } else if (update.sessionUpdate === "tool_call_update") {
          tools.set(update.toolCallId, { ...(tools.get(update.toolCallId) ?? {}), ...update });
        }
      },
      requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const call = { ...(tools.get(request.toolCall.toolCallId) ?? {}), ...request.toolCall } as ToolCallUpdate;
        const decision = decideTool(input.jobType, call, roots, Boolean(input.allowCommit));
        if (decision.allow && input.jobType === "execute" && ["edit", "move", "delete", "execute"].includes(call.kind ?? "other")) {
          await this.recovery.backupBeforeWrite(jobId, call);
        }
        if (!decision.allow) {
          blockedActions.push({ toolCallId: call.toolCallId, title: redact(call.title ?? "Unknown tool"), kind: call.kind, reason: decision.reason, at: new Date().toISOString() });
          await callbacks.onProgress?.(`blocked: ${decision.reason}`);
        }
        return { outcome: selectPermission(request, decision.allow) };
      }
    };
    const connection = new ClientSideConnection(() => client, childStream(child));
    this.active.set(jobId, { child, connection });
    let sessionId = "";
    try {
      const initialized: InitializeResponse = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { plan: {} },
        clientInfo: { name: "kimi-subagents", version: "0.1.0" }
      });
      const session = await connection.newSession({ cwd: input.workspace, additionalDirectories: input.additionalRoots ?? [], mcpServers: [] });
      sessionId = session.sessionId;
      this.active.set(jobId, { child, connection, sessionId: session.sessionId });
      await callbacks.onSession?.(session.sessionId);
      if (input.jobType === "plan") await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "mode", value: "plan" });
      if (input.model) await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: input.model });
      if (input.thinking) await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: input.thinking });
      const response = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: promptFor(input) }] });
      usage = response.usage ?? undefined;
      child.stdin.end();
      const exitCode = await Promise.race([waitForExit(child), new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 2000))]);
      if (exitCode === null && child.pid) await terminateProcessTree(child.pid);
      return {
        sessionId: session.sessionId,
        stopReason: response.stopReason,
        finalMessage: redact(finalMessage),
        usage,
        blockedActions,
        diagnostics: diagnostics ? redact(diagnostics) : undefined,
        capabilities: initialized.agentCapabilities
      };
    } catch (error) {
      if (this.cancelling.has(jobId)) {
        return { sessionId, stopReason: "cancelled", finalMessage: redact(finalMessage), usage, blockedActions, diagnostics: diagnostics ? redact(diagnostics) : undefined, capabilities: {} };
      }
      throw error;
    } finally {
      this.active.delete(jobId);
      this.cancelling.delete(jobId);
      if (child.pid && child.exitCode === null) await terminateProcessTree(child.pid);
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const active = this.active.get(jobId);
    if (!active) return false;
    this.cancelling.add(jobId);
    if (active.sessionId) {
      try { await active.connection.cancel({ sessionId: active.sessionId }); } catch { /* force-kill below */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (active.child.pid && active.child.exitCode === null) await terminateProcessTree(active.child.pid);
    return true;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((jobId) => this.cancel(jobId)));
  }
}
