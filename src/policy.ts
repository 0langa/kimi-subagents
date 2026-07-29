import path from "node:path";

import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";

import type { JobType } from "./types.js";

export interface PolicyDecision { allow: boolean; reason: string; rule: string }

export interface PolicyInput {
  jobType: JobType;
  toolName: string;
  kind?: ToolKind | null;
  content: unknown;
  roots: string[];
  readOnlyRoots: string[];
  allowInterpreters: string[];
  workspace: string;
  allowCommit: boolean;
  allowDelete: boolean;
}

export interface ExtractedAction {
  action?: string;
  command?: string;
  targetPath?: string;
  diffPaths: string[];
  mcpTool?: string;
  truncated: boolean;
}

const APPROVAL_PREFIX = "Requesting approval to ";
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "ReadMediaFile", "TodoList", "SetTodoList", "TaskList", "TaskOutput", "CronList", "WebSearch", "FetchURL"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "StrReplaceFile", "WriteFile", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "Shell", "Terminal"]);
// Turn control: these end or shape Kimi's own turn and touch nothing. Refusing
// ExitPlanMode makes a plan job unable to deliver its plan, so Kimi retries it
// forever.
const TURN_CONTROL_TOOLS = new Set(["ExitPlanMode", "EnterPlanMode", "TodoWrite"]);
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "AskUser", "RequestUserInput"]);

const DELETE_PATTERNS = [
  /(?:^|[;&|\s(])(?:rm|rmdir|shred|unlink|del|erase|remove-item)(?:\s|$)/i
];
const DESTRUCTIVE_GIT_PATTERNS = [
  /\bgit\s+(?:clean|filter-branch|gc)(?:\s|$)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+stash\s+(?:drop|clear)/i,
  /\bgit\s+branch\s+-D/,
  /\bgit\s+tag\s+-d\b/i,
  /\bgit\s+reflog\s+expire/i,
  /\bgit\s+update-ref\s+-d/i,
  /\bgit\s+(?:checkout|restore)\s+(?:--\s*)?\.(?:\s|$)/i
];
const REMOTE_MUTATION_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgit\s+remote\s+(?:add|set-url|remove|rename)\b/i,
  /(?:^|[;&|\s(])(?:gh|glab|hub)(?:\s|$)/i,
  /\b(?:npm|yarn|pnpm|cargo|poetry|gem|dotnet)\s+publish\b/i,
  /\btwine\s+upload\b/i,
  /\b(?:npm|yarn|pnpm)\s+(?:login|adduser|token)\b/i
];
const GLOBAL_CONFIG_PATTERNS = [
  /\bgit\s+config\s+(?:--global|--system)/i,
  /\b(?:npm|yarn|pnpm)\s+config\s+set\b/i
];
const CREDENTIAL_PATTERNS = [
  /(?:\.ssh\/|\.git-credentials|\.npmrc|\.aws\/credentials|\.kimi-code\/credentials|\.claude\/\.credentials|\.codex\/auth)/i,
  /(?:^|[;&|\s(])(?:printenv|env)(?:\s|$)/i,
  /\$\{?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY)/i
];
const COMMIT_PATTERN = /\bgit\s+commit(?:\s|$)/i;

function contentEntries(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
}

function entryText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "content") return undefined;
  const inner = entry.content as { type?: string; text?: string } | undefined;
  return inner?.type === "text" ? inner.text : undefined;
}

