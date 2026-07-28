import type { ToolKind, Usage } from "@agentclientprotocol/sdk";

export type JobType = "analyze" | "plan" | "execute";
export type JobEffort = "low" | "high" | "max";

// Deterministic per-job-type effort so the same job behaves the same from Codex
// and Claude Code without the host having to pass tuning parameters.
export const DEFAULT_EFFORT: Record<JobType, JobEffort> = {
  analyze: "low",
  plan: "high",
  execute: "high"
};

export const DEFAULT_STALL_SECONDS = 900;
export type JobStatus = "queued" | "preparing" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface StartJobInput {
  task: string;
  jobType: JobType;
  workspace: string;
  additionalRoots?: string[];
  allowDirty?: boolean;
  allowCommit?: boolean;
  allowDelete?: boolean;
  timeoutSeconds?: number;
  stallSeconds?: number;
  model?: string;
  effort?: JobEffort;
  policyMode?: "manual" | "ask" | "auto";
}

export interface BlockedAction {
  toolCallId: string;
  title: string;
  kind?: ToolKind | null;
  reason: string;
  at: string;
  source: "acp-broker" | "shell-guard";
}

export interface ChangedFile {
  path: string;
  status: string;
}

export interface ShellCommandRecord {
  at: string;
  decision: "allow" | "deny";
  rule: string;
  command: string;
}

export interface JobRecord {
  id: string;
  ownerPid: number;
  status: JobStatus;
  jobType: JobType;
  workspace: string;
  additionalRoots: string[];
  taskSummary: string;
  policyMode?: "manual" | "ask" | "auto";
  allowDirty: boolean;
  allowCommit: boolean;
  allowDelete: boolean;
  model?: string;
  effort: JobEffort;
  timeoutSeconds?: number;
  stallSeconds: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  progress?: string;
  stopReason?: string;
  finalMessage?: string;
  error?: string;
  diagnostics?: string;
  retries: number;
  usage?: Usage;
  blockedActions: BlockedAction[];
  shellCommands: ShellCommandRecord[];
  changedFiles: ChangedFile[];
  preExistingChangedFiles?: ChangedFile[];
  diffSummary?: string;
  diffPatch?: string;
  baselineCommit?: string;
  resultingCommit?: string;
  recoveryAvailable: boolean;
  acceptedRisk: "allow-unless-blocked";
}

export interface PreflightResult {
  ok: boolean;
  node: { found: boolean; version: string; supported: boolean };
  kimi: { found: boolean; version?: string; supported: boolean; authenticated: boolean };
  acp?: { protocolVersion?: number; sessionCreated: boolean; capabilities?: unknown };
  errors: string[];
}

export interface RunResult {
  sessionId: string;
  stopReason: string;
  finalMessage: string;
  usage?: Usage;
  blockedActions: BlockedAction[];
  shellCommands: ShellCommandRecord[];
  diagnostics?: string;
  capabilities: unknown;
}
