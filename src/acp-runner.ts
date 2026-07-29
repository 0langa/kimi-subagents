import { randomUUID } from "node:crypto";
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

import { delegateEnv, watchToolCall } from "./delegate-runtime.js";
import { decidePermission, extractAction, selectPermission } from "./policy.js";
import type { IsolatedKimiHome } from "./kimi-home.js";
import { redact, safeError } from "./redaction.js";
import type { RecoveryManager } from "./recovery.js";
import { runFile, sanitizedChildEnv, terminateProcessTree } from "./process.js";
import type { PreparedGuard, ShellGuard } from "./shell-guard.js";
import { DEFAULT_EFFORT, type BlockedAction, type PreflightResult, type RunResult, type ShellCommandRecord, type StartJobInput, type ToolViolation } from "./types.js";

// Kimi re-submits a refused tool call indefinitely; without a ceiling a plan job
// spent 21 minutes retrying ExitPlanMode 28 times before the host cancelled it.
const DENIAL_DEADLOCK_LIMIT = 4;

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
    "A shell guard inspects every command you run. Destructive Git, remote Git or GitHub mutation, credential access, alternate interpreters (powershell/cmd/wsl) and writes outside the granted roots are denied and exit with code 126.",
    "When a command is denied, do not look for a way around it: report the block and continue with the rest of the task.",
    "Finish with a concise summary, changed files, and checks run."
  ];
  common.push(input.allowNetwork
    ? "Network access through FetchURL is explicitly allowed for this job."
    : "No network access: FetchURL and WebSearch are forbidden and calling one cancels the job.");
  common.push(input.allowSubagents
    ? "Nested agents are explicitly allowed for this job; use at most two."
    : "Nested agents are disabled: Agent and AgentSwarm fail immediately, so do the work yourself.");
  common.push(input.allowDelete
    ? "File deletion inside the granted roots is explicitly allowed for this job."
    : "File deletion was not delegated: do not delete files.");
  if (input.jobType === "analyze") common.push("READ-ONLY ANALYZE JOB: read and search only. Do not edit files or execute commands.");
  if (input.jobType === "plan") common.push("PLAN JOB: use native ACP plan mode. Do not modify files.");
  if (input.jobType === "execute") {
    common.push("EXECUTE JOB: local edits, tests, builds, installs, and development commands are allowed unless blocked by policy.");
    common.push(`WORKSPACE ROOT: ${input.workspace}. Use absolute paths for every file mutation. For shell commands, set the working directory explicitly to this root.`);
    common.push(input.allowCommit ? "A local Git commit is explicitly allowed." : "Do not create a Git commit.");
  }
  common.push(`TASK:\n${input.task}`);
  return common.join("\n\n");
}

async function collectShellCommands(guard: PreparedGuard | undefined, blockedActions: BlockedAction[]): Promise<ShellCommandRecord[]> {
  if (!guard) return [];
  const events = await guard.read().catch(() => []);
  const records = events.map((event) => ({ ...event, command: redact(event.command) }));
  for (const denied of records.filter((event) => event.decision === "deny")) {
    blockedActions.push({
      toolCallId: `shell-guard:${denied.at}`,
      title: denied.command.slice(0, 200),
      kind: "execute",
      reason: `${denied.rule} [shell-guard]`,
      at: denied.at,
      source: "shell-guard"
    });
  }
  return records;
}

