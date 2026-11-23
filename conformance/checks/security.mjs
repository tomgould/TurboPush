// @ts-check
/**
 * Upload IDs and file names: path traversal, dangerous names, and where
 * files end up.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, expectOk, expectStatus, fail, unsafeNameReason } from '../lib/check.mjs';
import { randomBytes } from '../lib/context.mjs';

/** Upload IDs that must be rejected: traversal, separators, bad characters, bad lengths */
const BAD_IDS = [
    '../x', '..', '.', 'a/b', 'a\\b', '/abs', 'a\u0000b', '', 'a'.repeat(201),
    'a%2Fb', '..%2F..%2Fx', '%2e%2e', 'abc\n', ' abc', 'abc ', 'a.b', 'a:b', '\u00e4',
];

/** Non-string upload IDs in JSON requests */
const BAD_JSON_IDS = [123, ['abc'], { id: 'abc' }, true];

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
    const text = String(JSON.stringify(value));
    return text.length > 40 ? text.slice(0, 37) + '..."' : text;
}

/**
 * Uploads one single-chunk file under a given name and reports what happened
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @param {string} fileName Name as sent by the client
 * @param {Buffer} data
 * @returns {Promise<{ rejected: number | null, stored: string | null, response: import('../lib/http.mjs').Response }>}
 *          rejected: the status of a non-200 answer, stored: the name the server returned
 */
async function tryUpload(ctx, fileName, data) {
    const fileId = ctx.id();
    const fields = { fileId, fileName, fileSize: data.length, totalChunks: 1 };
    const chunk = await ctx.chunk({ ...fields, chunkIndex: 0, data });
    if (chunk.status !== 200) {
        return { rejected: chunk.status, stored: null, response: chunk };
    }
    const response = await ctx.finalize(fields);
    if (response.status !== 200) {
        return { rejected: response.status, stored: null, response };
    }
    const stored = response.json && response.json.data ? response.json.data.fileName : null;
    return { rejected: null, stored: typeof stored === 'string' ? stored : null, response };
}

/**
 * Builds the fileId checks for one operation
 *
 * @param {string} operation
 * @param {(ctx: import('../lib/context.mjs').Context, fileId: unknown) => Promise<import('../lib/http.mjs').Response>} send
 * @param {boolean} json Whether the operation is a JSON action (also tries non-string IDs)
 * @returns {import('../lib/check.mjs').Check}
 */
function fileIdCheck(operation, send, json) {
    return {
        id: `fileid.${operation}`,
        severity: 'MUST',
        description: `${operation[0].toUpperCase() + operation.slice(1)} rejects invalid and path-like fileIds with 400`,
        async run(ctx) {
            for (const fileId of json ? [...BAD_IDS, ...BAD_JSON_IDS] : BAD_IDS) {
                expectStatus(await send(ctx, fileId), 400, `${operation} with fileId ${show(fileId)}`);
            }
        },
    };
}

/**
 * Lists directories outside the upload directory where an escaped file could land
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @returns {string[]}
 */
function escapeDirs(ctx) {
    const dirs = new Set([os.tmpdir(), '/tmp', path.parse(process.cwd()).root, process.cwd()]);
    if (ctx.options.uploadDir) {
        dirs.add(path.resolve(ctx.options.uploadDir, '..'));
        dirs.add(path.resolve(ctx.options.uploadDir, '../..'));
        dirs.delete(path.resolve(ctx.options.uploadDir));
    }
    return [...dirs].filter(dir => fs.existsSync(dir));
}

