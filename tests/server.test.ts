import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/server.js";

describe("server scaffold", () => {
  it("reports the same version as the package manifest", async () => {
    const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(version);
  });
});
