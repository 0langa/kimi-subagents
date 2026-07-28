import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { AcpRunner } from "./acp-runner.js";
import { changedFiles, gitDirty, gitHead, gitOutput, isGitRepository, workingTreeSnapshot, workspacePatch, type WorkingTreeEntry } from "./git.js";
import { LockManager, type HeldLocks } from "./locks.js";
import { IsolatedKimiHome } from "./kimi-home.js";
import { redact, safeError } from "./redaction.js";
import { RecoveryManager } from "./recovery.js";
import { ShellGuard } from "./shell-guard.js";
import { RecordStore } from "./storage.js";
import { DEFAULT_EFFORT, DEFAULT_STALL_SECONDS, type JobRecord, type PreflightResult, type StartJobInput } from "./types.js";

function transient(error: unknown): boolean {
  return /ECONNRESET|ETIMEDOUT|EPIPE|EOF|network|temporar|rate.?limit|process exited/i.test(error instanceof Error ? error.message : String(error));
}

function patchOf(patch: string | undefined): string | undefined {
  return patch ? redact(patch) : undefined;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class JobManager {
  readonly store: RecordStore;
  readonly recovery: RecoveryManager;
  readonly runner: AcpRunner;
  private readonly locks: LockManager;
  private readonly inputs = new Map<string, StartJobInput>();
  private readonly active = new Set<string>();
  private pumpTimer?: NodeJS.Timeout;
  private pumping = false;

  constructor(store = new RecordStore()) {
    this.store = store;
    this.recovery = new RecoveryManager(store.recoveryDir);
    this.runner = new AcpRunner(
      this.recovery,
      "kimi",
      ["acp"],
      new IsolatedKimiHome(path.join(store.root, "kimi-homes")),
      new ShellGuard(path.join(store.root, "guards"))
    );
    this.locks = new LockManager(store.locksDir);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.cleanup();
    for (const record of await this.store.list()) {
      if (["preparing", "running"].includes(record.status) && !processExists(record.ownerPid)) {
        record.status = "failed";
        record.error = "Host process stopped before job completed; recovery retained when available.";
        record.finishedAt = new Date().toISOString();
        record.updatedAt = record.finishedAt;
        record.recoveryAvailable = await this.store.recoveryExists(record.id);
        await this.store.save(record);
      }
    }
  }

  private async validateInput(input: StartJobInput): Promise<StartJobInput> {
    if (!path.isAbsolute(input.workspace)) throw new Error("workspace must be an absolute path");
    const workspace = path.resolve(input.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must be an existing directory");
    await this.assertNoProjectMcp(workspace);
    const additionalRoots: string[] = [];
    for (const root of input.additionalRoots ?? []) {
      if (!path.isAbsolute(root)) throw new Error("Every additional root must be absolute");
      const resolved = path.resolve(root);
      if (!(await stat(resolved)).isDirectory()) throw new Error(`Additional root does not exist: ${resolved}`);
      await this.assertNoProjectMcp(resolved);
      additionalRoots.push(resolved);
    }
    return { ...input, workspace, additionalRoots };
  }

  private async assertNoProjectMcp(root: string): Promise<void> {
    const config = path.join(root, ".kimi-code", "mcp.json");
    try {
      const parsed = JSON.parse(await readFile(config, "utf8")) as { mcpServers?: Record<string, { enabled?: boolean }> };
      const enabled = Object.entries(parsed.mcpServers ?? {}).filter(([, value]) => value.enabled !== false).map(([name]) => name);
      if (enabled.length > 0) throw new Error(`Project-local Kimi MCP servers are blocked for delegated jobs: ${enabled.join(", ")}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof SyntaxError) throw new Error("Project-local .kimi-code/mcp.json is malformed; delegated job refused", { cause: error });
      throw error;
    }
  }

  async preflight(workspace = process.cwd()): Promise<PreflightResult> {
    const resolved = path.resolve(workspace);
    if (!(await stat(resolved)).isDirectory()) throw new Error("Preflight workspace must be an existing directory");
    return this.runner.preflight(resolved);
  }

  async start(raw: StartJobInput): Promise<JobRecord> {
    const input = await this.validateInput(raw);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: JobRecord = {
      id,
      ownerPid: process.pid,
      status: "queued",
      jobType: input.jobType,
      workspace: input.workspace,
      additionalRoots: input.additionalRoots ?? [],
      taskSummary: redact(input.task).slice(0, 1000),
      policyMode: input.policyMode,
      parentJobId: input.parentJobId,
      allowDirty: Boolean(input.allowDirty),
      allowCommit: Boolean(input.allowCommit),
      allowDelete: Boolean(input.allowDelete),
      model: input.model,
      effort: input.effort ?? DEFAULT_EFFORT[input.jobType],
      timeoutSeconds: input.timeoutSeconds,
      stallSeconds: input.stallSeconds ?? DEFAULT_STALL_SECONDS,
      createdAt: now,
      updatedAt: now,
      retries: 0,
      blockedActions: [],
      shellCommands: [],
      changedFiles: [],
      recoveryAvailable: false,
      acceptedRisk: "allow-unless-blocked"
    };
    this.inputs.set(id, input);
    await this.store.save(record);
    this.schedulePump(0);
    return record;
  }

  // Kimi ACP sessions are never reused: each job gets a fresh isolated home, so a
  // follow-up is a new job that carries a compact, redacted summary of its parent.
  async followUp(parentJobId: string, task: string, overrides: Partial<StartJobInput> = {}): Promise<JobRecord> {
    const parent = await this.get(parentJobId);
    const changed = parent.changedFiles.map((file) => `${file.status} ${file.path}`).join("\n") || "none";
    const blocked = parent.blockedActions.map((action) => `${action.reason}: ${action.title}`).join("\n") || "none";
    const continuation = [
      `CONTINUATION OF JOB ${parent.id} (${parent.jobType}, ${parent.status}).`,
      `PREVIOUS TASK:\n${parent.taskSummary}`,
      `PREVIOUS RESULT:\n${(parent.finalMessage ?? "none").slice(0, 4000)}`,
      `FILES THE PREVIOUS JOB CHANGED:\n${changed}`,
      `ACTIONS BLOCKED IN THE PREVIOUS JOB:\n${blocked}`,
      "You do not share memory with that job. Re-read whatever you need before acting.",
      `NEW INSTRUCTION:\n${task}`
    ].join("\n\n");
    return this.start({
      task: continuation,
      jobType: overrides.jobType ?? parent.jobType,
      workspace: overrides.workspace ?? parent.workspace,
      additionalRoots: overrides.additionalRoots ?? parent.additionalRoots,
      allowDirty: overrides.allowDirty ?? true,
      allowCommit: overrides.allowCommit ?? parent.allowCommit,
      allowDelete: overrides.allowDelete ?? parent.allowDelete,
      model: overrides.model ?? parent.model,
      effort: overrides.effort ?? parent.effort,
      timeoutSeconds: overrides.timeoutSeconds ?? parent.timeoutSeconds,
      stallSeconds: overrides.stallSeconds ?? parent.stallSeconds,
      policyMode: overrides.policyMode ?? parent.policyMode,
      parentJobId: parent.id
    });
  }

  private schedulePump(delay = 250): void {
    if (this.pumpTimer || this.pumping) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pumping = true;
      void this.pump().finally(() => {
        this.pumping = false;
        if (this.inputs.size > this.active.size) this.schedulePump();
      });
    }, delay);
    this.pumpTimer.unref();
  }

  private async pump(): Promise<void> {
    let started = false;
    for (const [jobId, input] of this.inputs) {
      if (this.active.size >= 2) break;
      const record = await this.store.get(jobId);
      if (!record || record.status !== "queued") continue;
      const held = await this.locks.acquire(jobId, input.workspace, input.jobType === "execute");
      if (!held) continue;
      started = true;
      this.active.add(jobId);
      void this.runOne(jobId, input, held);
    }
    if (this.inputs.size > this.active.size && !started) this.schedulePump(750);
  }

  // Tolerates a vanished record: retention cleanup or a removed runtime root must
  // not turn a finishing job into an unhandled rejection.
  private async update(jobId: string, changes: Partial<JobRecord>): Promise<JobRecord | undefined> {
    const record = await this.store.get(jobId);
    if (!record) return undefined;
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    await this.store.save(record);
    return record;
  }

  private startStallWatchdog(jobId: string, stallSeconds: number, lastProgress: { at: number; stalled: boolean }): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (Date.now() - lastProgress.at < stallSeconds * 1000) return;
      lastProgress.stalled = true;
      clearInterval(timer);
      void this.update(jobId, { progress: `No Kimi activity for ${stallSeconds}s; cancelling stalled job` })
        .then(() => this.runner.cancel(jobId))
        .catch(() => undefined);
    }, Math.min(stallSeconds, 30) * 1000);
    timer.unref();
    return timer;
  }

  private async runOne(jobId: string, input: StartJobInput, held: HeldLocks): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    const lastProgress = { at: Date.now(), stalled: false };
    let baselineStatus = "";
    let baselineTree: WorkingTreeEntry[] = [];
    try {
      await this.update(jobId, { status: "preparing", startedAt: new Date().toISOString(), progress: "Preparing workspace" });
      const git = await isGitRepository(input.workspace);
      const baselineCommit = git ? await gitHead(input.workspace) : undefined;
      if (git) baselineStatus = await gitOutput(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (git) baselineTree = await workingTreeSnapshot(input.workspace, baselineStatus);
      await this.update(jobId, { baselineCommit });
      if (input.jobType === "execute" && git && await gitDirty(input.workspace) && !input.allowDirty) {
        await this.update(jobId, { status: "blocked", error: "Execute job refused: Git working tree is dirty. Explicit dirty override required.", finishedAt: new Date().toISOString() });
        return;
      }
      if (input.jobType === "execute") {
        await this.recovery.create(jobId, input.workspace);
        await this.update(jobId, { recoveryAvailable: true, progress: "Recovery checkpoint ready" });
      }
      await this.update(jobId, { status: "running", progress: "Kimi ACP session starting" });
      if (input.timeoutSeconds) {
        timer = setTimeout(() => { void this.runner.cancel(jobId); }, input.timeoutSeconds * 1000);
        timer.unref();
      }
      const stallSeconds = input.stallSeconds ?? DEFAULT_STALL_SECONDS;
      stallTimer = this.startStallWatchdog(jobId, stallSeconds, lastProgress);
      let result;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await this.runner.run(jobId, input, {
            onSession: async (sessionId) => { await this.update(jobId, { sessionId }); },
            onProgress: async (progress) => {
              lastProgress.at = Date.now();
              await this.update(jobId, { progress });
            }
          });
          break;
        } catch (error) {
          if (attempt === 0 && transient(error)) {
            await this.update(jobId, { retries: 1, progress: "Transient ACP failure; retrying once" });
            continue;
          }
          throw error;
        }
      }
      if (!result) throw new Error("ACP job ended without a result");
      const diff = await changedFiles(input.workspace, baselineCommit, baselineTree);
      const currentStatus = git ? await gitOutput(input.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]) : "";
      const readOnlyViolation = input.jobType !== "execute" && git && currentStatus !== baselineStatus;
      const latest = await this.store.get(jobId);
      const cancelled = latest?.status === "cancelled" || result.stopReason === "cancelled";
      const emptyResult = !cancelled && !result.finalMessage.trim();
      await this.update(jobId, {
        status: lastProgress.stalled ? "failed" : cancelled ? "cancelled" : readOnlyViolation || emptyResult ? "failed" : "completed",
        stopReason: result.stopReason,
        finalMessage: result.finalMessage,
        diagnostics: result.diagnostics,
        usage: result.usage,
        blockedActions: result.blockedActions,
        shellCommands: result.shellCommands,
        changedFiles: diff.files,
        preExistingChangedFiles: diff.preExistingFiles,
        diffSummary: readOnlyViolation ? `READ-ONLY VIOLATION: ${diff.summary}` : diff.summary,
        diffPatch: input.jobType === "execute" ? patchOf(await workspacePatch(input.workspace, baselineCommit)) : undefined,
        resultingCommit: diff.head,
        error: lastProgress.stalled
          ? `Job cancelled after ${stallSeconds}s without Kimi activity.`
          : readOnlyViolation ? "Analyze/plan job changed workspace despite read-only policy."
            : emptyResult ? "Kimi ACP returned no final message; result rejected." : undefined,
        finishedAt: new Date().toISOString(),
        progress: lastProgress.stalled ? "Stalled" : cancelled ? "Cancelled" : "Finished"
      });
    } catch (error) {
      const latest = await this.store.get(jobId);
      await this.update(jobId, {
        status: latest?.status === "cancelled" ? "cancelled" : /checkpoint exceeds/i.test(safeError(error)) ? "blocked" : "failed",
        error: safeError(error),
        finishedAt: new Date().toISOString(),
        recoveryAvailable: await this.store.recoveryExists(jobId)
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      this.active.delete(jobId);
      this.inputs.delete(jobId);
      await this.locks.release(held);
      this.schedulePump(0);
    }
  }

  async get(jobId: string): Promise<JobRecord> {
    const record = await this.store.get(jobId);
    if (!record) throw new Error(`Unknown job: ${jobId}`);
    return record;
  }

  async list(limit = 20): Promise<JobRecord[]> { return (await this.store.list()).slice(0, limit); }

  async wait(jobId: string, waitSeconds: number, terminalOnly: boolean): Promise<JobRecord> {
    const deadline = Date.now() + waitSeconds * 1000;
    const initial = await this.get(jobId);
    while (Date.now() < deadline) {
      const current = await this.get(jobId);
      if (["completed", "failed", "blocked", "cancelled"].includes(current.status)) return current;
      if (!terminalOnly && current.updatedAt !== initial.updatedAt) return current;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.get(jobId);
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.get(jobId);
    if (["completed", "failed", "blocked", "cancelled"].includes(record.status)) return record;
    await this.update(jobId, { status: "cancelled", progress: "Cancellation requested", finishedAt: new Date().toISOString() });
    if (record.status === "queued") this.inputs.delete(jobId);
    else await this.runner.cancel(jobId);
    return this.get(jobId);
  }

  async restore(jobId: string, paths: string[], confirmation: string): Promise<string[]> {
    const record = await this.get(jobId);
    if (!record.recoveryAvailable) throw new Error("No recovery checkpoint available for this job");
    return this.recovery.restore(jobId, paths, confirmation);
  }

  async shutdown(): Promise<void> { await this.runner.cancelAll(); }
}
