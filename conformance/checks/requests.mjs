// @ts-check
/**
 * Request validation: methods, actions, content types, fields, integers,
 * upload shape and configured limits.
 */

import { expect, expectOk, expectStatus, skip } from '../lib/check.mjs';
import { randomBytes } from '../lib/context.mjs';
import { header } from '../lib/http.mjs';

/** Values that are not plain non-negative decimal integers */
const BAD_INTEGERS = ['-1', '1e3', '0x10', '3.5', ' 1', '1 ', '+1', '', 'abc', '1,0', '١'];

/**
 * Starts an upload (first of two chunks) so later requests have a real upload to hit
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @returns {Promise<{ fileId: string, fileName: string }>}
 */
async function startUpload(ctx) {
    const fileId = ctx.id();
    const fileName = ctx.name('target', 'bin');
    await ctx.sendChunks({ fileId, fileName, data: randomBytes(2000), order: [0] });
    return { fileId, fileName };
}

/**
 * Fails unless the upload is still in progress
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @param {string} fileId
 * @param {string} after What happened before, for the message
 */
async function expectStillInProgress(ctx, fileId, after) {
    const response = await ctx.status(fileId);
    expect(response.status === 200 && response.json && response.json.data && response.json.data.complete === false,
        `upload was changed or removed after ${after} (status: ${response.status})`);
}

/**
 * Fails unless the server holds nothing for the upload
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @param {string} fileId
 * @param {string} after What happened before, for the message
 */
async function expectNoUpload(ctx, fileId, after) {
    const response = await ctx.status(fileId);
    expect(response.status === 404, `${after} left an upload behind (status: ${response.status})`);
}

