/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  projects: [
    {
      displayName: "node",
      preset: "ts-jest",
      testEnvironment: "node",
      testMatch: [
        "**/placeholder.test.ts",
        "**/businessRules.test.ts",
        "**/serviceWorker.test.ts",
        "**/blurDecision.test.ts",
        "**/imageBlurDecision.test.ts",
        "**/stableBlurDecision.test.ts",
        "**/aiClient.test.ts",
        "**/options.test.ts",
      ],
    },
    {
      displayName: "jsdom",
      preset: "ts-jest",
      testEnvironment: "jsdom",
      testMatch: [
        "**/videoMonitor.test.ts",
        "**/blurManager.test.ts",
        "**/staticImageMonitor.test.ts",
      ],
    },
  ],
};
