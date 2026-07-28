import { afterEach, describe, expect, it } from "vitest";

import { redact } from "../src/redaction.js";

describe("redaction", () => {
  const previous = process.env.TEST_SECRET_TOKEN;
  afterEach(() => {
    if (previous === undefined) delete process.env.TEST_SECRET_TOKEN;
    else process.env.TEST_SECRET_TOKEN = previous;
  });

  it("removes known environment secret values and token patterns", () => {
    process.env.TEST_SECRET_TOKEN = "known-secret-value-123";
    const output = redact(`token known-secret-value-123 ${"github_pat_"}${"A".repeat(30)}`);
    expect(output).not.toContain("known-secret-value-123");
    expect(output).not.toContain("github_pat_");
    expect(output).toContain("[REDACTED]");
  });
});
