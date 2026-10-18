/**
 * Tests for the tus transport, against an in-memory tus server
 */

import { webcrypto, createHash } from 'crypto';
import { TurboPush, TurboPushError } from '../TurboPush';
import type { TurboPushConfig, UploadResult } from '../TurboPush';
import { TusMockServer, TUS_BASE } from './mocks/TusMockServer';

/** Builds a file whose content shows where each byte belongs */
function patternFile(size: number, name: string = 'pattern.txt', type: string = 'text/plain'): { file: File; content: string } {
    let content = '';
    for (let i = 0; content.length < size; i++) {
        content += `${i},`;
    }
    content = content.substring(0, size);
    return { file: new File([content], name, { type, lastModified: 1000 }), content };
}

/** Resolves after the given number of milliseconds */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Creates a tus uploader with fast retries */
function uploader(server: TusMockServer, config: Partial<TurboPushConfig> = {}): TurboPush {
    return new TurboPush({
        endpoint: server.getEndpoint(),
        protocol: 'tus',
        chunkSize: 100,
        retryDelay: 100,
        maxRetryDelay: 100,
        ...config
    });
}

/** Decodes an Upload-Metadata header */
function metadataOf(header: string | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const pair of (header || '').split(',').filter(Boolean)) {
        const [key, value] = pair.split(' ');
        result[key] = value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8');
    }
    return result;
}