/** @type {import('../lib/check.mjs').Check[]} */
export default [
    fileIdCheck('chunk', (ctx, fileId) => ctx.chunk({
        fileId: /** @type {string} */ (fileId), fileName: 'a.txt', fileSize: 1, totalChunks: 1, chunkIndex: 0, data: randomBytes(1),
    }), false),
    fileIdCheck('finalize', (ctx, fileId) => ctx.finalize({ fileId, fileName: 'a.txt', fileSize: 1, totalChunks: 1 }), true),
    fileIdCheck('status', (ctx, fileId) => ctx.status(fileId), true),
    fileIdCheck('abort', (ctx, fileId) => ctx.abort(fileId), true),
    {
        id: 'fileid.max-length',
        severity: 'MUST',
        description: 'A 200-character fileId using every allowed character class is accepted',
        async run(ctx) {
            const fileId = ('Az09_-' + crypto.randomBytes(100).toString('hex')).slice(0, 200);
            ctx.ids.push(fileId);
            expectOk(await ctx.chunk({ fileId, fileName: ctx.name('longid'), fileSize: 3, totalChunks: 1, chunkIndex: 0, data: randomBytes(3) }),
                'chunk with a 200-character fileId');
            expectOk(await ctx.status(fileId), 'status with a 200-character fileId');
        },
    },
    {
        id: 'filename.traversal',
        severity: 'MUST',
        description: 'Path-like file names are rejected or stored inside the upload directory under a plain name',
        async run(ctx) {
            const dirs = escapeDirs(ctx);
            /** @type {Array<(marker: string) => string>} */
            const payloads = [
                marker => `../../${marker}.txt`,
                marker => `..\\..\\${marker}.txt`,
                marker => `/tmp/${marker}.txt`,
                marker => `C:\\${marker}.txt`,
                marker => `....//....//${marker}.txt`,
                marker => `\\\\server\\share\\${marker}.txt`,
                marker => `..%2F..%2F${marker}.txt`,
                marker => `${marker}/../../x.txt`,
            ];
            for (const payload of payloads) {
                const marker = 'tpcesc' + crypto.randomBytes(5).toString('hex');
                const fileName = payload(marker);
                const data = randomBytes(64);
                const outcome = await tryUpload(ctx, fileName, data);

                if (outcome.rejected !== null) {
                    expect(outcome.rejected >= 400 && outcome.rejected < 500,
                        `${show(fileName)}: expected 200 or a 4xx rejection, got ${describe(outcome.response)}`);
                } else {
                    const reason = unsafeNameReason(outcome.stored);
                    expect(reason === null, `${show(fileName)}: stored as ${show(outcome.stored)}, which ${reason}`);
                    if (ctx.options.uploadDir) {
                        const stored = ctx.readStored(/** @type {string} */ (outcome.stored));
                        expect(stored !== null && stored.equals(data),
                            `${show(fileName)}: "${outcome.stored}" not found in the upload directory with the uploaded bytes`);
                    }
                }

                for (const dir of dirs) {
                    /** @type {string[]} */
                    let entries = [];
                    try {
                        entries = fs.readdirSync(dir);
                    } catch (error) {
                        continue; // Not readable from here
                    }
                    // Without --upload-dir, one of these may be the upload directory
                    const escaped = entries.find(entry => entry.includes(marker)
                        && (ctx.options.uploadDir !== null || entry !== outcome.stored));
                    if (escaped !== undefined) {
                        fail(`${show(fileName)}: file written outside the upload directory: ${path.join(dir, escaped)}`);
                    }
                }
            }
        },
    },
    {
        id: 'filename.dangerous',
        severity: 'MUST',
        description: 'Executable and script names are rejected with 415 or stored under a name that cannot run',
        async run(ctx) {
            const token = 'tpc-' + crypto.randomBytes(4).toString('hex');
            const exact = ['.htaccess', '.htpasswd', '.user.ini', `.${token}.php`];
            const prefixed = [
                'shell.php', 'shell.PHP', 'shell.pHp7', 'shell.php5', 'shell.phtml', 'shell.phar', 'shell.phps',
                'shell.php.', 'shell.php..', 'shell.php ', 'shell.php.jpg', 'shell.PHP.png', 'shell.php5.gif',
                'shell.jpg.php', 'shell.php\u0000.jpg', 'shell.php::$DATA', 'shell.asp', 'shell.aspx', 'shell.jsp',
                'shell.cgi', 'shell.pl', 'shell.shtml', 'shell.inc', 'page.html', 'page.htm', 'page.xhtml',
                'image.svg', 'image.svgz', 'app.hta',
            ].map(name => `${token}-${name}`);

            // A file stored under an unsafe name without being reported is
            // caught by storage.no-stray-files
            for (const fileName of [...exact, ...prefixed]) {
                const outcome = await tryUpload(ctx, fileName, Buffer.from('<?php echo "conformance"; ?>\n'));
                if (outcome.rejected !== null) {
                    expect(outcome.rejected === 415, `${show(fileName)}: expected 415 or a safe stored name, got ${describe(outcome.response)}`);
                    continue;
                }
                const reason = unsafeNameReason(outcome.stored);
                expect(reason === null, `${show(fileName)}: stored as ${show(outcome.stored)}, which ${reason}`);
            }
        },
    },
    {
        id: 'filename.long',
        severity: 'MUST',
        description: 'A very long file name is rejected or stored under a safe name of at most 255 bytes',
        async run(ctx) {
            const fileName = ctx.name('long-' + 'x'.repeat(300));
            const outcome = await tryUpload(ctx, fileName, randomBytes(8));
            if (outcome.rejected !== null) {
                expect(outcome.rejected >= 400 && outcome.rejected < 500, `expected 200 or a 4xx rejection, got ${describe(outcome.response)}`);
                return;
            }
            const reason = unsafeNameReason(outcome.stored);
            expect(reason === null, `stored as ${show(outcome.stored)}, which ${reason}`);
            const length = Buffer.byteLength(/** @type {string} */ (outcome.stored));
            expect(length <= 255, `stored name is ${length} bytes long`);
        },
    },
];
