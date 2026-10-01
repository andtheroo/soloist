// Pure-logic tests (grading, game rules, store, snapshot decoding) run in plain Node —
// no React Native runtime needed. Component tests would use the jest-expo preset instead.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/modules/soloist-audio/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: true, esModuleInterop: true, target: 'ES2020' } }] },
};