export function extractAction(content: unknown): ExtractedAction {
  const entries = contentEntries(content);
  const diffPaths = entries
    .filter((entry) => entry.type === "diff" && typeof entry.path === "string")
    .map((entry) => entry.path as string);
  const approval = entries
    .map(entryText)
    .filter((text): text is string => typeof text === "string" && text.startsWith(APPROVAL_PREFIX))
    .map((text) => text.slice(APPROVAL_PREFIX.length).trim())
    .at(-1);
  const extracted: ExtractedAction = { action: approval, diffPaths, truncated: false };
  if (!approval) return extracted;
  extracted.truncated = /[…]$/.test(approval) || approval.endsWith("...");
  const running = /^(?:Running|Starting background):\s*([\s\S]+)$/.exec(approval);
  if (running) {
    extracted.command = running[1]!.replace(/[…]$/, "").trim();
    return extracted;
  }
  const filed = /^(?:Writing|Editing|Reading media:|Reading)\s+([\s\S]+)$/.exec(approval);
  if (filed) {
    extracted.targetPath = filed[1]!.trim();
    return extracted;
  }
  const called = /^Call\s+(\S+)/.exec(approval);
  if (called) extracted.mcpTool = called[1];
  return extracted;
}

function insideRoots(roots: string[], candidate: string): boolean {
  const resolved = path.resolve(candidate).toLowerCase();
  return roots.some((root) => {
    const base = path.resolve(root).toLowerCase();
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

/**
 * Kimi truncates the command preview at 50 characters, which can cut a granted
 * root mid-name ("...\devstorage-gua" for "...\devstorage-guard"). Such a
 * fragment is a prefix of the root, never a path outside it, so the broker
 * defers to the shell guard, which sees the untruncated command.
 */
function truncatedRootPrefix(roots: string[], candidate: string): boolean {
  const resolved = path.resolve(candidate).toLowerCase();
  return roots.some((root) => path.resolve(root).toLowerCase().startsWith(resolved));
}

function interpreterDecision(command: string, allowed: string[]): PolicyDecision | undefined {
  const match = /(?:^|[;&|\s(])(powershell|pwsh|cmd|wsl)(?:\.exe)?(?:\s|$)/i.exec(command);
  if (!match) return undefined;
  const interpreter = match[1]!.toLowerCase();
  if (allowed.map((entry) => entry.trim().toLowerCase()).includes(interpreter)) return undefined;
  return { allow: false, reason: `Alternate interpreter escapes the shell guard: ${interpreter}`, rule: "interpreter-escape" };
}

function absoluteCandidates(command: string): string[] {
  const matches = [
    ...command.matchAll(/["']([A-Za-z]:[\\/][^"']+)["']/g),
    ...command.matchAll(/(?:^|\s)([A-Za-z]:[\\/][^\s;&|"']+)/g),
    ...command.matchAll(/(?:^|\s)(\/[a-zA-Z]\/[^\s;&|"']+)/g)
  ];
  return [...new Set(matches.map((match) => match[1]!).map((value) => /^\/[a-zA-Z]\//.test(value) ? `${value[1]}:${value.slice(2)}` : value))];
}

function commandDecision(input: PolicyInput, command: string): PolicyDecision {
  const interpreter = interpreterDecision(command, input.allowInterpreters);
  if (interpreter) return interpreter;
  if (REMOTE_MUTATION_PATTERNS.some((pattern) => pattern.test(command))) {
    return { allow: false, reason: "Remote Git, GitHub or package publication is main-agent-only", rule: "remote-mutation" };
  }
  if (GLOBAL_CONFIG_PATTERNS.some((pattern) => pattern.test(command))) {
    return { allow: false, reason: "Global tool configuration changes are blocked", rule: "global-config" };
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(command))) {
    return { allow: false, reason: "Credential export or credential file access blocked", rule: "credential" };
  }
  if (!input.allowDelete && DELETE_PATTERNS.some((pattern) => pattern.test(command))) {
    return { allow: false, reason: "Permanent deletion was not explicitly delegated", rule: "deletion" };
  }
  if (DESTRUCTIVE_GIT_PATTERNS.some((pattern) => pattern.test(command))) {
    return { allow: false, reason: "Destructive Git command blocked", rule: "destructive-git" };
  }
  if (!input.allowCommit && COMMIT_PATTERN.test(command)) {
    return { allow: false, reason: "Local commit was not explicitly delegated", rule: "commit" };
  }
  for (const candidate of absoluteCandidates(command)) {
    if (insideRoots(input.roots, candidate)) continue;
    // Read-only roots are readable here; the shell guard denies writes to them.
    if (insideRoots(input.readOnlyRoots, candidate)) continue;
    if (truncatedRootPrefix(input.roots, candidate)) continue;
    return { allow: false, reason: `Path outside granted roots referenced by shell command: ${candidate}`, rule: "workspace-escape" };
  }
  return { allow: true, reason: "Shell command permitted; full text is enforced by the shell guard", rule: "shell-allow" };
}

function pathDecision(input: PolicyInput, candidates: string[]): PolicyDecision {
  if (candidates.length === 0) {
    return { allow: false, reason: "File mutation without an identifiable target path is refused", rule: "unresolved-path" };
  }
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(input.workspace, candidate);
    if (!insideRoots(input.roots, resolved)) {
      return { allow: false, reason: `File mutation outside granted roots blocked: ${resolved}`, rule: "workspace-escape" };
    }
  }
  return { allow: true, reason: "File mutation inside granted roots", rule: "edit-allow" };
}

function readDecision(input: PolicyInput, candidates: string[]): PolicyDecision {
  const roots = [...input.roots, ...input.readOnlyRoots];
  return pathDecision({ ...input, roots }, candidates);
}

export function decidePermission(input: PolicyInput): PolicyDecision {
  const extracted = extractAction(input.content);
  const toolName = input.toolName.trim();

  if (toolName.startsWith("mcp__") || extracted.mcpTool?.startsWith("mcp__")) {
    return { allow: false, reason: "MCP tools are not available to delegated Kimi jobs", rule: "mcp-blocked" };
  }
  if (/^Deleting cron/i.test(extracted.action ?? "")) {
    return { allow: false, reason: "Scheduled task mutation is main-agent-only", rule: "cron-blocked" };
  }
  if (TURN_CONTROL_TOOLS.has(toolName)) {
    return { allow: true, reason: "Turn control changes nothing outside the session", rule: "turn-control" };
  }
  if (INTERACTIVE_TOOLS.has(toolName)) {
    return { allow: false, reason: "A delegated job has no interactive user; answer from the evidence you have", rule: "no-interactive-user" };
  }

  const shell = SHELL_TOOLS.has(toolName) || input.kind === "execute" || Boolean(extracted.command);
  const edit = EDIT_TOOLS.has(toolName) || (!shell && ["edit", "move", "delete"].includes(input.kind ?? ""));

  if (input.jobType !== "execute") {
    if (shell) return { allow: false, reason: `${input.jobType} job: command execution is denied`, rule: "read-only-job" };
    if (edit) return { allow: false, reason: `${input.jobType} job: file mutation is denied`, rule: "read-only-job" };
    if (READ_ONLY_TOOLS.has(toolName)) {
      return readDecision(input, extracted.targetPath ? [extracted.targetPath] : [input.workspace]);
    }
    return { allow: false, reason: `${input.jobType} job: unrecognised tool "${toolName}" is refused`, rule: "fail-closed" };
  }

  if (shell) {
    if (!extracted.command) {
      return { allow: false, reason: "Shell approval without readable command text is refused", rule: "fail-closed" };
    }
    return commandDecision(input, extracted.command);
  }
  if (edit) {
    const candidates = extracted.diffPaths.length > 0 ? extracted.diffPaths : extracted.targetPath ? [extracted.targetPath] : [];
    return pathDecision(input, candidates);
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return readDecision(input, extracted.targetPath ? [extracted.targetPath] : [input.workspace]);
  }
  if (!extracted.action) {
    return { allow: false, reason: `Tool "${toolName}" requested approval without a readable action description`, rule: "fail-closed" };
  }
  return { allow: false, reason: `Tool "${toolName}" is not delegated to Kimi jobs`, rule: "fail-closed" };
}

export function selectPermission(request: RequestPermissionRequest, allow: boolean): { outcome: "cancelled" } | { outcome: "selected"; optionId: string } {
  const preferred = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  const option = preferred.flatMap((kind) => request.options.filter((candidate) => candidate.kind === kind))[0];
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}