function spawnAgent(command: string, args: string[], workspace: string, isolatedHome?: string, extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd: workspace,
    env: sanitizedChildEnv({
      ...(isolatedHome ? { KIMI_CODE_HOME: isolatedHome, USERPROFILE: isolatedHome, HOME: isolatedHome } : {}),
      ...extraEnv
    }),
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
    private readonly commandArgs = ["acp"],
    private readonly isolatedHome?: IsolatedKimiHome,
    private readonly shellGuard?: ShellGuard
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
    const isolationId = `preflight-${randomUUID()}`;
    let home: string | undefined;
    try {
      home = await this.isolatedHome?.prepare(isolationId);
    } catch (error) {
      errors.push(`Safe Kimi runtime isolation unavailable: ${safeError(error)}`);
      return result;
    }
    const child = spawnAgent(this.command, this.commandArgs, workspace, home);
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8192); });
    const client: Client = { requestPermission: () => ({ outcome: { outcome: "cancelled" } }), sessionUpdate: () => undefined };
    const connection = new ClientSideConnection(() => client, childStream(child));
    try {
      const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "kimi-subagents", version: "0.3.1" } });
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
      if (home) await this.isolatedHome?.dispose(isolationId);
    }
    return result;
  }

  async run(jobId: string, input: StartJobInput, callbacks: RunnerCallbacks = {}): Promise<RunResult> {
    const roots = [input.workspace, ...(input.additionalRoots ?? [])];
    const readOnlyRoots = input.readOnlyRoots ?? [];
    const allowInterpreters = input.allowInterpreters ?? [];
    let guard: PreparedGuard | undefined;
    try {
      guard = await this.shellGuard?.prepare({
        jobId,
        jobType: input.jobType,
        roots,
        readOnlyRoots,
        allowInterpreters,
        allowCommit: Boolean(input.allowCommit),
        allowDelete: Boolean(input.allowDelete)
      });
    } catch (error) {
      throw new Error(`Delegated job refused: ${safeError(error)}`, { cause: error });
    }
    const home = await this.isolatedHome?.prepare(jobId, { trackUsage: Boolean(input.trackUsage) });
    const child = spawnAgent(this.command, this.commandArgs, input.workspace, home, { ...delegateEnv(input), ...(guard?.env ?? {}) });
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-8192); });
    const tools = new Map<string, ToolCall | ToolCallUpdate>();
    const blockedActions: BlockedAction[] = [];
    const toolViolations: ToolViolation[] = [];
    const denialCounts = new Map<string, number>();
    let deadlock: string | undefined;
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
          const verdict = watchToolCall(update.title, input);
          if (verdict.violation) {
            toolViolations.push({ at: new Date().toISOString(), tool: update.title, reason: verdict.reason, cancelled: verdict.cancel });
            await callbacks.onProgress?.(`policy violation: ${verdict.reason}`);
            if (verdict.cancel) void this.cancel(jobId);
          }
        } else if (update.sessionUpdate === "tool_call_update") {
          tools.set(update.toolCallId, { ...(tools.get(update.toolCallId) ?? {}), ...update });
        }
      },
      requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const cached = tools.get(request.toolCall.toolCallId);
        const call = { ...(cached ?? {}), ...request.toolCall } as ToolCallUpdate;
        const decision = decidePermission({
          jobType: input.jobType,
          toolName: request.toolCall.title ?? call.title ?? "",
          kind: cached?.kind ?? call.kind,
          content: request.toolCall.content,
          roots,
          readOnlyRoots,
          allowInterpreters,
          workspace: input.workspace,
          allowCommit: Boolean(input.allowCommit),
          allowDelete: Boolean(input.allowDelete)
        });
        if (decision.allow && input.jobType === "execute") {
          const extracted = extractAction(request.toolCall.content);
          const targets = [...extracted.diffPaths, ...(extracted.targetPath ? [extracted.targetPath] : [])];
          await this.recovery.backupBeforeWrite(jobId, targets);
        }
        if (!decision.allow) {
          const key = `${call.title ?? "unknown"}|${decision.rule}`;
          const seen = (denialCounts.get(key) ?? 0) + 1;
          denialCounts.set(key, seen);
          if (seen >= DENIAL_DEADLOCK_LIMIT && !deadlock) {
            deadlock = `${call.title ?? "unknown tool"} was refused ${seen} times (${decision.rule}); the job cannot make progress`;
            await callbacks.onProgress?.(`policy deadlock: ${deadlock}`);
            void this.cancel(jobId);
          }
          blockedActions.push({
            toolCallId: call.toolCallId,
            title: redact(call.title ?? "Unknown tool"),
            kind: call.kind,
            reason: `${decision.reason} [${decision.rule}]`,
            at: new Date().toISOString(),
            source: "acp-broker"
          });
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
        clientInfo: { name: "kimi-subagents", version: "0.3.1" }
      });
      const session = await connection.newSession({ cwd: input.workspace, additionalDirectories: input.additionalRoots ?? [], mcpServers: [] });
      sessionId = session.sessionId;
      this.active.set(jobId, { child, connection, sessionId: session.sessionId });
      await callbacks.onSession?.(session.sessionId);
      if (input.jobType === "plan") await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "mode", value: "plan" });
      if (input.model) await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: input.model });
      const effort = input.effort ?? DEFAULT_EFFORT[input.jobType];
      try {
        await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: effort });
      } catch (error) {
        diagnostics = `${diagnostics}\n[kimi-subagents] effort "${effort}" was rejected by this Kimi build: ${safeError(error)}`.slice(-8192);
      }
      const response = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: promptFor(input) }] });
      usage = response.usage ?? undefined;
      child.stdin.end();
      const exitCode = await Promise.race([waitForExit(child), new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 2000))]);
      if (exitCode === null && child.pid) await terminateProcessTree(child.pid);
      const shellCommands = await collectShellCommands(guard, blockedActions);
      return {
        sessionId: session.sessionId,
        stopReason: response.stopReason,
        finalMessage: redact(finalMessage),
        usage,
        blockedActions,
        shellCommands,
        toolViolations,
        deadlock,
        diagnostics: diagnostics ? redact(diagnostics) : undefined,
        capabilities: initialized.agentCapabilities
      };
    } catch (error) {
      if (this.cancelling.has(jobId)) {
        const shellCommands = await collectShellCommands(guard, blockedActions);
        return { sessionId, stopReason: "cancelled", finalMessage: redact(finalMessage), usage, blockedActions, shellCommands, toolViolations, deadlock, diagnostics: diagnostics ? redact(diagnostics) : undefined, capabilities: {} };
      }
      throw error;
    } finally {
      this.active.delete(jobId);
      this.cancelling.delete(jobId);
      if (child.pid && child.exitCode === null) await terminateProcessTree(child.pid);
      if (home) await this.isolatedHome?.dispose(jobId);
      await guard?.dispose().catch(() => undefined);
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
