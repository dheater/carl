module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  modulePathIgnorePatterns: [
    "<rootDir>/dist/",
    "<rootDir>/.agent/",
    "<rootDir>/.tmp/",
    "<rootDir>/node_modules/",
  ],
  testPathIgnorePatterns: [
    "<rootDir>/dist/",
    "<rootDir>/.agent/",
    "<rootDir>/.tmp/",
    "<rootDir>/node_modules/",
  ],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.test.json",
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@augmentcode/auggie-sdk$":
      "<rootDir>/src/__mocks__/@augmentcode/auggie-sdk.ts",
  },
};
