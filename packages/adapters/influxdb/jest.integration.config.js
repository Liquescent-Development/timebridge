module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.integration.test.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
  testTimeout: 30000, // 30 seconds for integration tests
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
};