describe('TurboPush tus transport', () => {
    let server: TusMockServer;

    afterEach(() => {
        server?.stop();
    });

    describe('configuration', () => {
        test('rejects an unknown protocol', () => {
            expect(() => new TurboPush({ endpoint: '/x', protocol: 'ftp' as any })).toThrow('protocol must be');
        });

        test('rejects invalid static metadata keys', () => {
            expect(() => new TurboPush({ endpoint: '/x', protocol: 'tus', tus: { metadata: { 'bad key': 'x' } } }))
                .toThrow('invalid tus metadata key "bad key"');
            expect(() => new TurboPush({ endpoint: '/x', protocol: 'tus', tus: { metadata: { 'a,b': 'x' } } }))
                .toThrow('invalid tus metadata key');
        });
    });

    describe('discovery', () => {
        test('sends one OPTIONS request per instance, without Tus-Resumable', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server);

            turbopush.addFile(patternFile(250).file);
            await turbopush.push();
            turbopush.addFile(patternFile(50, 'second.txt').file);
            await turbopush.push();

            const options = server.getRequests('OPTIONS');
            expect(options).toHaveLength(1);
            expect(options[0].url).toBe(TUS_BASE);
            expect(options[0].headers['tus-resumable']).toBeUndefined();
        });

        test('falls back to sequential uploads when OPTIONS fails, and asks again next time', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'], optionsStatus: 404 });
            server.start();
            const turbopush = uploader(server, { maxConcurrentUploads: 4 });

            const { file, content } = patternFile(450);
            turbopush.addFile(file);
            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('POST')).toHaveLength(1);
            expect(server.getRequests('POST')[0].headers['upload-concat']).toBeUndefined();
            expect(await server.read(server.getUploads()[0].id)).toBe(content);

            turbopush.addFile(patternFile(10, 'b.txt').file);
            await turbopush.push();
            expect(server.getRequests('OPTIONS')).toHaveLength(2);
        });

        test('falls back when OPTIONS throws a network error', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'OPTIONS') {
                    throw new Error('offline');
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server);
            turbopush.addFile(patternFile(150).file);

            const stats = await turbopush.push();
            expect(stats.completedFiles).toBe(1);
        });
    });

    describe('sequential uploads (no concatenation)', () => {
        test('creates the upload and sends the chunks in order with the right headers', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server, {
                headers: { Authorization: 'Bearer t', 'Content-Type': 'text/evil' },
                maxConcurrentUploads: 5
            });
            const { file, content } = patternFile(350, 'Ünïcødé файл.txt');
            const completed = jest.fn();

            turbopush.addFile(file).onFileComplete(completed);
            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            const posts = server.getRequests('POST');
            expect(posts).toHaveLength(1);
            expect(posts[0].headers['tus-resumable']).toBe('1.0.0');
            expect(posts[0].headers['upload-length']).toBe('350');
            expect(posts[0].headers.authorization).toBe('Bearer t');
            expect(metadataOf(posts[0].headers['upload-metadata'])).toEqual({
                filename: 'Ünïcødé файл.txt',
                filetype: 'text/plain'
            });

            const patches = server.getRequests('PATCH');
            expect(patches.map(p => p.headers['upload-offset'])).toEqual(['0', '100', '200', '300']);
            for (const patch of patches) {
                expect(patch.headers['content-type']).toBe('application/offset+octet-stream');
                expect(patch.headers['tus-resumable']).toBe('1.0.0');
                expect(patch.headers.authorization).toBe('Bearer t');
                expect(patch.headers['upload-checksum']).toBeUndefined();
            }
            expect(server.getMaxConcurrentPatchesPerUpload()).toBe(1);

            const upload = server.getUploads()[0];
            expect(await server.read(upload.id)).toBe(content);

            const result: UploadResult = completed.mock.calls[0][2];
            expect(result).toEqual({ uploadUrl: `${TUS_BASE}${upload.id}`, fileName: file.name, fileSize: 350 });
            expect(turbopush.getProgress()[0].result).toEqual(result);
        });

        test('uploads several files at once, one request per file at a time', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server, { maxConcurrentUploads: 3 });
            const files = [patternFile(500, 'a.txt'), patternFile(500, 'b.txt'), patternFile(500, 'c.txt')];
            files.forEach(f => turbopush.addFile(f.file));

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(3);
            expect(server.getMaxConcurrentPatches()).toBe(3);
            expect(server.getMaxConcurrentPatchesPerUpload()).toBe(1);
            for (const upload of server.getUploads()) {
                const expected = files.find(f => f.file.name === upload.metadata.filename)!;
                expect(await server.read(upload.id)).toBe(expected.content);
            }
        });

        test('uses no concatenation when tus.parallel is false', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'] });
            server.start();
            const turbopush = uploader(server, { maxConcurrentUploads: 4, tus: { parallel: false } });
            turbopush.addFile(patternFile(400).file);

            await turbopush.push();

            expect(server.getRequests('POST')).toHaveLength(1);
            expect(server.getMaxConcurrentPatchesPerUpload()).toBe(1);
        });

        test('uses no concatenation with maxConcurrentUploads 1 or a single chunk', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'] });
            server.start();
            const one = uploader(server, { maxConcurrentUploads: 1 });
            one.addFile(patternFile(400).file);
            await one.push();
            const small = uploader(server, { maxConcurrentUploads: 4 });
            small.addFile(patternFile(80).file);
            await small.push();

            expect(server.getRequests('POST').every(p => p.headers['upload-concat'] === undefined)).toBe(true);
        });

        test('uploads an empty file with a creation request only', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server);
            const completed = jest.fn();
            turbopush.addFile(new File([], 'empty.txt')).onFileComplete(completed);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('POST')[0].headers['upload-length']).toBe('0');
            expect(server.getRequests('PATCH')).toHaveLength(0);
            expect(completed.mock.calls[0][2].fileSize).toBe(0);
        });

        test('resolves a relative Location against the endpoint', async () => {
            server = new TusMockServer({ relativeLocation: true });
            server.start();
            const turbopush = uploader(server);
            turbopush.addFile(patternFile(150).file);

            await turbopush.push();

            expect(server.getRequests('PATCH')[0].url).toMatch(/^http:\/\/localhost\/files\/u\d+$/);
        });

        test('sends custom metadata from an object or a function', async () => {
            server = new TusMockServer();
            server.start();
            const fromObject = uploader(server, { tus: { metadata: { userId: '42', filename: 'renamed.txt', empty: '' } } });
            fromObject.addFile(patternFile(10, 'a.txt').file);
            await fromObject.push();
            const fromFunction = uploader(server, { tus: { metadata: file => ({ size: String(file.size) }) } });
            fromFunction.addFile(patternFile(10, 'b.txt', '').file);
            await fromFunction.push();

            const [first, second] = server.getRequests('POST');
            expect(first.headers['upload-metadata']).toContain(',empty');
            expect(metadataOf(first.headers['upload-metadata'])).toEqual({
                filename: 'renamed.txt', filetype: 'text/plain', userId: '42', empty: ''
            });
            expect(metadataOf(second.headers['upload-metadata'])).toEqual({ filename: 'b.txt', size: '10' });
        });

        test('reports metadata function errors asynchronously and uses the default metadata', async () => {
            // The errors are rethrown asynchronously; catch them like a page would
            const errors: Error[] = [];
            const listener = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
            window.addEventListener('error', listener);
            server = new TusMockServer();
            server.start();
            try {
                const throwing = uploader(server, {
                    tus: { metadata: file => { throw new Error(`no metadata for ${file.name}`); } }
                });
                throwing.addFile(patternFile(10, 'a.txt').file);
                expect((await throwing.push()).completedFiles).toBe(1);

                const invalid = uploader(server, { tus: { metadata: () => ({ 'bad key': 'x', good: 'y' }) } });
                invalid.addFile(patternFile(10, 'b.txt').file);
                expect((await invalid.push()).completedFiles).toBe(1);
                await delay(10);
            } finally {
                window.removeEventListener('error', listener);
            }

            expect(errors.map(error => error.message)).toEqual([
                'no metadata for a.txt',
                'TurboPush: invalid tus metadata key "bad key"'
            ]);
            const [first, second] = server.getRequests('POST');
            expect(metadataOf(first.headers['upload-metadata'])).toEqual({ filename: 'a.txt', filetype: 'text/plain' });
            expect(metadataOf(second.headers['upload-metadata'])).toEqual({ filename: 'b.txt', filetype: 'text/plain', good: 'y' });
        });

        test('sends credentials when withCredentials is set', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server, { withCredentials: true });
            turbopush.addFile(patternFile(50).file);
            await turbopush.push();

            expect(server.getRequests().every(r => r.options?.credentials === 'include')).toBe(true);
        });
    });

    describe('parallel uploads (concatenation)', () => {
        test('splits the file into partial uploads, sends them in parallel and joins them in order', async () => {
            server = new TusMockServer({ extensions: ['creation', 'termination', 'concatenation'] });
            server.start();
            const turbopush = uploader(server, { maxConcurrentUploads: 3 });
            const { file, content } = patternFile(1050, 'big.bin', 'application/octet-stream');
            const completed = jest.fn();
            turbopush.addFile(file).onFileComplete(completed);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            const posts = server.getRequests('POST');
            const partials = posts.filter(p => p.headers['upload-concat'] === 'partial');
            // 11 chunks over 3 uploads: 3, 4 and 4 chunks
            expect(partials.map(p => p.headers['upload-length'])).toEqual(['300', '400', '350']);
            expect(metadataOf(partials[0].headers['upload-metadata']).filename).toBe('big.bin');

            const final = posts.find(p => (p.headers['upload-concat'] || '').startsWith('final;'))!;
            const partUrls = final.headers['upload-concat'].substring(6).split(' ');
            expect(partUrls).toHaveLength(3);
            expect(metadataOf(final.headers['upload-metadata'])).toEqual({
                filename: 'big.bin', filetype: 'application/octet-stream'
            });

            // Offsets inside each partial upload start at 0
            const byUpload = new Map<string, string[]>();
            for (const patch of server.getRequests('PATCH')) {
                byUpload.set(patch.id!, [...(byUpload.get(patch.id!) || []), patch.headers['upload-offset']]);
            }
            expect(Array.from(byUpload.values())).toEqual(expect.arrayContaining([
                ['0', '100', '200'], ['0', '100', '200', '300'], ['0', '100', '200', '300']
            ]));
            expect(server.getMaxConcurrentPatches()).toBe(3);
            expect(server.getMaxConcurrentPatchesPerUpload()).toBe(1);

            const finalId = TusMockServer.idOf(completed.mock.calls[0][2].uploadUrl);
            expect(server.getUpload(finalId)!.final).toBe(true);
            expect(await server.read(finalId)).toBe(content);
        });

        test('never uses more partial uploads than chunks or the concurrency limit', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'] });
            server.start();
            const turbopush = uploader(server, { maxConcurrentUploads: 10 });
            const { file, content } = patternFile(250);
            turbopush.addFile(file);

            await turbopush.push();

            const partials = server.getRequests('POST').filter(p => p.headers['upload-concat'] === 'partial');
            expect(partials.map(p => p.headers['upload-length'])).toEqual(['100', '100', '50']);
            const final = server.getUploads().find(u => u.final)!;
            expect(await server.read(final.id)).toBe(content);
        });

        test('retries the final request on a server error', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'] });
            server.start();
            server.intercept(req => (req.headers['upload-concat'] || '').startsWith('final;')
                ? TusMockServer.response(503, {}, 'busy') : undefined, 1);
            const turbopush = uploader(server, { maxConcurrentUploads: 2 });
            const retries = jest.fn();
            turbopush.addFile(patternFile(400).file).onRetry(retries);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(retries).toHaveBeenCalledWith(expect.objectContaining({ chunkIndex: null, attempt: 1 }));
            expect(retries.mock.calls[0][0].error.message).toBe('busy');
        });

        test('starts over on the next push() when the partial uploads expired before joining', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'] });
            server.start();
            let expired = false;
            server.intercept(req => {
                if (!expired && (req.headers['upload-concat'] || '').startsWith('final;')) {
                    expired = true;
                    server.getUploads().filter(u => u.partial).forEach(u => server.expire(u.id));
                }
                return undefined;
            });
            const turbopush = uploader(server, { maxConcurrentUploads: 2 });
            const errors = jest.fn();
            const { file, content } = patternFile(400);
            turbopush.addFile(file).onError(errors);

            const first = await turbopush.push();
            expect(first.failedFiles).toBe(1);
            expect(errors.mock.calls[0][0]).toMatchObject({ status: 404 });
            expect(turbopush.getProgress()[0].uploadedSize).toBe(0);
            expect(turbopush.getStats().uploadedBytes).toBe(0);

            const second = await turbopush.push();
            expect(second.completedFiles).toBe(1);
            expect(second.uploadedBytes).toBe(400);
            const final = server.getUploads().find(u => u.final)!;
            expect(await server.read(final.id)).toBe(content);
        });
    });

    describe('failures and recovery', () => {
        test('after a dropped connection, asks for the offset and sends only the rest', async () => {
            server = new TusMockServer();
            server.start();
            let dropped = false;
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '100' && !dropped) {
                    dropped = true;
                    server.storePart(req, 37); // The server kept part of the body
                    throw new Error('Connection reset');
                }
                return undefined;
            });
            const turbopush = uploader(server);
            const retries = jest.fn();
            const { file, content } = patternFile(300);
            turbopush.addFile(file).onRetry(retries);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(retries).toHaveBeenCalledTimes(1);
            expect(retries.mock.calls[0][0].error.code).toBe('network');
            const methods = server.getRequests().filter(r => r.method !== 'OPTIONS')
                .map(r => r.method + (r.headers['upload-offset'] ? ' ' + r.headers['upload-offset'] : ''));
            expect(methods).toEqual(['POST', 'PATCH 0', 'PATCH 100', 'HEAD', 'PATCH 137', 'PATCH 200']);
            expect(server.getRequests('PATCH')[2].body!.size).toBe(63);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
            expect(stats.uploadedBytes).toBe(300);
        });

        test('skips ahead when the server already stored a chunk whose answer was lost', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '0') {
                    server.storePart(req, 100);
                    throw new Error('Response lost');
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server);
            const { file, content } = patternFile(250);
            turbopush.addFile(file);

            await turbopush.push();

            expect(server.getRequests('PATCH').map(p => p.headers['upload-offset'])).toEqual(['0', '100', '200']);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('continues from the offset when the server accepts only part of a PATCH', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '0') {
                    server.storePart(req, 60);
                    return TusMockServer.response(204, { 'Upload-Offset': 60 });
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server);
            const retries = jest.fn();
            const { file, content } = patternFile(150);
            turbopush.addFile(file).onRetry(retries);

            await turbopush.push();

            expect(server.getRequests('PATCH').map(p => p.headers['upload-offset'])).toEqual(['0', '60', '100']);
            expect(retries).not.toHaveBeenCalled();
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('realigns after a 409 offset conflict', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '100'
                ? TusMockServer.response(409, {}, 'ERR_MISMATCHED_OFFSET: mismatched offset') : undefined, 1);
            const turbopush = uploader(server);
            const retries = jest.fn();
            const { file, content } = patternFile(250);
            turbopush.addFile(file).onRetry(retries);

            await turbopush.push();

            expect(retries.mock.calls[0][0].error).toMatchObject({ status: 409, message: 'ERR_MISMATCHED_OFFSET: mismatched offset' });
            expect(server.getRequests('HEAD')).toHaveLength(1);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('retries 5xx, 423 and 429 with backoff', async () => {
            server = new TusMockServer();
            server.start();
            const statuses = [503, 423, 429];
            server.intercept(req => req.method === 'PATCH' && statuses.length
                ? TusMockServer.response(statuses.shift()!) : undefined);
            const turbopush = uploader(server, { maxRetries: 3 });
            const retries = jest.fn();
            turbopush.addFile(patternFile(150).file).onRetry(retries);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(retries.mock.calls.map(c => c[0].error.status)).toEqual([503, 423, 429]);
            expect(retries.mock.calls.map(c => c[0].attempt)).toEqual([1, 2, 3]);
        });

        test('fails straight away on a client error from the creation request', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'POST'
                ? TusMockServer.response(415, {}, '{"message":"Type not allowed"}') : undefined);
            const turbopush = uploader(server);
            const errors = jest.fn();
            turbopush.addFile(patternFile(150).file).onError(errors);

            const stats = await turbopush.push();

            expect(stats.failedFiles).toBe(1);
            const error = errors.mock.calls[0][0];
            expect(error).toBeInstanceOf(TurboPushError);
            expect(error).toMatchObject({ code: 'http', status: 415, retryable: false, message: 'Type not allowed' });
            expect(server.getRequests('POST')).toHaveLength(1);
        });

        test('uses a plain message for HTML or unreadable error bodies', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'POST'
                ? TusMockServer.response(400, {}, '<html>Bad</html>') : undefined, 1);
            server.intercept(req => req.method === 'POST'
                ? TusMockServer.response(400, {}, '{not json') : undefined, 1);
            const errors = jest.fn();
            const turbopush = uploader(server).onError(errors);
            turbopush.addFile(patternFile(10, 'a.txt').file).addFile(patternFile(10, 'b.txt').file);

            await turbopush.push();

            expect(errors.mock.calls.map(c => c[0].message)).toEqual(['HTTP 400: Error', 'HTTP 400: Error']);
        });

        test('fails clearly when the server sends no Location header', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'POST' ? TusMockServer.response(201) : undefined);
            const turbopush = uploader(server);
            const errors = jest.fn();
            turbopush.addFile(patternFile(150).file).onError(errors);

            await turbopush.push();

            expect(errors.mock.calls[0][0]).toMatchObject({ code: 'invalid_response', retryable: false });
            expect(errors.mock.calls[0][0].message).toContain('Access-Control-Expose-Headers');
        });

        test('retries a PATCH answered without a usable Upload-Offset', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'PATCH' ? TusMockServer.response(204) : undefined, 1);
            const turbopush = uploader(server);
            const retries = jest.fn();
            const { file, content } = patternFile(150);
            turbopush.addFile(file).onRetry(retries);

            await turbopush.push();

            expect(retries.mock.calls[0][0].error.code).toBe('invalid_response');
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('retries a HEAD answered without a usable Upload-Offset', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '100'
                ? TusMockServer.response(500) : undefined, 1);
            server.intercept(req => req.method === 'HEAD' ? TusMockServer.response(200) : undefined, 1);
            const turbopush = uploader(server);
            const retries = jest.fn();
            const { file, content } = patternFile(250);
            turbopush.addFile(file).onRetry(retries);

            await turbopush.push();

            expect(retries.mock.calls.map(c => c[0].error.code)).toEqual(['http', 'invalid_response']);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('retries when the offset check itself fails', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '100'
                ? TusMockServer.response(502) : undefined, 1);
            server.intercept(req => req.method === 'HEAD' ? TusMockServer.response(503, {}, 'busy') : undefined, 1);
            const turbopush = uploader(server);
            const retries = jest.fn();
            const { file, content } = patternFile(250);
            turbopush.addFile(file).onRetry(retries);

            await turbopush.push();

            expect(retries.mock.calls.map(c => [c[0].error.status, c[0].error.message])).toEqual([[502, 'HTTP 502: Error'], [503, 'busy']]);
            expect(server.getRequests('HEAD')).toHaveLength(2);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('creates a new upload when the old one is gone', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '200') {
                    server.expire(req.id!);
                    return TusMockServer.response(404, {}, 'ERR_UPLOAD_NOT_FOUND: upload not found');
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server);
            const progress: number[] = [];
            const { file, content } = patternFile(300);
            turbopush.addFile(file).onProgress(p => progress.push(p[0].uploadedSize));

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(stats.uploadedBytes).toBe(300);
            expect(server.getRequests('POST')).toHaveLength(2);
            const upload = server.getUploads()[0];
            expect(await server.read(upload.id)).toBe(content);
            expect(progress).toContain(100); // Progress went back when the data was lost
        });

        test('treats an upload with a different length as gone', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '100'
                ? TusMockServer.response(500) : undefined, 1);
            server.intercept(req => req.method === 'HEAD'
                ? TusMockServer.response(200, { 'Upload-Offset': 100, 'Upload-Length': 999 }) : undefined, 1);
            const turbopush = uploader(server);
            const { file, content } = patternFile(200);
            turbopush.addFile(file);

            await turbopush.push();

            expect(server.getRequests('POST')).toHaveLength(2);
            expect(await server.read(server.getUploads()[1].id)).toBe(content);
        });

        test('re-sends lost data when the server reports a lower offset', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '200') {
                    // The server lost the second chunk
                    const upload = server.getUpload(req.id!)!;
                    upload.pieces = upload.pieces.slice(0, 1);
                    upload.offset = 100;
                    return TusMockServer.response(409, {}, 'mismatched offset');
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server);
            const { file, content } = patternFile(300);
            turbopush.addFile(file);

            const stats = await turbopush.push();

            expect(stats.uploadedBytes).toBe(300);
            expect(server.getRequests('PATCH').map(p => p.headers['upload-offset'])).toEqual(['0', '100', '200', '100', '200']);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('gives up when the server keeps losing the upload, even with retries left', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'PATCH') {
                    server.expire(req.id!);
                    return TusMockServer.response(404);
                }
                return undefined;
            });
            const turbopush = uploader(server, { maxRetries: 10 });
            const errors = jest.fn();
            turbopush.addFile(patternFile(150).file).onError(errors);

            const stats = await turbopush.push();

            expect(stats.failedFiles).toBe(1);
            expect(errors.mock.calls[0][0]).toMatchObject({ code: 'server', message: 'The server keeps losing the upload' });
        });

        test('retries a timed-out PATCH after checking the offset', async () => {
            server = new TusMockServer();
            server.start();
            // A PATCH that never gets an answer (rejected only when the client aborts it)
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '100'
                ? new Promise((resolve, reject) => req.options!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
                : undefined, 1);
            jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
            const turbopush = uploader(server, { timeout: 5000 });
            const retries = jest.fn();
            const { file, content } = patternFile(200);
            turbopush.addFile(file).onRetry(retries);

            const done = turbopush.push();
            await jest.advanceTimersByTimeAsync(6000);
            await jest.runAllTimersAsync();
            await done;

            expect(retries.mock.calls[0][0].error.code).toBe('timeout');
            expect(server.getRequests('HEAD')).toHaveLength(1);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('fails a file larger than Tus-Max-Size without creating an upload', async () => {
            server = new TusMockServer({ maxSize: 100 });
            server.start();
            const turbopush = uploader(server);
            const errors = jest.fn();
            turbopush.addFile(patternFile(150).file).addFile(patternFile(80, 'small.txt').file).onError(errors);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(errors.mock.calls[0][0]).toMatchObject({ code: 'http', status: 413, retryable: false });
            expect(server.getRequests('POST')).toHaveLength(1);
        });

        test('retrying a failed file with push() continues where it stopped', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '200'
                ? TusMockServer.response(500) : undefined, 2);
            const turbopush = uploader(server, { maxRetries: 1 });
            const { file, content } = patternFile(300);
            turbopush.addFile(file);

            const first = await turbopush.push();
            expect(first.failedFiles).toBe(1);
            const second = await turbopush.push();

            expect(second.completedFiles).toBe(1);
            expect(second.failedFiles).toBe(0);
            expect(server.getRequests('POST')).toHaveLength(1);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });
    });

    describe('pause, resume and cancel', () => {
        test('pause aborts the PATCH; resume checks the offset and continues', async () => {
            server = new TusMockServer({ latency: 30 });
            server.start();
            const turbopush = uploader(server);
            // Pause while the PATCH at offset 200 is in flight
            server.intercept(req => req.method === 'PATCH' && req.headers['upload-offset'] === '200'
                ? new Promise((resolve, reject) => {
                    req.options!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
                    turbopush.pause();
                })
                : undefined, 1);
            const { file, content } = patternFile(500);
            turbopush.addFile(file);

            const done = turbopush.push();
            await delay(200);
            expect(turbopush.isPausedState()).toBe(true);
            expect(turbopush.getProgress()[0].status).toBe('paused');
            expect(turbopush.getProgress()[0].uploadedSize).toBe(200);
            const sentWhilePaused = server.getRequests('PATCH').length;
            await delay(100);
            expect(server.getRequests('PATCH')).toHaveLength(sentWhilePaused);

            const resumed = turbopush.resume();
            const stats = await done;
            await resumed;

            expect(stats.completedFiles).toBe(1);
            const methods = server.getRequests().filter(r => r.method !== 'OPTIONS')
                .map(r => r.method + (r.headers['upload-offset'] ? ' ' + r.headers['upload-offset'] : ''));
            expect(methods).toEqual(['POST', 'PATCH 0', 'PATCH 100', 'PATCH 200', 'HEAD', 'PATCH 200', 'PATCH 300', 'PATCH 400']);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('pause while a chunk is being hashed stops before the PATCH', async () => {
            server = new TusMockServer({ extensions: ['creation', 'checksum'] });
            server.start();
            let release: () => void = () => undefined;
            Object.defineProperty(window.crypto, 'subtle', {
                value: { digest: (algorithm: string, data: ArrayBuffer) => new Promise<ArrayBuffer>(resolve => {
                    release = () => resolve(webcrypto.subtle.digest(algorithm, new Uint8Array(data)) as any);
                }) },
                configurable: true
            });
            try {
                const turbopush = uploader(server);
                const { file, content } = patternFile(100);
                turbopush.addFile(file);
                const done = turbopush.push();
                await delay(40);
                turbopush.pause();
                release();
                await delay(40);
                expect(server.getRequests('PATCH')).toHaveLength(0);

                Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
                await turbopush.resume();
                await done;
                expect(await server.read(server.getUploads()[0].id)).toBe(content);
            } finally {
                delete (window.crypto as any).subtle;
            }
        });

        test('cancel deletes the uploads when the server supports termination', async () => {
            server = new TusMockServer({ extensions: ['creation', 'termination', 'concatenation'], latency: 20 });
            server.start();
            const turbopush = uploader(server, { maxConcurrentUploads: 2, headers: { 'X-Token': 'abc' } });
            turbopush.addFile(patternFile(1000).file);

            const done = turbopush.push();
            await delay(120);
            turbopush.cancel();
            const stats = await done;
            await delay(30);

            expect(stats.cancelled).toBe(true);
            const deletes = server.getRequests('DELETE');
            expect(deletes).toHaveLength(2);
            expect(deletes[0].headers['tus-resumable']).toBe('1.0.0');
            expect(deletes[0].headers['x-token']).toBe('abc');
            expect(deletes[0].options?.keepalive).toBe(true);
            expect(server.getUploads()).toHaveLength(0);
            expect(turbopush.getQueueSize()).toBe(0);
        });

        test('cancel sends no DELETE without the termination extension', async () => {
            server = new TusMockServer({ extensions: ['creation'], latency: 20 });
            server.start();
            const turbopush = uploader(server);
            turbopush.addFile(patternFile(1000).file);

            const done = turbopush.push();
            await delay(80);
            turbopush.cancel();
            await done;
            await delay(30);

            expect(server.getRequests('DELETE')).toHaveLength(0);
        });

        test('cancel during discovery settles the session', async () => {
            server = new TusMockServer({ latency: 50 });
            server.start();
            const turbopush = uploader(server);
            turbopush.addFile(patternFile(100).file);

            const done = turbopush.push();
            await delay(10);
            turbopush.cancel();
            const stats = await done;

            expect(stats.cancelled).toBe(true);
            expect(server.getRequests('POST')).toHaveLength(0);
        });

        test('cancel while a chunk is waiting between requests stops it', async () => {
            server = new TusMockServer({ extensions: ['creation', 'checksum'], latency: 5 });
            server.start();
            let release: () => void = () => undefined;
            const subtle = {
                digest: () => new Promise<ArrayBuffer>(resolve => { release = () => resolve(new ArrayBuffer(32)); })
            };
            Object.defineProperty(window.crypto, 'subtle', { value: subtle, configurable: true });
            try {
                const turbopush = uploader(server);
                turbopush.addFile(patternFile(100).file);
                const done = turbopush.push();
                await delay(40); // Hashing the first chunk
                turbopush.cancel();
                release();
                const stats = await done;
                await delay(20);

                expect(stats.cancelled).toBe(true);
                expect(server.getRequests('PATCH')).toHaveLength(0);
            } finally {
                delete (window.crypto as any).subtle;
            }
        });
    });

    describe('checksum extension', () => {
        beforeEach(() => {
            Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
        });

        afterEach(() => {
            delete (window.crypto as any).subtle;
        });

        test('sends a sha256 Upload-Checksum with every PATCH', async () => {
            server = new TusMockServer({ extensions: ['creation', 'checksum'], checksumAlgorithms: ['md5', 'sha1', 'sha256'] });
            server.start();
            const turbopush = uploader(server);
            const { file, content } = patternFile(250);
            turbopush.addFile(file);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            const patches = server.getRequests('PATCH');
            expect(patches).toHaveLength(3);
            const expected = createHash('sha256').update(content.substring(0, 100)).digest('base64');
            expect(patches[0].headers['upload-checksum']).toBe(`sha256 ${expected}`);
        });

        test('falls back to sha1 when that is the only common algorithm', async () => {
            server = new TusMockServer({ extensions: ['creation', 'checksum'], checksumAlgorithms: ['md5', 'sha1'] });
            server.start();
            const turbopush = uploader(server);
            turbopush.addFile(patternFile(50).file);

            await turbopush.push();

            expect(server.getRequests('PATCH')[0].headers['upload-checksum']).toMatch(/^sha1 /);
        });

        test('retries after a 460 checksum mismatch', async () => {
            server = new TusMockServer({ extensions: ['creation', 'checksum'] });
            server.start();
            server.intercept(req => req.method === 'PATCH' ? TusMockServer.response(460, {}, 'checksum mismatch') : undefined, 1);
            const turbopush = uploader(server);
            const retries = jest.fn();
            turbopush.addFile(patternFile(50).file).onRetry(retries);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(retries.mock.calls[0][0].error.status).toBe(460);
        });

        test('sends no checksum when disabled, unsupported, or Web Crypto fails', async () => {
            server = new TusMockServer({ extensions: ['creation', 'checksum'], checksumAlgorithms: ['md5', 'crc32'] });
            server.start();
            const unsupported = uploader(server);
            unsupported.addFile(patternFile(50).file);
            await unsupported.push();

            server.setOptions({ checksumAlgorithms: ['sha256'] });
            const disabled = uploader(server, { tus: { checksum: false } });
            disabled.addFile(patternFile(50).file);
            await disabled.push();

            Object.defineProperty(window.crypto, 'subtle', {
                value: { digest: () => Promise.reject(new Error('not allowed')) }, configurable: true
            });
            const failing = uploader(server);
            failing.addFile(patternFile(50).file);
            await failing.push();

            expect(server.getRequests('PATCH').every(p => p.headers['upload-checksum'] === undefined)).toBe(true);
        });
    });

    describe('resumable mode', () => {
        test('continues an interrupted upload after a reload, from the server offset', async () => {
            server = new TusMockServer({ latency: 20 });
            server.start();
            const { file, content } = patternFile(600);

            // First page load: upload part of the file, then stop
            const first = uploader(server, { resumable: true });
            let stopped = false;
            first.addFile(file).onProgress(progress => {
                if (!stopped && progress[0].uploadedSize >= 300) {
                    stopped = true;
                    first.pause();
                }
            });
            first.push();
            await delay(250);
            const storageKey = `turbopush:tus:${TUS_BASE}:pattern.txt:600:1000`;
            const saved = JSON.parse(localStorage.getItem(storageKey)!);
            expect(saved).toMatchObject({ v: 1, parallel: false, lanes: [{ start: 0, end: 600 }] });
            expect(saved.lanes[0].url).toMatch(/^http:\/\/localhost\/files\/u\d+$/);
            const uploaded = server.getUpload(TusMockServer.idOf(saved.lanes[0].url))!.offset;

            // Second page load: the same file is added again
            const second = uploader(server, { resumable: true });
            const progress: number[] = [];
            second.addFile(file).onProgress(p => progress.push(p[0].uploadedSize));
            const postsBefore = server.getRequests('POST').length;
            const patchesBefore = server.getRequests('PATCH').length;
            const stats = await second.push();

            expect(stats.completedFiles).toBe(1);
            expect(second.getProgress()[0].fileId).toBe(saved.fileId);
            expect(server.getRequests('POST')).toHaveLength(postsBefore);
            const newPatches = server.getRequests('PATCH').slice(patchesBefore);
            expect(newPatches[0].headers['upload-offset']).toBe(String(uploaded));
            expect(progress[0]).toBe(uploaded);
            expect(await server.read(TusMockServer.idOf(saved.lanes[0].url))).toBe(content);
            expect(localStorage.getItem(storageKey)).toBeNull();
        });

        test('restores parallel uploads, continues each part and joins them', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation'], latency: 20 });
            server.start();
            const { file, content } = patternFile(900);

            const first = uploader(server, { resumable: true, maxConcurrentUploads: 3 });
            let stopped = false;
            first.addFile(file).onProgress(progress => {
                if (!stopped && progress[0].uploadedSize >= 300) {
                    stopped = true;
                    first.pause();
                }
            });
            first.push();
            await delay(250);

            const second = uploader(server, { resumable: true, maxConcurrentUploads: 3 });
            second.addFile(file);
            const stats = await second.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('HEAD').length).toBe(3);
            expect(server.getRequests('POST').filter(p => p.headers['upload-concat'] === 'partial')).toHaveLength(3);
            const final = server.getUploads().find(u => u.final)!;
            expect(await server.read(final.id)).toBe(content);
        });

        test('completes without sending data when the server already has everything', async () => {
            server = new TusMockServer();
            server.start();
            const { file, content } = patternFile(200);
            // First page load: the last PATCH reached the server but its answer was lost
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '100') {
                    server.storePart(req, 100);
                    throw new Error('Page closed');
                }
                return undefined;
            }, 1);
            const first = uploader(server, { resumable: true, maxRetries: 0 });
            first.addFile(file);
            expect((await first.push()).failedFiles).toBe(1);

            const second = uploader(server, { resumable: true });
            const completed = jest.fn();
            second.addFile(file).onFileComplete(completed);
            const patchesBefore = server.getRequests('PATCH').length;
            const stats = await second.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('PATCH')).toHaveLength(patchesBefore);
            expect(server.getRequests('POST')).toHaveLength(1);
            expect(completed.mock.calls[0][2].uploadUrl).toBe(`${TUS_BASE}${server.getUploads()[0].id}`);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('starts again when the saved upload no longer exists', async () => {
            server = new TusMockServer();
            server.start();
            const { file, content } = patternFile(200);
            localStorage.setItem(`turbopush:tus:${TUS_BASE}:pattern.txt:200:1000`, JSON.stringify({
                v: 1, fileId: 'old-upload', parallel: false, lanes: [{ url: `${TUS_BASE}gone`, start: 0, end: 200 }]
            }));
            const turbopush = uploader(server, { resumable: true });
            turbopush.addFile(file);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('HEAD')).toHaveLength(1);
            expect(server.getRequests('POST')).toHaveLength(1);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('keeps a saved upload whose HEAD failed and checks it again before sending', async () => {
            server = new TusMockServer();
            server.start();
            const { file, content } = patternFile(200);
            const seed = uploader(server, { resumable: true });
            seed.addFile(file);
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '100') {
                    throw new Error('Page closed');
                }
                return undefined;
            }, 1);
            seed.setMaxRetries(0);
            expect((await seed.push()).failedFiles).toBe(1);

            server.intercept(req => {
                if (req.method === 'HEAD') {
                    throw new Error('offline');
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server, { resumable: true });
            turbopush.addFile(file);
            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('POST')).toHaveLength(1);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('ignores malformed or mismatched saved state', async () => {
            server = new TusMockServer();
            server.start();
            const key = `turbopush:tus:${TUS_BASE}:pattern.txt:200:1000`;
            const bad = [
                'not json',
                JSON.stringify({ v: 2, fileId: 'a', parallel: false, lanes: [{ url: null, start: 0, end: 200 }] }),
                JSON.stringify({ v: 1, fileId: '../x', parallel: false, lanes: [{ url: null, start: 0, end: 200 }] }),
                JSON.stringify({ v: 1, fileId: 'a', parallel: false, lanes: [{ url: 'javascript:alert(1)', start: 0, end: 200 }] }),
                JSON.stringify({ v: 1, fileId: 'a', parallel: false, lanes: [{ url: null, start: 0, end: 199 }] }),
                JSON.stringify({ v: 1, fileId: 'a', parallel: false, lanes: [{ url: null, start: 0, end: 100 }, { url: null, start: 100, end: 200 }] }),
                JSON.stringify({ v: 1, fileId: 'a', parallel: true, lanes: [{ url: null, start: 0, end: 100 }, { url: null, start: 150, end: 200 }] }),
                JSON.stringify({ v: 1, fileId: 'a', parallel: true, lanes: [{ url: null, start: 0, end: 0 }, { url: null, start: 0, end: 200 }] })
            ];
            for (const value of bad) {
                localStorage.setItem(key, value);
                const turbopush = uploader(server, { resumable: true });
                turbopush.addFile(patternFile(200).file);
                expect(turbopush.getProgress()[0].fileId).not.toBe('a');
            }
        });

        test('a second copy of the same file does not take over the first one\'s saved upload', async () => {
            server = new TusMockServer();
            server.start();
            const { file } = patternFile(300);
            const turbopush = uploader(server, { resumable: true });
            const key = `turbopush:tus:${TUS_BASE}:pattern.txt:300:1000`;
            localStorage.setItem(key, JSON.stringify({
                v: 1, fileId: 'first-copy', parallel: false, lanes: [{ url: null, start: 0, end: 300 }]
            }));
            turbopush.addFile(file).addFile(file);
            const [first, second] = turbopush.getProgress();
            expect(first.fileId).toBe('first-copy');
            expect(second.fileId).not.toBe('first-copy');

            await turbopush.push();

            expect(turbopush.getStats().completedFiles).toBe(2);
            expect(localStorage.getItem(key)).toBeNull();
        });

        test('cancel deletes restored uploads that were never checked', async () => {
            server = new TusMockServer({ latency: 30 });
            server.start();
            localStorage.setItem(`turbopush:tus:${TUS_BASE}:pattern.txt:200:1000`, JSON.stringify({
                v: 1, fileId: 'restored', parallel: false, lanes: [{ url: `${TUS_BASE}u999`, start: 0, end: 200 }]
            }));
            const turbopush = uploader(server, { resumable: true });
            turbopush.addFile(patternFile(200).file);
            await turbopush.push().catch(() => undefined); // Learn capabilities (HEAD fails: unknown upload)

            localStorage.setItem(`turbopush:tus:${TUS_BASE}:pattern.txt:200:1000`, JSON.stringify({
                v: 1, fileId: 'restored2', parallel: false, lanes: [{ url: `${TUS_BASE}u998`, start: 0, end: 200 }]
            }));
            turbopush.addFile(patternFile(200).file);
            turbopush.cancel();
            await delay(50);

            expect(server.getRequests('DELETE').map(r => r.url)).toEqual([`${TUS_BASE}u998`]);
        });
    });
    describe('edge cases', () => {
        test('encodes lone surrogates in metadata as U+FFFD', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server);
            turbopush.addFile(new File(['x'], 'bad\uD800name.txt'));

            await turbopush.push();

            expect(metadataOf(server.getRequests('POST')[0].headers['upload-metadata']).filename).toBe('bad\uFFFDname.txt');
        });

        test('the client source parses in older browsers (no regex lookbehind)', () => {
            const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'TurboPush.ts'), 'utf8');
            expect(source).not.toMatch(/\(\?<[=!]/);
        });

        test('push() after the recovery limit was hit starts with a fresh budget', async () => {
            server = new TusMockServer();
            server.start();
            let lose = true;
            server.intercept(req => {
                if (lose && req.method === 'PATCH') {
                    server.expire(req.id!);
                    return TusMockServer.response(404);
                }
                return undefined;
            });
            const turbopush = uploader(server, { maxRetries: 10 });
            const { file, content } = patternFile(150);
            turbopush.addFile(file);

            expect((await turbopush.push()).failedFiles).toBe(1);
            lose = false;
            const second = await turbopush.push();

            expect(second.completedFiles).toBe(1);
            const upload = server.getUploads()[server.getUploads().length - 1];
            expect(await server.read(upload.id)).toBe(content);
        });

        test('a run of a chunk that was taken over by a new session sends nothing', async () => {
            server = new TusMockServer({ extensions: ['creation', 'concatenation', 'checksum'], checksumAlgorithms: ['sha256'] });
            server.start();
            let calls = 0;
            Object.defineProperty(window.crypto, 'subtle', {
                value: {
                    digest: async (algorithm: string, data: ArrayBuffer) => {
                        calls++;
                        if (calls === 2) {
                            await delay(80); // Still hashing when the file fails
                        }
                        return webcrypto.subtle.digest(algorithm, new Uint8Array(data));
                    }
                },
                configurable: true
            });
            try {
                let failOnce = true;
                server.intercept(req => {
                    if (failOnce && req.method === 'PATCH') {
                        failOnce = false;
                        return TusMockServer.response(400, {}, 'bad');
                    }
                    return undefined;
                });
                const turbopush = uploader(server, { maxConcurrentUploads: 2 });
                const { file, content } = patternFile(200);
                turbopush.addFile(file);

                expect((await turbopush.push()).failedFiles).toBe(1);
                const second = await turbopush.push();
                await delay(150);

                expect(second.completedFiles).toBe(1);
                // The failed PATCH, then one per part: the old run of the second part sent nothing
                expect(server.getRequests('PATCH')).toHaveLength(3);
                expect(server.getRequests('HEAD')).toHaveLength(1);
                expect(turbopush.getStats().uploadedBytes).toBe(200);
                const final = server.getUploads().find(u => u.final)!;
                expect(await server.read(final.id)).toBe(content);
            } finally {
                delete (window.crypto as any).subtle;
            }
        });

        test('a creation answer that arrives as the request is paused keeps its upload', async () => {
            server = new TusMockServer();
            server.start();
            const turbopush = uploader(server);
            server.intercept(req => {
                if (req.method === 'POST') {
                    turbopush.pause(); // Aborts the request, but the answer is already here
                    return TusMockServer.response(201, { Location: `${TUS_BASE}kept` });
                }
                return undefined;
            }, 1);
            server.intercept(req => req.method === 'HEAD' && req.id === 'kept'
                ? TusMockServer.response(200, { 'Upload-Offset': 0, 'Upload-Length': 200 }) : undefined);
            server.intercept(req => req.method === 'PATCH' && req.id === 'kept'
                ? TusMockServer.response(204, { 'Upload-Offset': Number(req.headers['upload-offset']) + req.body!.size })
                : undefined);
            turbopush.addFile(patternFile(200).file);

            const done = turbopush.push();
            await delay(50);
            await turbopush.resume();
            const stats = await done;

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('POST')).toHaveLength(1);
            expect(turbopush.getProgress()[0].result!.uploadUrl).toBe(`${TUS_BASE}kept`);
        });

        test('cancel during a creation request deletes the upload it created', async () => {
            server = new TusMockServer({ extensions: ['creation', 'termination'] });
            server.start();
            const turbopush = uploader(server);
            turbopush.addFile(patternFile(200).file);
            await turbopush.push(); // Learn the capabilities
            server.intercept(req => {
                if (req.method === 'POST') {
                    turbopush.cancel();
                    return TusMockServer.response(201, { Location: `${TUS_BASE}orphan` });
                }
                return undefined;
            }, 1);
            turbopush.addFile(patternFile(200, 'b.txt').file);

            const stats = await turbopush.push();
            await delay(20);

            expect(stats.cancelled).toBe(true);
            expect(server.getRequests('DELETE').map(r => r.url)).toEqual([`${TUS_BASE}orphan`]);
        });

        test('a PATCH answered with 403 checks the upload and creates it again', async () => {
            server = new TusMockServer();
            server.start();
            server.intercept(req => {
                if (req.method === 'PATCH' && req.headers['upload-offset'] === '100') {
                    server.expire(req.id!);
                    return TusMockServer.response(403);
                }
                return undefined;
            }, 1);
            const turbopush = uploader(server);
            const { file, content } = patternFile(200);
            turbopush.addFile(file);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(server.getRequests('POST')).toHaveLength(2);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('a timed-out request that made progress does not use up the retries', async () => {
            server = new TusMockServer();
            server.start();
            // A slow connection: every PATCH longer than 25 bytes gets 25 bytes
            // through before it drops, so each chunk needs four attempts
            server.intercept(req => {
                if (req.method === 'PATCH' && req.body!.size > 25) {
                    server.storePart(req, 25);
                    throw new Error('Connection reset');
                }
                return undefined;
            });
            const turbopush = uploader(server, { maxRetries: 1 });
            const { file, content } = patternFile(400);
            turbopush.addFile(file);

            const stats = await turbopush.push();

            expect(stats.completedFiles).toBe(1);
            expect(await server.read(server.getUploads()[0].id)).toBe(content);
        });

        test('a final request the server rejects resets the file, deleting the parts', async () => {
            server = new TusMockServer({ extensions: ['creation', 'termination', 'concatenation'] });
            server.start();
            server.intercept(req => (req.headers['upload-concat'] || '').startsWith('final;')
                ? TusMockServer.response(400, {}, 'bad final request') : undefined, 1);
            const turbopush = uploader(server, { maxConcurrentUploads: 2 });
            const { file, content } = patternFile(400);
            turbopush.addFile(file);

            const first = await turbopush.push();
            await delay(20);
            expect(first.failedFiles).toBe(1);
            expect(server.getRequests('DELETE')).toHaveLength(2);
            expect(turbopush.getStats().uploadedBytes).toBe(0);

            const second = await turbopush.push();
            expect(second.completedFiles).toBe(1);
            const final = server.getUploads().find(u => u.final)!;
            expect(await server.read(final.id)).toBe(content);
        });

        test('a saved parallel plan is dropped when concatenation is no longer used', async () => {
            const key = `turbopush:tus:${TUS_BASE}:pattern.txt:400:1000`;
            const saved = JSON.stringify({
                v: 1, fileId: 'saved', parallel: true,
                lanes: [{ url: `${TUS_BASE}p1`, start: 0, end: 200 }, { url: `${TUS_BASE}p2`, start: 200, end: 400 }]
            });

            // The options now say no parallel uploads
            server = new TusMockServer({ extensions: ['creation', 'termination', 'concatenation'] });
            server.start();
            localStorage.setItem(key, saved);
            const optedOut = uploader(server, { resumable: true, tus: { parallel: false } });
            optedOut.addFile(patternFile(400).file);
            expect((await optedOut.push()).completedFiles).toBe(1);
            await delay(20);
            expect(server.getRequests('HEAD')).toHaveLength(0);
            expect(server.getRequests('DELETE').map(r => r.url)).toEqual([`${TUS_BASE}p1`, `${TUS_BASE}p2`]);
            expect(server.getRequests('POST').every(p => p.headers['upload-concat'] === undefined)).toBe(true);
            server.stop();

            // The server no longer offers concatenation
            server = new TusMockServer({ extensions: ['creation'] });
            server.start();
            localStorage.setItem(key, saved);
            const unsupported = uploader(server, { resumable: true });
            unsupported.addFile(patternFile(400).file);
            expect((await unsupported.push()).completedFiles).toBe(1);
            expect(server.getRequests('HEAD')).toHaveLength(0);
            expect(server.getRequests('POST')).toHaveLength(1);
        });

        test('saved upload URLs on another origin are ignored', () => {
            localStorage.setItem(`turbopush:tus:${TUS_BASE}:pattern.txt:200:1000`, JSON.stringify({
                v: 1, fileId: 'elsewhere', parallel: false, lanes: [{ url: 'https://evil.example/files/x', start: 0, end: 200 }]
            }));
            server = new TusMockServer();
            const turbopush = uploader(server, { resumable: true });
            turbopush.addFile(patternFile(200).file);

            expect(turbopush.getProgress()[0].fileId).not.toBe('elsewhere');
        });
    });
});
