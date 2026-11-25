import { describe, expect, test } from "bun:test";
import { appSettings, developmentOrigin, resolveVariant } from "../src/config/variants";

describe("variants", () => {
  test("production uses the production bundle and redirect", () => {
    const settings = appSettings("production", {});
    expect(settings.bundleIdentifier).toBe("build.bent.fitness");
    expect(settings.oauth.redirectUri).toBe("build.bent.fitness://oauth");
    expect(settings.fitnessOrigin).toBe("https://fitness.bent.build");
    expect(settings.oauth.resource).toBe("https://fitness.bent.build/api/mcp");
    expect(settings.allowLocalNetworking).toBe(false);
  });

  test("development uses its own bundle and redirect", () => {
    const settings = appSettings("development", {});
    expect(settings.bundleIdentifier).toBe("build.bent.fitness.dev");
    expect(settings.oauth.redirectUri).toBe("build.bent.fitness.dev://oauth");
    expect(settings.fitnessOrigin).toBe("https://fitness.bent.build");
  });

  test("development can use a local Fitness server", () => {
    const settings = appSettings("development", { FITNESS_ORIGIN: "http://127.0.0.1:3025" });
    expect(settings.fitnessOrigin).toBe("http://127.0.0.1:3025");
    expect(settings.oauth.resource).toBe("http://127.0.0.1:3025/api/mcp");
  });

  test("only development builds may use a local HTTP issuer", () => {
    const local = { FITNESS_OAUTH_ISSUER: "http://127.0.0.1:3025", FITNESS_OAUTH_CLIENT_ID: "client_1" };
    expect(appSettings("development", local).oauth.issuer).toBe("http://127.0.0.1:3025");
    expect(() => appSettings("production", local)).toThrow();
    expect(appSettings("production", { FITNESS_OAUTH_ISSUER: "https://clerk.example.com/" }).oauth.issuer).toBe(
      "https://clerk.example.com",
    );
  });

  test("production refuses another origin", () => {
    expect(() => appSettings("production", { FITNESS_ORIGIN: "http://127.0.0.1:3025" })).toThrow();
  });

  test("origins must be HTTPS or local HTTP without a path", () => {
    expect(() => developmentOrigin("http://example.com")).toThrow();
    expect(() => developmentOrigin("https://example.com/path")).toThrow();
    expect(developmentOrigin("https://example.com").origin).toBe("https://example.com");
  });

  test("variants are development or production", () => {
    expect(resolveVariant(undefined)).toBe("production");
    expect(resolveVariant("development")).toBe("development");
    expect(() => resolveVariant("preview")).toThrow();
  });
});
