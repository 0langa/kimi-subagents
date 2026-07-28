import type { ToolKind, Usage } from "@agentclientprotocol/sdk";

export type JobType = "analyze" | "plan" | "execute";
export type JobStatus = "queued" | "preparing" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface StartJobInput {
  task: string;
  jobType: JobType;
  workspace: string;
  additionalRoots?: string[];
  allowDirty?: boolean;
  allowCommit?: boolean;
  timeoutSeconds?: number;
  model?: string;
  thinking?: string;
  policyMode?: "manual" | "ask" | "auto";
}

export interface BlockedAction {
  toolCallId: string;
  title: string;
  kind?: ToolKind | null;
  reason: string;
  at: string;
}

export interface ChangedFile {
  path: string;
  status: string;
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
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  progress?: string;
  stopReason?: string;
  finalMessage?: string;
  error?: string;
  retries: number;
  usage?: Usage;
  blockedActions: BlockedAction[];
  changedFiles: ChangedFile[];
  diffSummary?: string;
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
  diagnostics?: string;
  capabilities: unknown;
}
