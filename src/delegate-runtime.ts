import os from "node:os";
import path from "node:path";

import type { StartJobInput } from "./types.js";

// Tools Kimi approves on its own: they never reach the ACP permission broker, so
// the runtime constrains them through the environment and watches the tool-call
// stream for the ones that cannot be constrained.
export const NETWORK_TOOLS = new Set(["FetchURL", "WebSearch"]);
export const SUBAGENT_TOOLS = new Set(["Agent", "AgentSwarm"]);
export const SCHEDULING_TOOLS = new Set(["CronCreate", "CronDelete"]);
export const GOAL_TOOLS = new Set(["CreateGoal", "SetGoalBudget", "UpdateGoal"]);

export const SUBAGENT_DISABLED_TIMEOUT_MS = 1;
export const SUBAGENT_ENABLED_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_STEPS_PER_TURN = 200;

export interface ToolWatchVerdict {
  violation: boolean;
  cancel: boolean;
  reason: string;
}

/**
 * Environment that turns Kimi's self-approved capabilities off at the source.
 * Verified against Kimi Code 0.29.2:
 *  - KIMI_SUBAGENT_TIMEOUT_MS=1 makes Agent/AgentSwarm fail with
 *    "Agent timed out after 1 ms" before any model call.
 *  - KIMI_DISABLE_CRON=1 makes CronCreate return
 *    "Cron scheduling is disabled (KIMI_DISABLE_CRON=1)".
 *  - WebSearch fails on its own because the isolated home carries no
 *    [services.moonshot_search] credentials.
 * FetchURL has a local fallback fetcher and cannot be disabled this way; it is
 * handled by watchToolCall below.
 */
export function delegateEnv(input: StartJobInput): Record<string, string> {
  const subagents = Boolean(input.allowSubagents);
  return {
    // The delegated process runs with a relocated HOME, so an opted-in Usage
    // Pulse would otherwise write its counters into the temporary home and lose
    // them when the job ends.
    ...(input.trackUsage ? { USAGE_PULSE_HOME: path.join(os.homedir(), ".usage-pulse") } : {}),
    KIMI_SUBAGENT_TIMEOUT_MS: String(subagents ? SUBAGENT_ENABLED_TIMEOUT_MS : SUBAGENT_DISABLED_TIMEOUT_MS),
    KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: subagents ? "2" : "1",
    KIMI_DISABLE_CRON: "1",
    KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS: "2",
    KIMI_DISABLE_TELEMETRY: "1",
    KIMI_CODE_NO_AUTO_UPDATE: "1",
    KIMI_CLI_NO_AUTO_UPDATE: "1",
    KIMI_LOOP_MAX_STEPS_PER_TURN: String(input.maxSteps ?? DEFAULT_MAX_STEPS_PER_TURN)
  };
}

/**
 * Decide what a self-approved tool call means for the job. Network calls are the
 * one capability the runtime cannot prevent, so seeing one is treated as a
 * policy violation and stops the job unless the job was started with
 * allowNetwork.
 */
export function watchToolCall(toolName: string, input: StartJobInput): ToolWatchVerdict {
  const name = toolName.trim();
  if (NETWORK_TOOLS.has(name)) {
    if (input.allowNetwork) return { violation: false, cancel: false, reason: "" };
    return { violation: true, cancel: true, reason: `${name} is not permitted for delegated jobs; job cancelled` };
  }
  if (SUBAGENT_TOOLS.has(name) && !input.allowSubagents) {
    return { violation: true, cancel: false, reason: `${name} is disabled for delegated jobs and fails immediately` };
  }
  if (SCHEDULING_TOOLS.has(name)) {
    return { violation: true, cancel: false, reason: `${name} is disabled for delegated jobs` };
  }
  if (GOAL_TOOLS.has(name)) {
    return { violation: true, cancel: false, reason: `${name} creates durable state that a delegated job must not own` };
  }
  return { violation: false, cancel: false, reason: "" };
}
