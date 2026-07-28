---
name: kimi-subagents
description: Delegate suitable Codex or Claude Code work to installed Kimi Code through guarded asynchronous ACP jobs. Use only after user activates kimi-subagents, selects manual/ask/auto mode, or directly requests a Kimi job.
---

# Kimi Subagents

Delegate only after explicit activation in the current host conversation. Session policy never lives in the MCP server. This skill is identical for Codex and Claude Code: same modes, same tool calls, same reporting.

## Modes

- `off`: inactive. Default before the user points to the plugin. `stop`, `off`, or `disable kimi-subagents` sets off.
- `manual`: default when invoked without a mode. Launch only when the user directly requests a specific Kimi task.
- `ask`: propose one declared batch, including job types and purpose, then wait for one approval before launching it.
- `auto`: cost-aware routine delegation without approval. Maximum three Kimi jobs per user request.

Natural phrases control the mode: "use kimi-subagents in ask mode", "use kimi-subagents auto", "switch Kimi to manual", or equivalent. Mode switches affect future jobs only; running jobs continue unless the user asks to cancel. Keep the mode in conversation context only. Never call a global mode-setting tool.

If the user asks for status, report the current session mode plus active and recent jobs using `kimi_list` or `kimi_status`.

## Delegation selection

Use Kimi for bounded, lower-risk work: repo search, mechanical edits, test writing, routine implementation, build and test runs, summarization, or parallel independent checks. Keep the main agent on ambiguous architecture, security judgment, credential work, permanent deletion, remote GitHub actions, final verification, and work needing host-only context.

Job types:

- `analyze`: read and search only. Edits and every shell command are denied.
- `plan`: native ACP plan mode. File mutation and shell commands are denied.
- `execute`: workspace edits, tests, builds, installs and local development commands.

Flags, each requiring an explicit user request for the underlying action:

- `allowCommit`: the delegated task explicitly asks for a local commit.
- `allowDelete`: the delegated task explicitly requires deleting files inside the granted roots.
- `allowDirty`: the user accepts starting from a dirty Git tree.
- `allowNetwork`: the task genuinely needs Kimi's own `FetchURL`/`WebSearch`. Without it, a network call cancels the job.
- `allowSubagents`: the task genuinely needs nested Kimi agents. Without it, `Agent` and `AgentSwarm` fail instantly.
- `trackUsage`: record the job in the separately installed Usage Pulse plugin.

In `auto`, do not delegate when the task is small enough that delegation overhead dominates, depends heavily on unstated conversation context, or could cause high-impact damage. Count every `kimi_start` against the three-job budget, including retries launched as new jobs.

## Workflow

1. Before the first job in a session, call `kimi_preflight` for the current workspace. If it fails, report the exact fix and do not launch.
2. In ask mode, describe one batch and wait. In auto mode, emit one line: `Kimi: launching <job-type> job for <purpose>.`
3. Call `kimi_start` with an absolute workspace, minimal extra roots, the current policy mode, and no timeout by default. Effort defaults deterministically (`low` for analyze, `high` for plan and execute); override `effort` or `model` only after an explicit user request. A job with no reported activity for 15 minutes is cancelled automatically; raise `stallSeconds` for genuinely long builds.
4. Continue useful host work. Call `kimi_status` with `waitForTerminal=true` and `waitSeconds=55`; repeat only while it is still running. Never use shell sleep or rapid model-driven polling. Use `kimi_cancel` on user request or when the work becomes obsolete.
5. Get `kimi_result`. It returns the summary, changed files and denied commands by default; pass `include: ["patch"]` to read the unified diff before accepting execute output, and `include: ["commands"]` when you need the full shell log. Rerun the relevant checks independently, then decide accepted, repaired or rejected.
6. When the work is nearly right, call `kimi_followup` with the specific correction instead of writing a new task from scratch: it reuses the workspace, roots and flags and carries a summary of the parent job. Each follow-up counts against the auto-mode budget.
7. Report the verified summary, changed files, rerun checks, blocked actions, shell commands of interest, usage when available, and the job ID. Show the redacted Kimi final message only on request.

If one transient ACP failure retries automatically and still fails, ask before falling back to expensive Codex or Claude work.

## Guarded execution

Every shell command in a delegated job passes a shell guard that sees the full command text and exits 126 on denial. Denied classes: permanent deletion, destructive Git, remote Git and GitHub CLI usage, credential access, alternate interpreters, network uploads, and writes outside the granted roots. Denials appear in `kimi_result` as `blockedActions` with `source: "shell-guard"`, and the full decision log is in `shellCommands`.

When a job reports blocks, decide deliberately: either the block was correct, or the task needs a flag such as `allowDelete`, or the work belongs to the main agent. Never rewrite a task to disguise a blocked operation.

The delegated runtime also turns off what Kimi would otherwise approve for itself: nested agents and cron fail instantly, web search has no credentials, telemetry and auto-update are off. `FetchURL` cannot be removed from Kimi, so the runtime forbids it in its own `AGENTS.md` and cancels any job that calls it without `allowNetwork`. A cancelled call may still have left the machine: never put secrets in task text.

Kimi reports no token usage over ACP, so `kimi_result` has no cost figures. If the user wants local usage numbers, pass `trackUsage: true` and read them with the Usage Pulse plugin.

## Protected operations

GitHub push, PR, issue, release, merge and delete, plus permanent deletion outside the granted roots, remain main-agent-only. Never pass GitHub credentials or host MCP servers to Kimi. The main agent fetches private GitHub context and materializes only the needed local files.

Execute jobs refuse dirty Git trees unless the user explicitly approves `allowDirty`. Checkpoint restore requires the user to confirm the exact phrase `RESTORE <job-id>`, then call `kimi_restore` for the selected paths only.

Accepted limitation: same-user Windows execution cannot guarantee protection from novel or obfuscated destructive commands. Main-agent review is mandatory.

Kimi ACP `/goal` is unsupported in verified Kimi Code 0.29.2. Do not use or suggest goal mode.
