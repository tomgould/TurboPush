/**
 * Test Setup - Browser API Mocks for Node.js Environment
 *
 * Provides mock implementations of browser APIs (Blob, File, AbortController)
 * that are not available in Node.js test environment. These mocks enable
 * testing of file upload functionality without requiring a real browser.
 *
 * This file is automatically loaded by Jest via setupFilesAfterEnv configuration.
 *
 * @module TestSetup
 * @since 1.0.0
 */

/**
 * MockBlob - Mock implementation of the browser Blob API
 *
 * Simulates the Blob interface for testing file operations in Node.js.
 * Supports content storage, slicing, and size calculation.
 *
 * @class MockBlob
 * @implements {Blob}
 */
class MockBlob {
    /** Array of content parts (strings, ArrayBuffers, or other Blobs) */
    private content: any[];

    /** MIME type of the blob content */
    public type: string;

    /**
     * Creates a new MockBlob instance
     *
     * @param {any[]} content - Array of content parts to store in the blob
     * @param {Object} [options] - Optional configuration
     * @param {string} [options.type] - MIME type of the blob content
     *
     * @example
     * ```typescript
     * const blob = new MockBlob(['Hello, World!'], { type: 'text/plain' });
     * console.log(blob.size); // 13
     * ```
     */
    constructor(content: any[], options?: { type?: string }) {
        this.content = content;
        this.type = options?.type || '';
    }

    /**
     * Creates a new Blob containing a subset of the source blob's data
     * Similar to Array.slice(), returns a new blob with the specified range
     *
     * @param {number} [start] - Starting byte position (inclusive)
     * @param {number} [end] - Ending byte position (exclusive)
     * @returns {MockBlob} New MockBlob containing the sliced content
     *
     * @example
     * ```typescript
     * const blob = new MockBlob(['Hello, World!']);
     * const sliced = blob.slice(0, 5); // Contains 'Hello'
     * ```
     */
    slice(start?: number, end?: number): MockBlob {
        return new MockBlob(this.content.slice(start, end), { type: this.type });
    }

    /**
     * Calculates and returns the total size of the blob in bytes
     * Handles different content types: strings, ArrayBuffers, and nested Blobs
     *
     * @returns {number} Total size in bytes
     *
     * @example
     * ```typescript
     * const blob = new MockBlob(['Hello']); // 5 bytes
     * const buffer = new ArrayBuffer(10); // 10 bytes
     * const combined = new MockBlob([blob, buffer]); // 15 bytes total
     * console.log(combined.size); // 15
     * ```
     */
    get size(): number {
        return this.content.reduce((acc, item) => {
            // Calculate size based on content type
            if (typeof item === 'string') return acc + item.length;
            if (item instanceof ArrayBuffer) return acc + item.byteLength;
            if (item instanceof MockBlob) return acc + item.size;
            return acc;
        }, 0);
    }
}

/**
 * MockFile - Mock implementation of the browser File API
 *
 * Extends MockBlob to add file-specific properties like name and lastModified.
 * Used for testing file upload functionality in Node.js environment.
 *
 * @class MockFile
 * @extends {MockBlob}
 * @implements {File}
 */
class MockFile extends MockBlob {
    /** Name of the file including extension */
    public name: string;

    /** Timestamp of last modification in milliseconds since epoch */
    public lastModified: number;

    /**
     * Creates a new MockFile instance
     *
     * @param {any[]} content - Array of content parts for the file
     * @param {string} name - File name including extension
     * @param {Object} [options] - Optional configuration
     * @param {string} [options.type] - MIME type of the file
     * @param {number} [options.lastModified] - Last modified timestamp (defaults to now)
     *
     * @example
     * ```typescript
     * const file = new MockFile(
     *     [new Blob(['test content'])],
     *     'test.txt',
     *     { type: 'text/plain', lastModified: Date.now() }
     * );
     * console.log(file.name); // 'test.txt'
     * console.log(file.size); // 12
     * ```
     */
    constructor(content: any[], name: string, options?: any) {
        super(content, options);
        this.name = name;
        this.lastModified = options?.lastModified || Date.now();
    }
}

/**
 * Mock AbortController implementation for upload cancellation
 *
 * Provides a simple implementation of AbortController for testing
 * fetch request cancellation in Node.js environment.
 *
 * @class MockAbortController
 * @implements {AbortController}
 */
class MockAbortController {
    /** AbortSignal object containing abort state */
    public signal: { aborted?: boolean } = {};

    /**
     * Aborts the associated request by setting signal.aborted to true
     *
     * @returns {void}
     *
     * @example
     * ```typescript
     * const controller = new AbortController();
     * setTimeout(() => controller.abort(), 1000);
     *
     * fetch(url, { signal: controller.signal })
     *     .catch(err => console.log('Aborted!'));
     * ```
     */
    abort(): void {
        this.signal.aborted = true;
    }
}

// ============================================================================
// Global API Registration
// ============================================================================
// Replace global browser APIs with mock implementations for Node.js testing

/**
 * Register MockBlob as global Blob constructor
 * Allows test code to use `new Blob()` as if in a browser
 */
global.Blob = MockBlob as any;

/**
 * Register MockFile as global File constructor
 * Allows test code to use `new File()` as if in a browser
 */
global.File = MockFile as any;

/**
 * Register MockAbortController as global AbortController
 * Allows test code to use AbortController for request cancellation
 */
global.AbortController = MockAbortController as any;