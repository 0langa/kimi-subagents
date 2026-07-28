import path from "node:path";

import type { RequestPermissionRequest, ToolCall, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";

import type { JobType } from "./types.js";

export interface PolicyDecision { allow: boolean; reason: string }

const DELETE_PATTERNS = [
  /(?:^|[;&|\s])(?:rm|del|erase|rmdir|rd|remove-item|unlink|shred)\b/i,
  /\bgit\s+(?:clean\b|reset\s+--hard\b|stash\s+(?:drop|clear)\b|branch\s+-D\b|tag\s+-d\b|reflog\s+expire\b|gc\b)/i,
  /\bgit\s+(?:checkout|restore)\s+--?\s*\./i
];
const REMOTE_MUTATION_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgh\s+(?:pr\s+(?:create|merge|close|edit|comment|review)|issue\s+(?:create|close|edit|comment|delete)|release\s+(?:create|delete|edit|upload)|repo\s+(?:delete|rename|archive|fork|create)|api\b.*(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE))/i,
  /(?:api\.github\.com|github\.com\/api).*(?:-X|--request|--method)\s*(?:POST|PUT|PATCH|DELETE)/i
];
const CREDENTIAL_PATTERNS = [
  /\bgh\s+auth\s+token\b/i,
  /\b(?:set|env|printenv|get-childitem\s+env:)\b.*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i,
  /\b(?:echo|write-output)\b.*\$(?:env:)?(?:\w*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)\w*)/i
];
const COMMIT_PATTERN = /\bgit\s+commit\b/i;

function stringifyTool(call: ToolCall | ToolCallUpdate): string {
  let raw: string;
  try { raw = JSON.stringify(call.rawInput ?? ""); } catch { raw = ""; }
  return `${"name" in call ? call.name ?? "" : ""} ${call.title ?? ""} ${raw}`;
}

function rootsContain(roots: string[], candidate: string): boolean {
  const resolved = path.resolve(candidate).toLowerCase();
  return roots.some((root) => {
    const base = path.resolve(root).toLowerCase();
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

function pathValues(value: unknown, key = ""): string[] {
  if (typeof value === "string" && /^(?:path|file|cwd|directory|destination|source)$/i.test(key) && path.isAbsolute(value)) return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => pathValues(entry, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([childKey, entry]) => pathValues(entry, childKey));
  return [];
}

export function decideTool(jobType: JobType, call: ToolCall | ToolCallUpdate, roots: string[], allowCommit: boolean): PolicyDecision {
  const kind: ToolKind | null | undefined = call.kind;
  const text = stringifyTool(call);
  const locations = [...(call.locations ?? []).map((location) => location.path), ...pathValues(call.rawInput)];
  if (locations.some((candidate) => path.isAbsolute(candidate) && !rootsContain(roots, candidate))) {
    return { allow: false, reason: "Workspace escape blocked" };
  }
  if (kind === "delete" || DELETE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allow: false, reason: "Permanent deletion or destructive Git blocked" };
  }
  if (REMOTE_MUTATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allow: false, reason: "GitHub or remote Git mutation is main-agent-only" };
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allow: false, reason: "Credential export blocked" };
  }
  if (COMMIT_PATTERN.test(text) && !allowCommit) {
    return { allow: false, reason: "Local commit was not explicitly delegated" };
  }
  if (jobType === "analyze" && !["read", "search", "think", "fetch", "other", undefined, null].includes(kind)) {
    return { allow: false, reason: "Analyze jobs allow read/search only; edits and command execution are denied" };
  }
  if (jobType === "plan" && ["edit", "delete", "move"].includes(kind ?? "other")) {
    return { allow: false, reason: "Plan jobs cannot modify files" };
  }
  return { allow: true, reason: "Allowed by guarded allow-unless-blocked policy" };
}

export function selectPermission(request: RequestPermissionRequest, allow: boolean): { outcome: "cancelled" } | { outcome: "selected"; optionId: string } {
  const preferred = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const option = preferred.flatMap((kind) => request.options.filter((candidate) => candidate.kind === kind))[0];
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}
