/**
 * Test Setup
 *
 * The jsdom test environment provides real implementations of Blob, File,
 * FormData, AbortController and localStorage, so no browser API mocks are
 * needed. This file only resets shared state between tests.
 *
 * This file is automatically loaded by Jest via setupFilesAfterEnv configuration.
 *
 * @module TestSetup
 * @since 1.0.0
 */

import { TextEncoder } from 'util';

// jsdom lacks TextEncoder, which every supported browser and Node have
if (typeof (globalThis as any).TextEncoder === 'undefined') {
    (globalThis as any).TextEncoder = TextEncoder;
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});