/** @type {import('../lib/check.mjs').Check[]} */
export default [
    {
        id: 'method.not-allowed',
        severity: 'MUST',
        description: 'Methods other than POST and OPTIONS are 405 with an Allow header',
        async run(ctx) {
            for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
                const response = await ctx.client.request({ method, label: method });
                expectStatus(response, 405, method);
                const allow = header(response, 'allow').toUpperCase();
                expect(/\bPOST\b/.test(allow), `${method}: Allow header ${JSON.stringify(allow)} does not list POST`);
            }
        },
    },
    {
        id: 'action.unknown',
        severity: 'MUST',
        description: 'An unknown action is 400 (actions are case-sensitive)',
        async run(ctx) {
            const fileId = ctx.id();
            for (const action of ['explode', 'FINALIZE', 'Status', 'abort ', '']) {
                expectStatus(await ctx.json({ action, fileId }), 400, `action ${JSON.stringify(action)}`);
            }
        },
    },
    {
        id: 'action.non-string',
        severity: 'MUST',
        description: 'A non-string action is 400, not treated as a known action',
        async run(ctx) {
            const body = { fileId: ctx.id(), fileName: ctx.name('typed'), fileSize: 1, totalChunks: 1 };
            for (const action of [true, 0, 1, ['finalize'], { name: 'finalize' }]) {
                expectStatus(await ctx.json({ action, ...body }), 400, `action ${JSON.stringify(action)}`);
            }
        },
    },
    {
        id: 'action.content-type',
        severity: 'MUST',
        description: 'JSON actions need Content-Type: application/json, else 415',
        async run(ctx) {
            const { fileId } = await startUpload(ctx);
            expectStatus(await ctx.json({ action: 'status', fileId }, { contentType: 'text/plain' }), 415,
                'status sent as text/plain');
            expectStatus(await ctx.json({ action: 'status', fileId }, { contentType: null }), 415,
                'status sent without Content-Type');
            expectOk(await ctx.json({ action: 'status', fileId }, { contentType: 'application/json; charset=utf-8' }),
                'status sent as application/json; charset=utf-8');
        },
    },
    {
        id: 'action.content-type-exact',
        severity: 'SHOULD',
        description: 'The JSON media type is matched exactly: application/jsonx is 415, case and parameters do not matter',
        async run(ctx) {
            const { fileId } = await startUpload(ctx);
            expectStatus(await ctx.json({ action: 'abort', fileId }, { contentType: 'application/jsonx' }), 415,
                'abort sent as application/jsonx');
            await expectStillInProgress(ctx, fileId, 'an abort sent as application/jsonx');
            for (const contentType of ['application/json; charset=utf-8', 'Application/JSON']) {
                expectOk(await ctx.json({ action: 'status', fileId }, { contentType }), `status sent as ${contentType}`);
            }
        },
    },
    {
        id: 'csrf.simple-requests',
        severity: 'MUST',
        description: 'Actions sent as text/plain, urlencoded or multipart (no preflight) are rejected and do nothing',
        async run(ctx) {
            const { fileId } = await startUpload(ctx);
            const json = JSON.stringify({ action: 'abort', fileId });

            const plain = await ctx.json(json, { contentType: 'text/plain' });
            expectStatus(plain, 415, 'abort sent as text/plain');
            await expectStillInProgress(ctx, fileId, 'an abort sent as text/plain');

            const form = await ctx.json(`action=abort&fileId=${fileId}`, { contentType: 'application/x-www-form-urlencoded' });
            expect(form.status >= 400 && form.status < 500, `abort sent urlencoded: expected 4xx, got ${form.status}`);
            await expectStillInProgress(ctx, fileId, 'an urlencoded abort');

            const formJson = await ctx.json(json, { contentType: 'application/x-www-form-urlencoded' });
            expect(formJson.status >= 400 && formJson.status < 500, `JSON abort sent urlencoded: expected 4xx, got ${formJson.status}`);
            await expectStillInProgress(ctx, fileId, 'a JSON abort sent urlencoded');

            const multi = await ctx.parts([{ name: 'action', value: 'abort' }, { name: 'fileId', value: fileId }], { label: 'multipart abort' });
            expect(multi.status >= 400 && multi.status < 500, `abort sent as multipart: expected 4xx, got ${multi.status}`);
            await expectStillInProgress(ctx, fileId, 'a multipart abort');
        },
    },
    {
        id: 'request.empty',
        severity: 'MUST',
        description: 'An empty POST is 400',
        async run(ctx) {
            expectStatus(await ctx.client.request({ method: 'POST', label: 'empty POST' }), 400, 'empty POST');
            expectStatus(await ctx.json('', { label: 'empty JSON POST' }), 400, 'empty POST with Content-Type: application/json');
        },
    },
    {
        id: 'request.malformed-json',
        severity: 'MUST',
        description: 'Malformed JSON, or JSON that is not an object with an action, is 400',
        async run(ctx) {
            const fileId = ctx.id();
            for (const body of [`{"action": "status", "fileId": "${fileId}"`, '[]', '"status"', '{}', 'null', `{"fileId": "${fileId}"}`]) {
                expectStatus(await ctx.json(body), 400, `body ${body}`);
            }
        },
    },
    {
        id: 'request.json-size-allowed',
        severity: 'MUST',
        description: 'JSON bodies up to 8 KiB are accepted, and unknown JSON fields are ignored',
        async run(ctx) {
            const { fileId } = await startUpload(ctx);
            const body = JSON.stringify({ action: 'status', fileId, extra: { nested: [1, 2, 3] }, pad: 'x'.repeat(8000) });
            expect(body.length <= 8192, 'test body too large');
            expectOk(await ctx.json(body, { label: 'status with unknown fields' }), 'status with unknown fields (8 KiB body)');
        },
    },
    {
        id: 'request.json-too-large',
        severity: 'SHOULD',
        description: 'A JSON body over 64 KiB is 413',
        async run(ctx) {
            const body = JSON.stringify({ action: 'status', fileId: ctx.id(), pad: 'x'.repeat(70000) });
            expectStatus(await ctx.json(body, { label: 'oversized JSON' }), 413, '70 KB JSON body');
        },
    },
    {
        id: 'chunk.missing-fields',
        severity: 'MUST',
        description: 'A chunk without one of the required fields or the file part is 400',
        async run(ctx) {
            const fileId = ctx.id();
            const base = { fileId, fileName: ctx.name('fields'), fileSize: 4, totalChunks: 1, chunkIndex: 0, data: randomBytes(4) };
            for (const field of ['fileId', 'fileName', 'fileSize', 'totalChunks', 'chunkIndex', 'file']) {
                expectStatus(await ctx.chunk({ ...base, omit: [field] }), 400, `chunk without ${field}`);
            }
            const asField = await ctx.chunk({ ...base, omit: ['file'], extra: [{ name: 'file', value: 'abcd' }] });
            expectStatus(asField, 400, 'chunk with "file" as a plain field');
            await expectNoUpload(ctx, fileId, 'the rejected chunks');
        },
    },
    {
        id: 'chunk.multiple-files',
        severity: 'MUST',
        description: 'A chunk request with more than one file (file[]) is 400',
        async run(ctx) {
            const fileId = ctx.id();
            const base = { fileId, fileName: ctx.name('many'), fileSize: 8, totalChunks: 2, chunkIndex: 0, data: randomBytes(4) };
            const two = await ctx.chunk({
                ...base,
                omit: ['file'],
                extra: [
                    { name: 'file[]', filename: 'blob', data: randomBytes(4) },
                    { name: 'file[]', filename: 'blob', data: randomBytes(4) },
                ],
            });
            expectStatus(two, 400, 'chunk with two file[] parts');
            const one = await ctx.chunk({ ...base, omit: ['file'], extra: [{ name: 'file[]', filename: 'blob', data: randomBytes(4) }] });
            expectStatus(one, 400, 'chunk with one file[] part');
            await expectNoUpload(ctx, fileId, 'the rejected chunks');
        },
    },
    {
        id: 'chunk.array-fields',
        severity: 'MUST',
        description: 'Array-style metadata fields (fileId[] and so on) are 400',
        async run(ctx) {
            const fileId = ctx.id();
            const values = { fileId, fileName: ctx.name('arr'), fileSize: '4', totalChunks: '1', chunkIndex: '0' };
            for (const field of Object.keys(values)) {
                const response = await ctx.chunk({
                    ...values,
                    data: randomBytes(4),
                    omit: [field],
                    extra: [{ name: `${field}[]`, value: String(values[/** @type {keyof typeof values} */ (field)]) }],
                });
                expectStatus(response, 400, `chunk with ${field}[]`);
            }
            await expectNoUpload(ctx, fileId, 'the rejected chunks');
        },
    },
    {
        id: 'chunk.unknown-fields',
        severity: 'MUST',
        description: 'Unknown multipart fields are ignored',
        async run(ctx) {
            const fileId = ctx.id();
            const response = await ctx.chunk({
                fileId, fileName: ctx.name('extra'), fileSize: 4, totalChunks: 1, chunkIndex: 0, data: randomBytes(4),
                extra: [{ name: 'checksum', value: 'sha256:abc' }, { name: 'relativePath', value: 'a/b/c.txt' }],
            });
            expectOk(response, 'chunk with unknown fields');
        },
    },
    {
        id: 'chunk.rejected-no-state',
        severity: 'SHOULD',
        description: 'A rejected first chunk leaves no upload behind',
        async run(ctx) {
            const cases = [
                { what: 'a chunk for a huge declared fileSize', fileSize: '999999999999999999', totalChunks: 1, data: randomBytes(1), fileName: ctx.name('huge') },
                { what: 'a chunk larger than fileSize', fileSize: 4, totalChunks: 1, data: randomBytes(5), fileName: ctx.name('over') },
                { what: 'a chunk with a blocked extension', fileSize: 4, totalChunks: 1, data: randomBytes(4), fileName: ctx.name('blocked', 'php') },
            ];
            for (const item of cases) {
                const fileId = ctx.id();
                const response = await ctx.chunk({ fileId, chunkIndex: 0, ...item });
                expect(response.status >= 400, `${item.what} was accepted (${response.status})`);
                await expectNoUpload(ctx, fileId, item.what);
            }
        },
    },
    {
        id: 'integer.chunk-fields',
        severity: 'MUST',
        description: 'fileSize, totalChunks and chunkIndex accept plain decimal digits only',
        async run(ctx) {
            const fileId = ctx.id();
            const base = { fileId, fileName: ctx.name('int'), fileSize: '10', totalChunks: '1', chunkIndex: '0', data: randomBytes(10) };
            for (const field of ['fileSize', 'totalChunks', 'chunkIndex']) {
                for (const value of BAD_INTEGERS) {
                    expectStatus(await ctx.chunk({ ...base, [field]: value }), 400, `chunk with ${field} ${JSON.stringify(value)}`);
                }
            }
            await expectNoUpload(ctx, fileId, 'the rejected chunks');
        },
    },
    {
        id: 'integer.overflow',
        severity: 'MUST',
        description: 'Integers too large to represent are rejected (400 or 413)',
        async run(ctx) {
            const huge = '99999999999999999999999';
            const base = { fileName: ctx.name('overflow'), fileSize: '10', totalChunks: '1', chunkIndex: '0', data: randomBytes(10) };
            for (const field of ['fileSize', 'totalChunks', 'chunkIndex']) {
                const response = await ctx.chunk({ ...base, fileId: ctx.id(), [field]: huge });
                expectStatus(response, [400, 413], `chunk with ${field} ${huge}`);
            }
        },
    },
    {
        id: 'shape.zero-chunks',
        severity: 'MUST',
        description: 'totalChunks 0 is 400',
        async run(ctx) {
            const response = await ctx.chunk({ fileId: ctx.id(), fileName: ctx.name('zero'), fileSize: 10, totalChunks: 0, chunkIndex: 0, data: randomBytes(10) });
            expectStatus(response, 400, 'chunk with totalChunks 0');
        },
    },
    {
        id: 'shape.chunks-exceed-size',
        severity: 'MUST',
        description: 'totalChunks greater than fileSize (more than one chunk for an empty file) is 400',
        async run(ctx) {
            const name = ctx.name('shape');
            expectStatus(await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: 5, totalChunks: 6, chunkIndex: 0, data: randomBytes(1) }),
                400, 'chunk with fileSize 5 and totalChunks 6');
            expectStatus(await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: 0, totalChunks: 2, chunkIndex: 0, data: Buffer.alloc(0) }),
                400, 'chunk with fileSize 0 and totalChunks 2');
        },
    },
    {
        id: 'shape.chunk-index',
        severity: 'MUST',
        description: 'chunkIndex equal to or above totalChunks is 400',
        async run(ctx) {
            const fileId = ctx.id();
            const base = { fileId, fileName: ctx.name('index'), fileSize: 10, totalChunks: 2, data: randomBytes(5) };
            expectStatus(await ctx.chunk({ ...base, chunkIndex: 2 }), 400, 'chunkIndex 2 of 2');
            expectStatus(await ctx.chunk({ ...base, chunkIndex: 7 }), 400, 'chunkIndex 7 of 2');
            await expectNoUpload(ctx, fileId, 'the rejected chunks');
        },
    },
    {
        id: 'shape.too-many-bytes',
        severity: 'MUST',
        description: 'Chunks may not store more bytes than fileSize declares (400, chunk not stored)',
        async run(ctx) {
            const name = ctx.name('bytes');
            expectStatus(await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: 10, totalChunks: 1, chunkIndex: 0, data: randomBytes(11) }),
                400, '11-byte chunk for a 10-byte file');

            const fileId = ctx.id();
            const base = { fileId, fileName: name, fileSize: 10, totalChunks: 2 };
            expectOk(await ctx.chunk({ ...base, chunkIndex: 0, data: randomBytes(6) }), 'first 6-byte chunk of a 10-byte file');
            expectStatus(await ctx.chunk({ ...base, chunkIndex: 1, data: randomBytes(6) }), 400, 'second 6-byte chunk of a 10-byte file');
            const status = expectOk(await ctx.status(fileId), 'status');
            expect(JSON.stringify(status.uploadedChunks) === '[0]' && status.receivedBytes === 6,
                `the rejected chunk was stored: uploadedChunks ${JSON.stringify(status.uploadedChunks)}, receivedBytes ${JSON.stringify(status.receivedBytes)}`);
        },
    },
    {
        id: 'limits.huge-file-size',
        severity: 'MUST',
        description: 'A huge declared fileSize is 413 on the first chunk',
        async run(ctx) {
            const response = await ctx.chunk({
                fileId: ctx.id(), fileName: ctx.name('huge'), fileSize: '999999999999999999', totalChunks: 1, chunkIndex: 0, data: randomBytes(1),
            });
            expectStatus(response, 413, 'chunk declaring fileSize 999999999999999999');
        },
    },
    {
        id: 'limits.chunk-size',
        severity: 'MUST',
        description: 'A chunk of max-chunk-size bytes is accepted and one byte more is 413',
        requires: ['maxChunkSize'],
        async run(ctx) {
            const max = /** @type {number} */ (ctx.options.maxChunkSize);
            const { maxFileSize, maxChunks } = ctx.options;
            if ((maxFileSize !== null && max + 1 > maxFileSize) || (maxChunks !== null && maxChunks < 2)) {
                skip('the oversized chunk cannot be sent without breaking max-file-size or max-chunks');
            }
            const name = ctx.name('chunkmax', 'bin');
            const over = await ctx.chunk({
                fileId: ctx.id(), fileName: name, fileSize: max + 1, totalChunks: 2, chunkIndex: 0, data: randomBytes(max + 1),
                expectRejection: true,
            });
            expectStatus(over, 413, `chunk of ${max + 1} bytes`);
            const exact = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: max, totalChunks: 1, chunkIndex: 0, data: randomBytes(max) });
            expectOk(exact, `chunk of ${max} bytes`);
        },
    },
    {
        id: 'limits.chunks-vs-size',
        severity: 'MUST',
        description: 'fileSize above totalChunks * max-chunk-size is 413',
        requires: ['maxChunkSize'],
        async run(ctx) {
            const max = /** @type {number} */ (ctx.options.maxChunkSize);
            const { maxFileSize, maxChunks } = ctx.options;
            if ((maxFileSize !== null && 2 * max + 1 > maxFileSize) || (maxChunks !== null && maxChunks < 2)) {
                skip('the request cannot be built without breaking max-file-size or max-chunks');
            }
            const name = ctx.name('fit', 'bin');
            const over = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: 2 * max + 1, totalChunks: 2, chunkIndex: 0, data: randomBytes(1) });
            expectStatus(over, 413, `fileSize ${2 * max + 1} in 2 chunks`);
            const exact = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: 2 * max, totalChunks: 2, chunkIndex: 0, data: randomBytes(1) });
            expectOk(exact, `fileSize ${2 * max} in 2 chunks`);
        },
    },
    {
        id: 'limits.file-size',
        severity: 'MUST',
        description: 'A declared fileSize of max-file-size is accepted and one byte more is 413',
        // Without the chunk size, the oversized request could break the
        // fileSize <= totalChunks * max-chunk-size rule instead
        requires: ['maxFileSize', 'maxChunkSize'],
        async run(ctx) {
            const max = /** @type {number} */ (ctx.options.maxFileSize);
            const chunkLimit = /** @type {number} */ (ctx.options.maxChunkSize);
            /** @param {number} size */
            const chunksFor = size => Math.max(1, Math.ceil(size / chunkLimit));
            const name = ctx.name('filemax', 'bin');
            if (ctx.options.maxChunks !== null && chunksFor(max + 1) > ctx.options.maxChunks) {
                skip('the request cannot be built without breaking max-chunks');
            }
            const over = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: max + 1, totalChunks: chunksFor(max + 1), chunkIndex: 0, data: randomBytes(1) });
            expectStatus(over, 413, `fileSize ${max + 1}`);

            const totalChunks = chunksFor(max);
            const exact = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: max, totalChunks, chunkIndex: 0, data: randomBytes(1) });
            expectOk(exact, `fileSize ${max} in ${totalChunks} chunks`);
        },
    },
    {
        id: 'limits.max-chunks',
        severity: 'MUST',
        description: 'totalChunks of max-chunks is accepted and one more is 413',
        requires: ['maxChunks'],
        async run(ctx) {
            const max = /** @type {number} */ (ctx.options.maxChunks);
            if (ctx.options.maxFileSize !== null && max + 1 > ctx.options.maxFileSize) {
                skip('max-chunks + 1 exceeds max-file-size');
            }
            const name = ctx.name('chunksmax', 'bin');
            const over = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: max + 1, totalChunks: max + 1, chunkIndex: 0, data: randomBytes(1) });
            expectStatus(over, 413, `totalChunks ${max + 1}`);
            const exact = await ctx.chunk({ fileId: ctx.id(), fileName: name, fileSize: max, totalChunks: max, chunkIndex: 0, data: randomBytes(1) });
            expectOk(exact, `totalChunks ${max}`);
        },
    },
];
