/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Integration tests share one live Postgres/Redis instance and clear tables;
  // running files in parallel against the same database would corrupt state.
  maxWorkers: 1,
};
