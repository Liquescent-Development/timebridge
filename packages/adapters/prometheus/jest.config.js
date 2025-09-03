module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "\\.integration\\.test\\.ts$",
  ],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/**/*.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
};
