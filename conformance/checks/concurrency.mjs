// @ts-check
/**
 * Parallel requests: the client sends chunks in parallel and may retry
 * finalize while an earlier attempt is still running.
 */

import { expect, expectOk, sameJson } from '../lib/check.mjs';
import { randomBytes, settleAll, splitChunks } from '../lib/context.mjs';

/** @type {import('../lib/check.mjs').Check[]} */
export default [
    {
        id: 'concurrency.parallel-chunks',
        severity: 'MUST',
        description: 'Chunks of one upload sent all at once are all stored and counted',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('parallel', 'bin');
            const data = randomBytes(16 * 1000);
            const order = [...Array(16).keys()].reverse();
            await ctx.sendChunks({ fileId, fileName, data, order, parallel: true });

            const status = expectOk(await ctx.status(fileId), 'status');
            expect(status.receivedBytes === data.length && sameJson(status.uploadedChunks, [...Array(16).keys()]),
                `status after 16 parallel chunks: receivedBytes ${JSON.stringify(status.receivedBytes)}, uploadedChunks ${JSON.stringify(status.uploadedChunks)}`);

            const result = expectOk(await ctx.finalize({ fileId, fileName, fileSize: data.length, totalChunks: 16 }), 'finalize');
            expect(result.fileSize === data.length, `finalize: fileSize ${JSON.stringify(result.fileSize)}`);
            if (ctx.options.uploadDir) {
                const stored = ctx.readStored(result.fileName);
                expect(stored !== null && stored.equals(data), `stored file "${result.fileName}" does not match the uploaded bytes`);
            }
        },
    },
    {
        id: 'concurrency.same-chunk',
        severity: 'MUST',
        description: 'Concurrent uploads of one chunk with different bytes are all accepted and leave one complete version',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('samechunk', 'bin');
            const variants = Array.from({ length: 6 }, () => randomBytes(4096));
            const responses = await settleAll(variants.map(data => ctx.chunk({
                fileId, fileName, fileSize: 4096, totalChunks: 1, chunkIndex: 0, data,
            })));
            responses.forEach((response, index) => expectOk(response, `concurrent copy ${index + 1} of chunk 0`));

            const status = expectOk(await ctx.status(fileId), 'status');
            expect(status.receivedBytes === 4096, `status: receivedBytes is ${JSON.stringify(status.receivedBytes)}, expected 4096`);

            const result = expectOk(await ctx.finalize({ fileId, fileName, fileSize: 4096, totalChunks: 1 }), 'finalize');
            expect(result.fileSize === 4096, `finalize: fileSize ${JSON.stringify(result.fileSize)}`);
            if (ctx.options.uploadDir) {
                const stored = ctx.readStored(result.fileName);
                expect(stored !== null && variants.some(variant => variant.equals(stored)),
                    `stored file "${result.fileName}" matches none of the copies sent`);
            }
        },
    },
    {
        id: 'finalize.parallel',
        severity: 'MUST',
        description: '8 concurrent finalize requests all succeed with the same result and store one file',
        async run(ctx) {
            const fileId = ctx.id();
            const fileName = ctx.name('race', 'bin');
            const data = randomBytes(20 * 1000);
            await ctx.sendChunks({ fileId, fileName, data });

            const fields = { fileId, fileName, fileSize: data.length, totalChunks: 20 };
            const responses = await settleAll(Array.from({ length: 8 }, () => ctx.finalize(fields)));
            const results = responses.map((response, index) => expectOk(response, `concurrent finalize ${index + 1}`));
            const names = new Set(results.map(result => result.fileName));
            expect(names.size === 1, `concurrent finalize requests returned different names: ${JSON.stringify([...names])}`);
            expect(results.every(result => result.fileSize === data.length), 'a concurrent finalize returned the wrong fileSize');

            if (ctx.options.uploadDir) {
                const base = fileName.replace(/\.bin$/, '');
                const stored = ctx.listUploadDir().filter(entry => entry.startsWith(base));
                expect(stored.length === 1, `expected one stored file, found ${JSON.stringify(stored)}`);
                const contents = ctx.readStored(stored[0]);
                expect(contents !== null && contents.equals(data), `stored file "${stored[0]}" does not match the uploaded bytes`);
            }
        },
    },
    {
        id: 'concurrency.same-name',
        severity: 'MUST',
        description: 'Uploads with the same file name finalized at the same time get distinct stored files',
        async run(ctx) {
            const fileName = ctx.name('samename');
            const uploads = await settleAll(Array.from({ length: 4 }, async () => {
                const fileId = ctx.id();
                const data = randomBytes(1500);
                await ctx.sendChunks({ fileId, fileName, data });
                return { fileId, data, totalChunks: splitChunks(data, 1000).length };
            }));

            const responses = await settleAll(uploads.map(upload => ctx.finalize({
                fileId: upload.fileId, fileName, fileSize: upload.data.length, totalChunks: upload.totalChunks,
            })));
            const names = responses.map((response, index) => expectOk(response, `finalize ${index + 1}`).fileName);
            expect(new Set(names).size === names.length, `stored names are not distinct: ${JSON.stringify(names)}`);

            if (ctx.options.uploadDir) {
                uploads.forEach((upload, index) => {
                    const stored = ctx.readStored(names[index]);
                    expect(stored !== null && stored.equals(upload.data), `stored file "${names[index]}" does not match its upload`);
                });
            }
        },
    },
];
