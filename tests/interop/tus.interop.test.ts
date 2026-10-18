/**
 * @jest-environment node
 *
 * Interop tests: the TurboPush client against real tus servers
 *
 * Needs the servers from docker-compose.yml in this folder (npm run interop
 * starts them, runs these tests and stops them again). Every upload is
 * downloaded again and compared byte for byte.
 *
 *   TUSD_URL           default http://localhost:1080/files/  (tusd with concatenation)
 *   TUSD_NOCONCAT_URL  default http://localhost:1081/files/  (tusd -disable-concatenation)
 *   TUS_PHP_URL        default http://localhost:1082/files   (tus-php)
 */

import { createHash, randomBytes } from 'crypto';
import { TurboPush } from '../../TurboPush';
import type { TurboPushConfig, TusOptions, UploadResult } from '../../TurboPush';

/** A tus server under test */
interface Server {
    name: string;
    endpoint: string;
    /** URL that downloads a finished upload */
    download: (uploadUrl: string) => string;
    /** Whether the client is expected to use concatenation (parallel partial uploads) */
    parallel: boolean;
    /** Client options for this server */
    tus?: TusOptions;
    /** Whether the server announces the checksum extension */
    checksum: boolean;
}

const servers: Server[] = [
    {
        name: 'tusd with concatenation',
        endpoint: process.env.TUSD_URL || 'http://localhost:1080/files/',
        download: url => url,
        parallel: true,
        checksum: false
    },
    {
        name: 'tusd without concatenation',
        endpoint: process.env.TUSD_NOCONCAT_URL || 'http://localhost:1081/files/',
        download: url => url,
        parallel: false,
        checksum: false
    },
    {
        // tus-php announces concatenation, but its final request expects upload
        // keys instead of URLs and a whole-file checksum, so use sequential uploads
        name: 'tus-php',
        endpoint: process.env.TUS_PHP_URL || 'http://localhost:1082/files',
        download: url => `${url}/get`,
        parallel: false,
        tus: { parallel: false },
        checksum: true
    }
];

const CHUNK = 256 * 1024;

/** A minimal in-memory localStorage, for resumable mode in Node */
class MemoryStorage {
    private items = new Map<string, string>();
    get length(): number { return this.items.size; }
    key(index: number): string | null { return Array.from(this.items.keys())[index] ?? null; }
    getItem(key: string): string | null { return this.items.has(key) ? this.items.get(key)! : null; }
    setItem(key: string, value: string): void { this.items.set(key, String(value)); }
    removeItem(key: string): void { this.items.delete(key); }
    clear(): void { this.items.clear(); }
}

/** One recorded request */
interface Recorded {
    method: string;
    url: string;
    headers: Record<string, string>;
    status?: number;
    location?: string | null;
    bytes: number;
}

/** Wraps global fetch to record requests, count concurrency and inject failures */
class Recorder {
    public requests: Recorded[] = [];
    public maxPatchesInFlight = 0;
    /** Return true to cut this PATCH off halfway through its body */
    public interrupt: (request: Recorded, index: number) => boolean = () => false;
    /** Delay before each PATCH is sent, in ms, to keep an upload running for a while */
    public patchDelay = 0;
    private patches = 0;
    private inFlight = 0;
    private readonly realFetch = globalThis.fetch;

    install(): void {
        globalThis.fetch = this.fetch.bind(this) as typeof fetch;
    }

    uninstall(): void {
        globalThis.fetch = this.realFetch;
    }

    of(method: string): Recorded[] {
        return this.requests.filter(request => request.method === method);
    }

    private async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
        const method = (init.method || 'GET').toUpperCase();
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries((init.headers || {}) as Record<string, string>)) {
            headers[name.toLowerCase()] = value;
        }
        const body = init.body instanceof Blob ? init.body : null;
        const record: Recorded = { method, url: input.toString(), headers, bytes: body ? body.size : 0 };
        this.requests.push(record);

        let request = init;
        if (method === 'PATCH') {
            if (this.patchDelay > 0) {
                await delay(this.patchDelay);
            }
            this.inFlight++;
            this.maxPatchesInFlight = Math.max(this.maxPatchesInFlight, this.inFlight);
            if (body && body.size > 1 && this.interrupt(record, this.patches++)) {
                // Send the first half of the body, then drop the connection
                const half = new Uint8Array(await body.slice(0, Math.floor(body.size / 2)).arrayBuffer());
                record.bytes = half.length;
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(half);
                        setTimeout(() => controller.error(new Error('Simulated connection drop')), 300);
                    }
                });
                request = { ...init, body: stream, duplex: 'half' } as RequestInit;
            }
        }

        try {
            const response = await this.realFetch(input, request);
            record.status = response.status;
            record.location = response.headers.get('Location');
            return response;
        } finally {
            if (method === 'PATCH') {
                this.inFlight--;
            }
        }
    }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Makes file names unique per run: tus-php stores uploads under the client's file name */
const RUN = randomBytes(4).toString('hex');

