module.exports = {
  testEnvironment: "node",
  testMatch:       ["**/tests/**/*.test.js"],
  testTimeout:     30000,
  // Don't transform node_modules
  transformIgnorePatterns: ["/node_modules/"],
  // Verbose output
  verbose: true,
  // Bail on first failure in CI
  bail: false,
};
