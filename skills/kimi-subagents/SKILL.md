---
name: kimi-subagents
description: Delegate suitable Codex or Claude Code work to installed Kimi Code through guarded asynchronous ACP jobs. Use only after user activates kimi-subagents, selects manual/ask/auto mode, or directly requests a Kimi job.
---

# Kimi Subagents

Delegate only after explicit activation in current host conversation. Session policy never lives in MCP server.

## Modes

- `off`: inactive. Default before user points to plugin. `stop`, `off`, or `disable kimi-subagents` sets off.
- `manual`: default when invoked without mode. Launch only when user directly requests specific Kimi task.
- `ask`: propose one declared batch, including job types and purpose, then wait for one approval before launching it.
- `auto`: cost-aware routine delegation without approval. Maximum three Kimi jobs per user request.

Natural phrases control mode: “use kimi-subagents in ask mode”, “use kimi-subagents auto”, “switch Kimi to manual”, or equivalent. Mode switches affect future jobs only; running jobs continue unless user asks to cancel. Keep mode in conversation context only. Never call a global mode-setting tool.

If user asks status, report current session mode plus active/recent jobs using `kimi_list` or `kimi_status`.

## Delegation selection

Use Kimi for bounded, lower-risk work: repo search, mechanical edits, test writing, routine implementation, build/test runs, summarization, or parallel independent checks. Keep main agent on ambiguous architecture, security judgment, credential work, permanent deletion, remote GitHub actions, final verification, and work needing host-only context.

Job types:

- `analyze`: read/search only. Edits and command execution denied.
- `plan`: native ACP plan mode. File mutation denied.
- `execute`: workspace edits, tests, builds, installs, and local development commands. Set `allowCommit` only when delegated task explicitly requests local commit.

In `auto`, do not delegate when task is tiny enough that delegation overhead dominates, depends heavily on unstated conversation context, or could cause high-impact damage. Count every `kimi_start` against three-job budget, including retries initiated as new jobs.

## Workflow

1. Before first job in session, call `kimi_preflight` for current workspace. If it fails, report exact fix; do not launch.
2. In ask mode, describe one batch and wait. In auto mode, emit one-line notice: `Kimi: launching <job-type> job for <purpose>.`
3. Call `kimi_start` with absolute workspace, minimal extra roots, current policy mode, and no timeout by default. Pass model/thinking only after explicit user request.
4. Continue useful host work. Call `kimi_status` with `waitForTerminal=true` and `waitSeconds=55`; repeat only if still running. Never use shell sleep or rapid model-driven polling. Use `kimi_cancel` on user request or obsolete work.
5. Get `kimi_result`. Independently inspect diff or explicitly allowed commit range, rerun relevant checks, and decide accepted/repaired/rejected.
6. Report verified summary, changed files, rerun checks, blocks, usage when available, and job ID. Show redacted Kimi final message only on request.

If one transient ACP failure retries automatically and still fails, ask before falling back to expensive Codex/Claude work.

## Protected operations

GitHub push/PR/issue/release/merge/delete and permanent local deletion remain main-agent-only. Never pass GitHub credentials or host MCP servers to Kimi. Main agent fetches private GitHub context and materializes only needed local files.

Execute jobs refuse dirty Git trees unless user explicitly approves `allowDirty`. Checkpoint restore requires user to confirm exact phrase `RESTORE <job-id>`, then call `kimi_restore` for selected paths only.

Accepted limitation: same-user Windows shell execution cannot guarantee protection from novel or obfuscated destructive commands. Main-agent review is mandatory.

Kimi ACP `/goal` is unsupported in verified Kimi Code 0.29.2. Do not use or suggest goal mode.
