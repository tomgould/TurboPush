// @ts-check
/**
 * Sweep checks: run last, over every response the other checks received.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail, skip } from '../lib/check.mjs';
import { header } from '../lib/http.mjs';

/** Absolute paths as they appear in error messages and stack traces */
const PATH_PATTERNS = [
    /(?<![\w.-])\/(?:tmp|var|home|usr|etc|srv|opt|private|root|Users|mnt|run|proc|Library)(?:\/[^\s"'<>]*)?/g,
    /\b[A-Za-z]:\\[^\s"'<>]*/g,
    /\\\\[\w.-]+\\[^\s"'<>]*/g,
];

/**
 * @param {import('../lib/http.mjs').Response} response
 * @returns {string}
 */
function where(response) {
    return `${response.label} (${response.status})`;
}

/**
 * Fails with a summary of the offending responses, if any
 *
 * @param {string[]} problems
 */
function report(problems) {
    if (problems.length > 0) {
        const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : '';
        fail(problems.slice(0, 3).join('; ') + more);
    }
}

/**
 * Returns the responses recorded so far that have a body
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @returns {import('../lib/http.mjs').Response[]}
 */
function withBody(ctx) {
    const responses = ctx.client.log.filter(response => response.status !== 204);
    if (responses.length === 0) {
        skip('no responses recorded');
    }
    return responses;
}

/**
 * Collects every string in a JSON value
 *
 * @param {unknown} value
 * @param {string[]} out
 * @returns {string[]}
 */
function strings(value, out = []) {
    if (typeof value === 'string') {
        out.push(value);
    } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            out.push(key);
            strings(item, out);
        }
    }
    return out;
}

/** @type {import('../lib/check.mjs').Check[]} */
export default [
    {
        id: 'response.json',
        severity: 'MUST',
        description: 'Every response is the JSON envelope {success, message, data} with a JSON Content-Type (204 preflights have no body)',
        sweep: true,
        async run(ctx) {
            if (ctx.client.log.length === 0) {
                skip('no responses recorded');
            }
            /** @type {string[]} */
            const problems = [];
            for (const response of ctx.client.log) {
                if (response.status === 204) {
                    if (response.text !== '') {
                        problems.push(`${where(response)} has a body`);
                    }
                    continue;
                }
                const type = header(response, 'content-type').toLowerCase();
                const body = response.json;
                if (!type.startsWith('application/json')) {
                    problems.push(`${where(response)} has Content-Type ${JSON.stringify(type)}`);
                } else if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    problems.push(`${where(response)} body is not a JSON object: ${JSON.stringify(response.text.slice(0, 60))}`);
                } else if (typeof body.success !== 'boolean' || typeof body.message !== 'string') {
                    problems.push(`${where(response)} lacks a boolean "success" or a string "message"`);
                } else if (!body.data || typeof body.data !== 'object' || (Array.isArray(body.data) && body.data.length > 0)) {
                    problems.push(`${where(response)} "data" is ${JSON.stringify(body.data)}, not an object`);
                } else if (body.success !== (response.status >= 200 && response.status < 300)) {
                    problems.push(`${where(response)} has "success": ${body.success}`);
                }
            }
            report(problems);
        },
    },
    {
        id: 'response.nosniff',
        severity: 'SHOULD',
        description: 'Responses carry X-Content-Type-Options: nosniff',
        sweep: true,
        async run(ctx) {
            report(withBody(ctx)
                .filter(response => header(response, 'x-content-type-options').toLowerCase() !== 'nosniff')
                .map(response => `${where(response)} lacks X-Content-Type-Options: nosniff`));
        },
    },
    {
        id: 'response.no-store',
        severity: 'SHOULD',
        description: 'Responses carry Cache-Control: no-store',
        sweep: true,
        async run(ctx) {
            report(withBody(ctx)
                .filter(response => !/\bno-store\b/i.test(header(response, 'cache-control')))
                .map(response => `${where(response)} lacks Cache-Control: no-store`));
        },
    },
    {
        id: 'errors.no-server-paths',
        severity: 'MUST',
        description: 'Error responses never reveal server paths',
        sweep: true,
        async run(ctx) {
            const literals = [os.tmpdir(), process.cwd()];
            if (ctx.options.uploadDir) {
                literals.push(ctx.options.uploadDir);
                try {
                    literals.push(fs.realpathSync(ctx.options.uploadDir));
                } catch (error) {
                    // Not created yet
                }
            }
            /** @type {string[]} */
            const problems = [];
            for (const response of withBody(ctx)) {
                if (response.status < 400 && !(response.json && response.json.success === false)) {
                    continue;
                }
                const texts = response.json !== undefined ? strings(response.json) : [response.text];
                for (const text of texts) {
                    /** @type {string[]} */
                    const found = [];
                    for (const pattern of PATH_PATTERNS) {
                        found.push(...Array.from(text.matchAll(pattern), match => match[0]));
                    }
                    found.push(...literals.filter(literal => literal.length > 1 && text.includes(literal)));
                    // Ignore paths the request itself contained, such as a file name the server echoed
                    const leaked = found.find(item => !response.sent.includes(item));
                    if (leaked !== undefined) {
                        const shown = leaked.length > 60 ? leaked.slice(0, 57) + '...' : leaked;
                        problems.push(`${where(response)} contains ${JSON.stringify(shown)}`);
                        break;
                    }
                }
            }
            report(problems);
        },
    },
    {
        id: 'storage.no-stray-files',
        severity: 'MUST',
        description: 'The upload directory gains no files other than those the server reported as stored',
        requires: ['uploadDir'],
        sweep: true,
        async run(ctx) {
            const dir = /** @type {string} */ (ctx.options.uploadDir);
            const stray = ctx.listUploadDir().filter(entry => {
                if (ctx.initialEntries.has(entry) || ctx.storedNames.has(entry)) {
                    return false;
                }
                try {
                    return !fs.lstatSync(path.join(dir, entry)).isDirectory();
                } catch (error) {
                    return false;
                }
            });
            if (stray.length > 0) {
                fail(`unreported files in the upload directory: ${JSON.stringify(stray.slice(0, 5))}${stray.length > 5 ? ' ...' : ''}`);
            }
        },
    },
];