/** A file with random content */
function randomFile(size: number, name: string): { file: File; data: Uint8Array } {
    const data = new Uint8Array(randomBytes(size));
    const unique = `${RUN}-${name}`;
    return { file: new File([data], unique, { type: 'application/octet-stream', lastModified: 1700000000000 }), data };
}

/** Downloads a finished upload */
async function download(server: Server, uploadUrl: string): Promise<Uint8Array> {
    const response = await fetch(server.download(uploadUrl));
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
}

/** Waits until the server answers OPTIONS */
async function waitForServer(endpoint: string): Promise<void> {
    const deadline = Date.now() + 90000;
    for (;;) {
        try {
            const response = await fetch(endpoint, { method: 'OPTIONS' });
            if (response.ok) {
                return;
            }
        } catch (error) {
            // Not up yet
        }
        if (Date.now() > deadline) {
            throw new Error(`tus server at ${endpoint} did not come up`);
        }
        await delay(500);
    }
}

describe.each(servers)('$name', (server) => {
    let recorder: Recorder;

    function uploader(config: Partial<TurboPushConfig> = {}): TurboPush {
        return new TurboPush({
            endpoint: server.endpoint,
            protocol: 'tus',
            chunkSize: CHUNK,
            maxConcurrentUploads: 4,
            retryDelay: 200,
            maxRetryDelay: 1000,
            tus: server.tus,
            ...config
        });
    }

    beforeAll(async () => {
        await waitForServer(server.endpoint);
    });

    beforeEach(() => {
        (globalThis as any).localStorage = new MemoryStorage();
        recorder = new Recorder();
        recorder.install();
    });

    afterEach(() => {
        recorder.uninstall();
    });

    test('uploads several files at once, byte for byte', async () => {
        const files = [
            randomFile(5 * CHUNK + 12345, 'big.bin'),
            randomFile(CHUNK - 1, 'one-chunk.bin'),
            randomFile(1, 'tiny.bin')
        ];
        const results = new Map<string, UploadResult>();
        const turbopush = uploader().onFileComplete((name, id, result) => results.set(name, result));
        files.forEach(f => turbopush.addFile(f.file));

        const stats = await turbopush.push();

        expect(stats.completedFiles).toBe(3);
        expect(stats.failedFiles).toBe(0);
        for (const { file, data } of files) {
            const result = results.get(file.name)!;
            expect(result.fileSize).toBe(data.length);
            expect(sha256(await download(server, result.uploadUrl!))).toBe(sha256(data));
        }

        const partials = recorder.of('POST').filter(r => r.headers['upload-concat'] === 'partial');
        const finals = recorder.of('POST').filter(r => (r.headers['upload-concat'] || '').startsWith('final;'));
        if (server.parallel) {
            // big.bin: 6 chunks over 4 partial uploads, joined by one final request
            expect(partials).toHaveLength(4);
            expect(finals).toHaveLength(1);
            expect(recorder.maxPatchesInFlight).toBeGreaterThan(1);
            const head = await fetch(results.get(files[0].file.name)!.uploadUrl!, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
            expect(head.headers.get('Upload-Concat')).toMatch(/^final;/);
        } else {
            expect(partials).toHaveLength(0);
            expect(finals).toHaveLength(0);
            expect(recorder.of('POST')).toHaveLength(3);
        }

        // Checksums are sent whenever the server announces the extension
        const patches = recorder.of('PATCH');
        expect(patches.every(p => (p.headers['upload-checksum'] !== undefined) === server.checksum)).toBe(true);
    });

    test('uploads an empty file', async () => {
        let result: UploadResult | undefined;
        const turbopush = uploader().onFileComplete((name, id, r) => { result = r; });
        turbopush.addFile(new File([], `${RUN}-empty.bin`));

        const stats = await turbopush.push();

        expect(stats.completedFiles).toBe(1);
        expect(recorder.of('PATCH')).toHaveLength(0);
        const head = await fetch(result!.uploadUrl!, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
        expect(head.headers.get('Upload-Length')).toBe('0');
        expect(head.headers.get('Upload-Offset')).toBe('0');
    });

    test('pauses and resumes mid-upload', async () => {
        const { file, data } = randomFile(8 * CHUNK + 999, 'paused.bin');
        let result: UploadResult | undefined;
        let paused = false;
        const turbopush = uploader().onFileComplete((name, id, r) => { result = r; });
        turbopush.addFile(file).onProgress(progress => {
            if (!paused && progress[0].percentage >= 30) {
                paused = true;
                turbopush.pause();
            }
        });

        const done = turbopush.push();
        while (!paused) {
            await delay(10);
        }
        await delay(300);
        const sent = recorder.requests.length;
        await delay(300);
        expect(recorder.requests).toHaveLength(sent); // Nothing is sent while paused
        expect(turbopush.getProgress()[0].status).toBe('paused');

        turbopush.resume();
        const stats = await done;

        expect(stats.completedFiles).toBe(1);
        expect(sha256(await download(server, result!.uploadUrl!))).toBe(sha256(data));
    });

    test('recovers from a connection dropped in the middle of a PATCH', async () => {
        const { file, data } = randomFile(6 * CHUNK + 7, 'dropped.bin');
        recorder.interrupt = (request, index) => index === 2;
        let result: UploadResult | undefined;
        const retries: string[] = [];
        const turbopush = uploader({ maxConcurrentUploads: 1 })
            .onFileComplete((name, id, r) => { result = r; })
            .onRetry(info => retries.push(info.error.code));
        turbopush.addFile(file);

        const stats = await turbopush.push();

        expect(stats.completedFiles).toBe(1);
        expect(retries).toEqual(['network']);
        expect(sha256(await download(server, result!.uploadUrl!))).toBe(sha256(data));

        // After the drop the client asked for the offset and continued from it
        const sequence = recorder.requests.filter(r => r.method !== 'OPTIONS').map(r => r.method);
        expect(sequence.slice(0, 6)).toEqual(['POST', 'PATCH', 'PATCH', 'PATCH', 'HEAD', 'PATCH']);
        const resumedAt = Number(recorder.of('PATCH')[3].headers['upload-offset']);
        expect(resumedAt).toBeGreaterThanOrEqual(2 * CHUNK);
        expect(resumedAt).toBeLessThanOrEqual(2 * CHUNK + CHUNK / 2);
    });

    test('continues an interrupted upload after a reload (resumable)', async () => {
        const { file, data } = randomFile(10 * CHUNK + 4321, 'reload.bin');

        // First page: upload part of the file, then the page goes away
        const first = uploader({ resumable: true });
        let stopped = false;
        first.addFile(file).onProgress(progress => {
            if (!stopped && progress[0].percentage >= 35) {
                stopped = true;
                first.pause();
            }
        });
        first.push();
        while (!stopped) {
            await delay(10);
        }
        await delay(500);
        const saved = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
        const notCreated = saved.lanes.filter((lane: { url: string | null }) => lane.url === null).length;
        const firstBytes = recorder.of('PATCH').reduce((sum, r) => sum + r.bytes, 0);
        const postsBefore = recorder.of('POST').length;
        const patchesBefore = recorder.of('PATCH').length;

        // Second page: the user picks the same file again
        let result: UploadResult | undefined;
        const second = uploader({ resumable: true }).onFileComplete((name, id, r) => { result = r; });
        second.addFile(file);
        const stats = await second.push();

        expect(stats.completedFiles).toBe(1);
        expect(sha256(await download(server, result!.uploadUrl!))).toBe(sha256(data));

        const secondPatches = recorder.of('PATCH').slice(patchesBefore);
        const secondBytes = secondPatches.reduce((sum, r) => sum + r.bytes, 0);
        expect(firstBytes).toBeGreaterThan(0);
        expect(secondBytes).toBeLessThan(data.length);
        expect(recorder.of('HEAD').length).toBeGreaterThanOrEqual(1);
        const newUploads = recorder.of('POST').slice(postsBefore)
            .filter(r => !(r.headers['upload-concat'] || '').startsWith('final;'));
        // Only uploads whose creation the pause cut off are created now
        expect(newUploads).toHaveLength(notCreated);
        expect(notCreated).toBeLessThan(saved.lanes.length);
        expect(localStorage.length).toBe(0);
    });

    test('cancel terminates the upload on the server', async () => {
        const { file } = randomFile(12 * CHUNK, 'cancelled.bin');
        recorder.patchDelay = 100;
        const turbopush = uploader();
        turbopush.addFile(file);

        const done = turbopush.push();
        while (recorder.of('PATCH').filter(r => r.status === 204).length < 2) {
            await delay(10);
        }
        turbopush.cancel();
        const stats = await done;
        expect(stats.cancelled).toBe(true);

        const created = recorder.of('POST').map(r => r.location).filter((url): url is string => !!url);
        expect(created.length).toBeGreaterThan(0);
        for (const url of created) {
            let status = 0;
            for (let attempt = 0; attempt < 50; attempt++) {
                const head = await fetch(url, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
                status = head.status;
                if (status === 404 || status === 410) {
                    break;
                }
                await delay(100);
            }
            expect([404, 410]).toContain(status);
        }
        expect(recorder.of('DELETE').length).toBe(created.length);
    });
});

describe('tus-php with concatenation', () => {
    // tus-php 2.4 looks the parts of a final upload up by upload key rather
    // than by URL and crashes on a spec-compliant request (it answers with a
    // PHP error page and status 200, without a Location). The client must
    // report that as a failed file rather than hang or claim success.
    test('fails cleanly, because its final request does not follow the spec', async () => {
        const endpoint = servers[2].endpoint;
        await waitForServer(endpoint);
        const errors: Error[] = [];
        const turbopush = new TurboPush({
            endpoint,
            protocol: 'tus',
            chunkSize: CHUNK,
            maxConcurrentUploads: 3,
            maxRetries: 1,
            retryDelay: 100
        }).onError(error => errors.push(error));
        turbopush.addFile(randomFile(4 * CHUNK, 'concat.bin').file);

        const stats = await turbopush.push();

        expect(stats.failedFiles).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ name: 'TurboPushError', retryable: false });
    });
});
