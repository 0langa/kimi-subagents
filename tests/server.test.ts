import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/server.js";

describe("server scaffold", () => {
  it("exposes plugin version", () => {
    expect(SERVER_VERSION).toBe("0.1.1");
  });
});
