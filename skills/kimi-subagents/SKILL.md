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

Execute flags, each requiring an explicit user request for the underlying action:

- `allowCommit`: the delegated task explicitly asks for a local commit.
- `allowDelete`: the delegated task explicitly requires deleting files inside the granted roots.
- `allowDirty`: the user accepts starting from a dirty Git tree.

In `auto`, do not delegate when the task is small enough that delegation overhead dominates, depends heavily on unstated conversation context, or could cause high-impact damage. Count every `kimi_start` against the three-job budget, including retries launched as new jobs.

## Workflow

1. Before the first job in a session, call `kimi_preflight` for the current workspace. If it fails, report the exact fix and do not launch.
2. In ask mode, describe one batch and wait. In auto mode, emit one line: `Kimi: launching <job-type> job for <purpose>.`
3. Call `kimi_start` with an absolute workspace, minimal extra roots, the current policy mode, and no timeout by default. Pass model or thinking only after an explicit user request.
4. Continue useful host work. Call `kimi_status` with `waitForTerminal=true` and `waitSeconds=55`; repeat only while it is still running. Never use shell sleep or rapid model-driven polling. Use `kimi_cancel` on user request or when the work becomes obsolete.
5. Get `kimi_result`. Independently inspect the diff or the explicitly allowed commit range, rerun the relevant checks, and decide accepted, repaired or rejected.
6. Report the verified summary, changed files, rerun checks, blocked actions, shell commands of interest, usage when available, and the job ID. Show the redacted Kimi final message only on request.

If one transient ACP failure retries automatically and still fails, ask before falling back to expensive Codex or Claude work.

## Guarded execution

Every shell command in a delegated job passes a shell guard that sees the full command text and exits 126 on denial. Denied classes: permanent deletion, destructive Git, remote Git and GitHub CLI usage, credential access, alternate interpreters, network uploads, and writes outside the granted roots. Denials appear in `kimi_result` as `blockedActions` with `source: "shell-guard"`, and the full decision log is in `shellCommands`.

When a job reports blocks, decide deliberately: either the block was correct, or the task needs a flag such as `allowDelete`, or the work belongs to the main agent. Never rewrite a task to disguise a blocked operation.

Kimi cannot be prevented from using `FetchURL`, `WebSearch` or spawning its own subagents; those calls never reach the broker. Treat delegated jobs as capable of outbound network reads and do not place secrets in task text.

## Protected operations

GitHub push, PR, issue, release, merge and delete, plus permanent deletion outside the granted roots, remain main-agent-only. Never pass GitHub credentials or host MCP servers to Kimi. The main agent fetches private GitHub context and materializes only the needed local files.

Execute jobs refuse dirty Git trees unless the user explicitly approves `allowDirty`. Checkpoint restore requires the user to confirm the exact phrase `RESTORE <job-id>`, then call `kimi_restore` for the selected paths only.

Accepted limitation: same-user Windows execution cannot guarantee protection from novel or obfuscated destructive commands. Main-agent review is mandatory.

Kimi ACP `/goal` is unsupported in verified Kimi Code 0.29.2. Do not use or suggest goal mode.
