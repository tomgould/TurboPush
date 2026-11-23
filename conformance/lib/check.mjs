// @ts-check
/**
 * Check definitions and the assertion helpers checks use.
 */

/**
 * @typedef {'maxFileSize' | 'maxChunkSize' | 'maxChunks' | 'uploadDir' | 'allowedOrigin'} Input
 */

/**
 * @typedef {object} Check
 * @property {string} id Stable identifier, such as upload.single-chunk
 * @property {'MUST' | 'SHOULD'} severity MUST failures fail the run, SHOULD failures are warnings
 * @property {string} description What the check verifies
 * @property {Input[]} [requires] Inputs the check needs; it is skipped without them
 * @property {boolean} [sweep] Runs after all other checks, over every recorded response
 * @property {(ctx: import('./context.mjs').Context) => Promise<void>} run Throws CheckFailure on failure
 */

/** Thrown by a check that found a protocol violation */
export class CheckFailure extends Error {}

/** Thrown by a check that cannot run */
export class CheckSkip extends Error {}

/**
 * Fails the current check
 *
 * @param {string} message Short reason
 * @returns {never}
 */
export function fail(message) {
    throw new CheckFailure(message);
}

/**
 * Skips the current check
 *
 * @param {string} message Why it cannot run
 * @returns {never}
 */
export function skip(message) {
    throw new CheckSkip(message);
}

/**
 * Fails the check unless the condition holds
 *
 * @param {unknown} condition
 * @param {string} message Reason if it does not
 * @returns {asserts condition}
 */
export function expect(condition, message) {
    if (!condition) {
        fail(message);
    }
}

/**
 * Describes a response for failure messages: status and server message
 *
 * @param {import('./http.mjs').Response} response
 * @returns {string}
 */
export function describe(response) {
    const message = response.json && typeof response.json.message === 'string' ? ` "${response.json.message}"` : '';
    return `${response.status}${message}`;
}

/**
 * Fails the check unless the response has one of the expected status codes
 *
 * @param {import('./http.mjs').Response} response
 * @param {number | number[]} expected
 * @param {string} what What the request was, for the failure message
 */
export function expectStatus(response, expected, what) {
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.includes(response.status)) {
        fail(`${what}: expected ${list.join(' or ')}, got ${describe(response)}`);
    }
}

/**
 * Fails the check unless the response is a 200 with success: true, and
 * returns its data
 *
 * @param {import('./http.mjs').Response} response
 * @param {string} what
 * @returns {Record<string, any>}
 */
export function expectOk(response, what) {
    expectStatus(response, 200, what);
    expect(response.json && response.json.success === true, `${what}: 200 without "success": true`);
    const data = response.json.data;
    expect(data !== null && typeof data === 'object', `${what}: response has no "data" object`);
    return data;
}

/**
 * Compares two values as JSON
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Extensions that must never be the final (or an inner) extension of a
 * stored file: ones a web server may execute and ones a browser runs
 * scripts in. Matches the reference endpoint's default blocklist.
 */
export const DANGEROUS_EXTENSIONS = new Set([
    'php', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'phtm',
    'pht', 'phar', 'phps', 'inc', 'cgi', 'pl', 'asp', 'aspx', 'ashx', 'asmx', 'jsp',
    'jspx', 'shtml', 'shtm', 'htaccess', 'htpasswd',
    'html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'mht', 'mhtml', 'hta',
]);

/**
 * Explains why a stored file name is unsafe, or returns null if it is safe:
 * a single path segment, not hidden, no trailing dot or space (Windows
 * drops them), and no dangerous final or inner extension
 *
 * @param {unknown} name Stored name returned by the server
 * @returns {string | null}
 */
export function unsafeNameReason(name) {
    if (typeof name !== 'string' || name === '') {
        return 'no stored file name returned';
    }
    if (/[/\\\0]/.test(name)) {
        return 'contains a path separator';
    }
    if (name.startsWith('.')) {
        return 'starts with a dot';
    }
    if (/[. ]$/.test(name)) {
        return 'ends with a dot or space';
    }
    const segments = name.toLowerCase().split('.');
    if (segments.length > 1) {
        const last = segments[segments.length - 1];
        if (DANGEROUS_EXTENSIONS.has(last)) {
            return `has the dangerous extension .${last}`;
        }
        const inner = segments.slice(1, -1).find(segment => DANGEROUS_EXTENSIONS.has(segment));
        if (inner !== undefined) {
            return `has the inner extension .${inner}`;
        }
    }
    return null;
}
