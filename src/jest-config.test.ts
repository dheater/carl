import * as path from "path";
import * as fs from "fs";

describe("Jest configuration", () => {
  let jestConfig: any;

  beforeEach(() => {
    // Load the Jest config from jest.config.js
    const configPath = path.join(__dirname, "..", "jest.config.js");
    const configModule = require(configPath);
    jestConfig = configModule;
  });

  test("roots is exactly ['<rootDir>/src']", () => {
    expect(jestConfig.roots).toBeDefined();
    expect(jestConfig.roots).toEqual(["<rootDir>/src"]);
  });

  test("testMatch includes '**/*.test.ts'", () => {
    expect(jestConfig.testMatch).toBeDefined();
    expect(jestConfig.testMatch).toContain("**/*.test.ts");
  });

  test("testPathIgnorePatterns includes /.agent/ and /.tmp/", () => {
    expect(jestConfig.testPathIgnorePatterns).toBeDefined();
    const patterns = jestConfig.testPathIgnorePatterns;

    const hasAgentPattern = patterns.some((p: string) => p.includes(".agent"));
    const hasTmpPattern = patterns.some((p: string) => p.includes(".tmp"));

    expect(hasAgentPattern).toBe(true);
    expect(hasTmpPattern).toBe(true);
  });

  test("modulePathIgnorePatterns includes /.agent/ and /.tmp/", () => {
    expect(jestConfig.modulePathIgnorePatterns).toBeDefined();
    const patterns = jestConfig.modulePathIgnorePatterns;

    const hasAgentPattern = patterns.some((p: string) => p.includes(".agent"));
    const hasTmpPattern = patterns.some((p: string) => p.includes(".tmp"));

    expect(hasAgentPattern).toBe(true);
    expect(hasTmpPattern).toBe(true);
  });
});
