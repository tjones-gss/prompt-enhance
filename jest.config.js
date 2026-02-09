/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/extension"],
  testMatch: ["**/__tests__/**/*.test.js"],
  verbose: true,
};
