/**
 * Jest configuration for the interop tests against real tus servers.
 * Start the servers first (npm run interop does everything).
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests/interop'],
    testMatch: ['**/*.test.ts'],
    testTimeout: 120000
};
