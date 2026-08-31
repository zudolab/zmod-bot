import { describe, expect, it } from "vitest";

const packageJsonRaw = Object.values(
  import.meta.glob("../package.json", { query: "?raw", import: "default", eager: true }),
)[0]!;

const packageJson = JSON.parse(packageJsonRaw) as {
  dependencies?: unknown;
  devDependencies?: Record<string, string>;
};

const EXPECTED_DEV_DEPENDENCIES = {
  "@cloudflare/workers-types": "^5.20260807.2",
  miniflare: "^4.20260730.0",
  typescript: "^7.0.2",
  vitest: "^4.1.10",
  wrangler: "^4.123.0",
};

describe("runtime dependency floor", () => {
  it("keeps package.json free of runtime dependencies", () => {
    expect(packageJson).not.toHaveProperty("dependencies");
  });

  it("keeps exactly the current five development dependencies", () => {
    expect(packageJson.devDependencies).toEqual(EXPECTED_DEV_DEPENDENCIES);
  });
});
