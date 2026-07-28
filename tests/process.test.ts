import { describe, expect, it } from "vitest";

import { sanitizedChildEnv } from "../src/process.js";

describe("child environment", () => {
  it("removes remote mutation credentials", () => {
    const env = sanitizedChildEnv({ GITHUB_TOKEN: "secret", GITHUB_TOKEN_ELEVATED: "secret", GITHUB_TOKEN_FULL: "secret", GH_TOKEN: "secret", NPM_TOKEN: "secret" });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN_ELEVATED).toBeUndefined();
    expect(env.GITHUB_TOKEN_FULL).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY).toBe("2");
  });
});
