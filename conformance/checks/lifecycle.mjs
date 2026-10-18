// @ts-check
/**
 * Upload lifecycle: chunks, finalize, status and abort.
 */

import { expect, expectOk, expectStatus, fail, sameJson, unsafeNameReason } from '../lib/check.mjs';
import { randomBytes } from '../lib/context.mjs';

/**
 * Checks a finalize result and, with --upload-dir, the stored bytes
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @param {Record<string, any>} result Finalize response data
 * @param {Buffer} data Expected contents
 */
function expectStored(ctx, result, data) {
    const reason = unsafeNameReason(result.fileName);
    expect(reason === null, `finalize: data.fileName ${JSON.stringify(result.fileName)} ${reason}`);
    expect(result.fileSize === data.length,
        `finalize: data.fileSize is ${JSON.stringify(result.fileSize)}, expected ${data.length}`);
    if (ctx.options.uploadDir) {
        const stored = ctx.readStored(result.fileName);
        expect(stored !== null, `stored file "${result.fileName}" not found in the upload directory`);
        expect(stored.equals(data), `stored file "${result.fileName}" does not match the uploaded bytes`);
    }
}

/** @type {import('../lib/check.mjs').Check[]} */
export default [
    {
        id: 'upload.single-chunk',
        severity: 'MUST',
        description: 'Single-chunk upload and finalize return the documented data',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('single');
            const data = randomBytes(1500);
            const chunk = await ctx.chunk({ fileId, fileName, fileSize: 1500, totalChunks: 1, chunkIndex: 0, data });
            const chunkData = expectOk(chunk, 'chunk');
            expect(chunkData.chunkIndex === 0 && chunkData.totalChunks === 1,
                `chunk: expected data {chunkIndex: 0, totalChunks: 1}, got ${JSON.stringify(chunkData)}`);
            const response = await ctx.finalize({ fileId, fileName, fileSize: 1500, totalChunks: 1 });
            expectStored(ctx, expectOk(response, 'finalize'), data);
        },
    },
    {
        id: 'upload.keeps-safe-name',
        severity: 'SHOULD',
        description: 'A safe, unused file name is stored unchanged',
        async run(ctx) {
            const fileName = ctx.name('keep');
            const { result } = await ctx.upload({ fileName, data: randomBytes(10) });
            expect(result.fileName === fileName, `stored as "${result.fileName}" instead of "${fileName}"`);
        },
    },
    {
        id: 'upload.multi-chunk',
        severity: 'MUST',
        description: 'Chunks sent out of order are assembled in index order',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('multi', 'bin');
            const data = randomBytes(3500);
            await ctx.sendChunks({ fileId, fileName, data, order: [2, 0, 3, 1] });
            const response = await ctx.finalize({ fileId, fileName, fileSize: 3500, totalChunks: 4 });
            expectStored(ctx, expectOk(response, 'finalize'), data);
        },
    },
    {
        id: 'upload.duplicate-chunk',
        severity: 'MUST',
        description: 'Resending a chunk is harmless and is not counted twice',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('dup', 'bin');
            const data = randomBytes(2000);
            await ctx.sendChunks({ fileId, fileName, data, order: [0, 0, 1, 1, 0] });
            const status = expectOk(await ctx.status(fileId), 'status');
            expect(status.receivedBytes === 2000,
                `status: receivedBytes is ${JSON.stringify(status.receivedBytes)} after resends, expected 2000`);
            const response = await ctx.finalize({ fileId, fileName, fileSize: 2000, totalChunks: 2 });
            expectStored(ctx, expectOk(response, 'finalize'), data);
        },
    },
    {
        id: 'upload.empty-file',
        severity: 'MUST',
        description: 'An empty file is uploaded as one empty chunk',
        async run(ctx) {
            const { result } = await ctx.upload({ fileName: ctx.name('empty'), data: Buffer.alloc(0) });
            expectStored(ctx, result, Buffer.alloc(0));
        },
    },
    {
        id: 'upload.no-overwrite',
        severity: 'MUST',
        description: 'A second upload with the same name never overwrites the first',
        async run(ctx) {
            const fileName = ctx.name('same');
            const first = randomBytes(100);
            const second = randomBytes(100);
            const a = await ctx.upload({ fileName, data: first });
            const b = await ctx.upload({ fileName, data: second });
            expect(a.result.fileName !== b.result.fileName,
                `both uploads were stored as "${a.result.fileName}"`);
            expectStored(ctx, a.result, first);
            expectStored(ctx, b.result, second);
        },
    },
    {
        id: 'status.unknown',
        severity: 'MUST',
        description: 'Status of an unknown upload is 404',
        async run(ctx) {
            expectStatus(await ctx.status(ctx.id()), 404, 'status of an unknown upload');
        },
    },
    {
        id: 'status.in-progress',
        severity: 'MUST',
        description: 'Status of an upload in progress lists the stored chunks and bytes',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('progress', 'bin');
            const data = randomBytes(2500);
            await ctx.sendChunks({ fileId, fileName, data, order: [2, 0] });

            const status = expectOk(await ctx.status(fileId), 'status');
            const expected = { complete: false, fileSize: 2500, totalChunks: 3, receivedBytes: 1500, uploadedChunks: [0, 2] };
            for (const [key, value] of Object.entries(expected)) {
                expect(sameJson(status[key], value),
                    `status: ${key} is ${JSON.stringify(status[key])}, expected ${JSON.stringify(value)}`);
            }
            expect(typeof status.fileName === 'string', 'status: fileName missing');

            await ctx.sendChunks({ fileId, fileName, data, order: [1] });
            const after = expectOk(await ctx.status(fileId), 'status after the last chunk');
            expect(sameJson(after.uploadedChunks, [0, 1, 2]) && after.receivedBytes === 2500,
                `status after the last chunk: uploadedChunks ${JSON.stringify(after.uploadedChunks)}, receivedBytes ${JSON.stringify(after.receivedBytes)}`);
            expect(after.complete === false, 'status: complete is not false before finalize');
        },
    },
    {
        id: 'status.complete',
        severity: 'MUST',
        description: 'Status of a finalized upload is complete and repeats the result',
        async run(ctx) {
            const { fileId, result } = await ctx.upload({ fileName: ctx.name('done'), data: randomBytes(1200) });
            const status = expectOk(await ctx.status(fileId), 'status');
            expect(status.complete === true, `status: complete is ${JSON.stringify(status.complete)}, expected true`);
            expect(status.fileName === result.fileName && status.fileSize === result.fileSize,
                `status: fileName/fileSize ${JSON.stringify([status.fileName, status.fileSize])} differ from finalize ${JSON.stringify([result.fileName, result.fileSize])}`);
        },
    },
    {
        id: 'finalize.missing-chunks',
        severity: 'MUST',
        description: 'Finalize with missing chunks is 409 and lists them in data.missingChunks',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('missing', 'bin');
            const data = randomBytes(2500);
            await ctx.sendChunks({ fileId, fileName, data, order: [1] });

            const response = await ctx.finalize({ fileId, fileName, fileSize: 2500, totalChunks: 3 });
            expectStatus(response, 409, 'finalize with chunks 0 and 2 missing');
            const missing = response.json && response.json.data ? response.json.data.missingChunks : undefined;
            expect(sameJson(missing, [0, 2]), `data.missingChunks is ${JSON.stringify(missing)}, expected [0,2]`);

            await ctx.sendChunks({ fileId, fileName, data, order: [0, 2] });
            const retry = await ctx.finalize({ fileId, fileName, fileSize: 2500, totalChunks: 3 });
            expectStored(ctx, expectOk(retry, 'finalize after sending the missing chunks'), data);
        },
    },
    {
        id: 'finalize.size-mismatch',
        severity: 'MUST',
        description: 'Finalize is 409 when the stored bytes do not add up to fileSize',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('short');
            expectOk(await ctx.chunk({ fileId, fileName, fileSize: 10, totalChunks: 1, chunkIndex: 0, data: randomBytes(6) }),
                'chunk of 6 bytes for a 10-byte file');
            expectStatus(await ctx.finalize({ fileId, fileName, fileSize: 10, totalChunks: 1 }), 409,
                'finalize with 6 of 10 bytes');
        },
    },
    {
        id: 'finalize.idempotent',
        severity: 'MUST',
        description: 'Repeating finalize returns the same result and stores one file',
        async run(ctx) {
            const fileName = ctx.name('again');
            const data = randomBytes(2100);
            const { fileId, totalChunks, result } = await ctx.upload({ fileName, data });
            for (let attempt = 1; attempt <= 2; attempt++) {
                const repeat = expectOk(await ctx.finalize({ fileId, fileName, fileSize: 2100, totalChunks }),
                    `repeated finalize #${attempt}`);
                expect(sameJson(repeat, result),
                    `repeated finalize returned ${JSON.stringify(repeat)}, first returned ${JSON.stringify(result)}`);
            }
            if (ctx.options.uploadDir) {
                const base = fileName.replace(/\.txt$/, '');
                const stored = ctx.listUploadDir().filter(entry => entry.startsWith(base));
                expect(stored.length === 1, `expected one stored file, found ${JSON.stringify(stored)}`);
            }
        },
    },
    {
        id: 'finalize.unknown',
        severity: 'MUST',
        description: 'Finalize of an unknown upload is 404',
        async run(ctx) {
            const response = await ctx.finalize({ fileId: ctx.id(), fileName: ctx.name('ghost'), fileSize: 10, totalChunks: 1 });
            expectStatus(response, 404, 'finalize of an unknown upload');
        },
    },
    {
        id: 'finalize.fields',
        severity: 'MUST',
        description: 'Finalize with a missing or malformed field is 400',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('fields', 'bin');
            const data = randomBytes(2000);
            await ctx.sendChunks({ fileId, fileName, data });
            const valid = { fileId, fileName, fileSize: 2000, totalChunks: 2 };

            /** @type {Array<[string, Record<string, unknown>]>} */
            const variants = [];
            for (const field of ['fileId', 'fileName', 'fileSize', 'totalChunks']) {
                /** @type {Record<string, unknown>} */
                const without = { ...valid };
                delete without[field];
                variants.push([`without ${field}`, without]);
            }
            for (const value of ['', '   ', 123, ['a.bin'], null]) {
                variants.push([`fileName ${JSON.stringify(value)}`, { ...valid, fileName: value }]);
            }
            for (const value of [-1, 3.5, '1e3', '0x10', ' 2000', '2000 ', '+2000', '', true, [2000], {}]) {
                variants.push([`fileSize ${JSON.stringify(value)}`, { ...valid, fileSize: value }]);
            }
            for (const value of [0, -1, 1.5, '2 ', '0x2', true, [2]]) {
                variants.push([`totalChunks ${JSON.stringify(value)}`, { ...valid, totalChunks: value }]);
            }
            for (const value of [123, [fileId], { id: fileId }, true]) {
                variants.push([`fileId ${JSON.stringify(value)}`, { ...valid, fileId: value }]);
            }

            for (const [what, body] of variants) {
                expectStatus(await ctx.json({ action: 'finalize', ...body }, { label: 'finalize' }), 400, `finalize ${what}`);
            }

            const response = await ctx.finalize(valid);
            expectStored(ctx, expectOk(response, 'valid finalize after the malformed ones'), data);
        },
    },
    {
        id: 'metadata.chunk-mismatch',
        severity: 'MUST',
        description: 'A chunk whose fileName, fileSize or totalChunks differ from earlier chunks is 409',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('meta', 'bin');
            const data = randomBytes(2000);
            await ctx.sendChunks({ fileId, fileName, data, order: [0] });
            const second = data.subarray(1000);
            const base = { fileId, fileName, fileSize: 2000, totalChunks: 2, chunkIndex: 1, data: second };

            expectStatus(await ctx.chunk({ ...base, fileName: ctx.name('other', 'bin') }), 409, 'chunk with another fileName');
            expectStatus(await ctx.chunk({ ...base, fileSize: 2001 }), 409, 'chunk with another fileSize');
            expectStatus(await ctx.chunk({ ...base, totalChunks: 3 }), 409, 'chunk with another totalChunks');

            expectOk(await ctx.chunk(base), 'matching chunk');
            expectStored(ctx, expectOk(await ctx.finalize({ fileId, fileName, fileSize: 2000, totalChunks: 2 }), 'finalize'), data);
        },
    },
    {
        id: 'metadata.finalize-mismatch',
        severity: 'MUST',
        description: 'Finalize whose metadata differs from the chunks is 409, before and after completion',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('fmeta', 'bin');
            const data = randomBytes(2000);
            await ctx.sendChunks({ fileId, fileName, data });
            const valid = { fileId, fileName, fileSize: 2000, totalChunks: 2 };

            expectStatus(await ctx.finalize({ ...valid, fileName: ctx.name('other', 'bin') }), 409, 'finalize with another fileName');
            expectStatus(await ctx.finalize({ ...valid, fileSize: 2001 }), 409, 'finalize with another fileSize');
            expectStatus(await ctx.finalize({ ...valid, totalChunks: 3 }), 409, 'finalize with another totalChunks');

            const result = expectOk(await ctx.finalize(valid), 'matching finalize');
            expectStored(ctx, result, data);

            expectStatus(await ctx.finalize({ ...valid, fileName: ctx.name('other', 'bin') }), 409,
                'repeated finalize with another fileName');
            expectStatus(await ctx.finalize({ ...valid, fileSize: 1999 }), 409, 'repeated finalize with another fileSize');
        },
    },
    {
        id: 'chunk.after-finalize',
        severity: 'MUST',
        description: 'A chunk for a finalized upload is 409',
        async run(ctx) {
            const fileName = ctx.name('late', 'bin');
            const data = randomBytes(2000);
            const { fileId } = await ctx.upload({ fileName, data });
            for (const chunkIndex of [0, 1]) {
                const response = await ctx.chunk({
                    fileId, fileName, fileSize: 2000, totalChunks: 2, chunkIndex, data: data.subarray(chunkIndex * 1000, chunkIndex * 1000 + 1000),
                });
                expectStatus(response, 409, `chunk ${chunkIndex} after finalize`);
            }
            const status = expectOk(await ctx.status(fileId), 'status');
            expect(status.complete === true, 'status is no longer complete after the rejected chunks');
        },
    },
    {
        id: 'abort.removes-upload',
        severity: 'MUST',
        description: 'Abort deletes the upload: status and finalize are 404 afterwards',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('abort', 'bin');
            const data = randomBytes(2000);
            await ctx.sendChunks({ fileId, fileName, data });
            const response = await ctx.abort(fileId);
            expectOk(response, 'abort');
            expectStatus(await ctx.status(fileId), 404, 'status after abort');
            expectStatus(await ctx.finalize({ fileId, fileName, fileSize: 2000, totalChunks: 2 }), 404, 'finalize after abort');
        },
    },
    {
        id: 'abort.unknown',
        severity: 'MUST',
        description: 'Abort of an unknown upload succeeds, repeatedly',
        async run(ctx) {
            const fileId = ctx.id();
            expectOk(await ctx.abort(fileId), 'abort of an unknown upload');
            expectOk(await ctx.abort(fileId), 'second abort');
        },
    },
    {
        id: 'abort.keeps-stored-file',
        severity: 'MUST',
        description: 'Abort after finalize does not delete the stored file',
        requires: ['uploadDir'],
        async run(ctx) {
            const data = randomBytes(500);
            const { fileId, result } = await ctx.upload({ fileName: ctx.name('kept'), data });
            expectOk(await ctx.abort(fileId), 'abort after finalize');
            const stored = ctx.readStored(result.fileName);
            if (stored === null || !stored.equals(data)) {
                fail(`stored file "${result.fileName}" was removed or changed by abort`);
            }
        },
    },
];
