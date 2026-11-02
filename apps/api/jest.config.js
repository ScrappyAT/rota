/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  cacheDirectory: require('path').resolve(__dirname,'../../.r1-test-cache/jest'),
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/__tests__/helpers/r3-cleanup.ts'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Integration tests share one live Postgres/Redis instance and clear tables;
  // running files in parallel against the same database would corrupt state.
  maxWorkers: 1,
};
