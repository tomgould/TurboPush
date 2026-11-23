/**
 * TusMockServer - an in-memory tus 1.0.0 server for testing
 *
 * Replaces global fetch. Implements OPTIONS discovery, creation (POST),
 * HEAD, PATCH, termination (DELETE), concatenation (partial and final
 * uploads) and the checksum extension (sha1/sha256). Honours abort signals,
 * records every request and how many PATCH requests ran at once, and takes
 * interceptors to inject failures.
 *
 * @example
 * ```typescript
 * const server = new TusMockServer({ extensions: ['creation', 'concatenation'] });
 * server.start();
 *
 * // Answer the second PATCH with a 503
 * server.intercept(req => req.method === 'PATCH' ? TusMockServer.response(503) : undefined, 1);
 *
 * server.stop();
 * ```
 */

import { createHash } from 'crypto';

/** Response object with the parts of the fetch Response the client uses */
export interface TusMockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    text: () => Promise<string>;
}

/** A request as seen by the server and its interceptors */
export interface TusMockRequest {
    method: string;
    url: string;
    /** Upload ID for requests to an upload URL */
    id?: string;
    /** Request headers with lowercase names */
    headers: Record<string, string>;
    body?: Blob;
    options?: RequestInit;
}

/** An upload as stored by the server */
export interface TusMockUpload {
    id: string;
    length: number;
    offset: number;
    pieces: Blob[];
    metadata: Record<string, string>;
    partial: boolean;
    final: boolean;
    parts: string[];
}

export interface TusMockOptions {
    /** Extensions announced in Tus-Extension (default: creation, termination) */
    extensions?: string[];
    /** Tus-Max-Size, if any */
    maxSize?: number;
    /** Tus-Checksum-Algorithm values (default: sha1, sha256 when checksum is enabled) */
    checksumAlgorithms?: string[];
    /** Answer OPTIONS with this status instead (default: 204) */
    optionsStatus?: number;
    /** Return Location headers as paths instead of absolute URLs */
    relativeLocation?: boolean;
    /** Latency of every request in ms (default: 5) */
    latency?: number;
}

type Interceptor = (request: TusMockRequest) => TusMockResponse | undefined | Promise<TusMockResponse | undefined>;

/** Base URL of the mock server */
export const TUS_BASE = 'http://localhost/files/';

export class TusMockServer {
    private options: TusMockOptions;
    private requests: TusMockRequest[] = [];
    private uploads: Map<string, TusMockUpload> = new Map();
    private interceptors: { handler: Interceptor; remaining: number }[] = [];
    private nextId = 1;
    private patchesInFlight = 0;
    private maxPatchesInFlight = 0;
    private perUploadInFlight: Map<string, number> = new Map();
    private maxPerUploadInFlight = 0;
    private originalFetch: typeof global.fetch;

    constructor(options: TusMockOptions = {}) {
        this.options = options;
        this.originalFetch = global.fetch;
    }

    /** Builds a response */
    public static response(status: number, headers: Record<string, string | number> = {}, body: string = ''): TusMockResponse {
        const lower: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
            lower[name.toLowerCase()] = String(value);
        }
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 204 ? 'No Content' : 'Error',
            headers: { get: (name: string) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
            text: async () => body
        };
    }

    public start(): void {
        global.fetch = this.fetch.bind(this) as any;
    }

    public stop(): void {
        global.fetch = this.originalFetch;
    }

    /** Endpoint (creation URL) clients should use */
    public getEndpoint(): string {
        return TUS_BASE;
    }

    public setOptions(options: TusMockOptions): void {
        this.options = { ...this.options, ...options };
    }

    /** All requests, optionally only those with this method */
    public getRequests(method?: string): TusMockRequest[] {
        return method ? this.requests.filter(request => request.method === method) : this.requests;
    }

    public getUpload(id: string): TusMockUpload | undefined {
        return this.uploads.get(id);
    }

    public getUploads(): TusMockUpload[] {
        return Array.from(this.uploads.values());
    }

    /** Removes an upload, as if it expired */
    public expire(id: string): void {
        this.uploads.delete(id);
    }

    /** Highest number of PATCH requests in flight at once, across all uploads */
    public getMaxConcurrentPatches(): number {
        return this.maxPatchesInFlight;
    }

    /** Highest number of PATCH requests in flight at once for a single upload */
    public getMaxConcurrentPatchesPerUpload(): number {
        return this.maxPerUploadInFlight;
    }

    /**
     * Adds an interceptor. Return a response to answer the request yourself,
     * or undefined to let the server handle it. Throwing simulates a network
     * error. Answering or throwing counts against `times`.
     */
    public intercept(handler: Interceptor, times: number = Infinity): void {
        this.interceptors.push({ handler, remaining: times });
    }

    /** Stores the first `bytes` bytes of a PATCH body, as a server does when the connection drops mid-request */
    public storePart(request: TusMockRequest, bytes: number): void {
        const upload = this.uploads.get(request.id!)!;
        const piece = request.body!.slice(0, bytes);
        upload.pieces.push(piece);
        upload.offset += piece.size;
    }

    /** Reads an upload's bytes as text */
    public async read(id: string): Promise<string> {
        const upload = this.uploads.get(id);
        if (!upload) {
            throw new Error(`No upload ${id}`);
        }
        return TusMockServer.readText(new Blob(upload.pieces));
    }

    /** Gets the ID from an upload URL */
    public static idOf(url: string): string {
        return url.substring(url.lastIndexOf('/') + 1);
    }

    private async fetch(input: string | URL | Request, options: RequestInit = {}): Promise<TusMockResponse> {
        const url = input.toString();
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries((options.headers || {}) as Record<string, string>)) {
            headers[name.toLowerCase()] = value;
        }
        const method = (options.method || 'GET').toUpperCase();
        const request: TusMockRequest = {
            method,
            url,
            headers,
            options,
            body: options.body instanceof Blob ? options.body : undefined,
            id: url.startsWith(TUS_BASE) && url.length > TUS_BASE.length ? TusMockServer.idOf(url) : undefined
        };
        this.requests.push(request);

        const isPatch = method === 'PATCH';
        if (isPatch && request.id) {
            this.patchesInFlight++;
            this.maxPatchesInFlight = Math.max(this.maxPatchesInFlight, this.patchesInFlight);
            const count = (this.perUploadInFlight.get(request.id) || 0) + 1;
            this.perUploadInFlight.set(request.id, count);
            this.maxPerUploadInFlight = Math.max(this.maxPerUploadInFlight, count);
        }

        try {
            await TusMockServer.wait(this.options.latency ?? 5, options.signal);

            for (const interceptor of this.interceptors) {
                if (interceptor.remaining <= 0) {
                    continue;
                }
                let response: TusMockResponse | undefined;
                try {
                    response = await interceptor.handler(request);
                } catch (error) {
                    interceptor.remaining--; // A thrown error answers the request too
                    throw error;
                }
                if (response) {
                    interceptor.remaining--;
                    return response;
                }
            }

            return await this.handle(request);
        } finally {
            if (isPatch && request.id) {
                this.patchesInFlight--;
                this.perUploadInFlight.set(request.id, this.perUploadInFlight.get(request.id)! - 1);
            }
        }
    }

    private async handle(request: TusMockRequest): Promise<TusMockResponse> {
        const extensions = this.options.extensions ?? ['creation', 'termination'];

        if (request.method === 'OPTIONS') {
            const headers: Record<string, string | number> = {
                'Tus-Resumable': '1.0.0',
                'Tus-Version': '1.0.0',
                'Tus-Extension': extensions.join(',')
            };
            if (this.options.maxSize !== undefined) {
                headers['Tus-Max-Size'] = this.options.maxSize;
            }
            if (extensions.includes('checksum')) {
                headers['Tus-Checksum-Algorithm'] = (this.options.checksumAlgorithms ?? ['sha1', 'sha256']).join(',');
            }
            return TusMockServer.response(this.options.optionsStatus ?? 204, headers);
        }

        if (request.headers['tus-resumable'] !== '1.0.0') {
            return TusMockServer.response(412, { 'Tus-Version': '1.0.0' });
        }

        switch (request.method) {
            case 'POST':
                return this.create(request, extensions);
            case 'HEAD':
                return this.head(request);
            case 'PATCH':
                return this.patch(request, extensions);
            case 'DELETE':
                if (!extensions.includes('termination')) {
                    return TusMockServer.response(405);
                }
                if (!request.id || !this.uploads.delete(request.id)) {
                    return TusMockServer.response(404);
                }
                return TusMockServer.response(204, { 'Tus-Resumable': '1.0.0' });
            default:
                return TusMockServer.response(405);
        }
    }

    private create(request: TusMockRequest, extensions: string[]): TusMockResponse {
        const concat = request.headers['upload-concat'];
        const metadata = TusMockServer.parseMetadata(request.headers['upload-metadata']);
        const id = `u${this.nextId++}`;
        const location = this.options.relativeLocation ? `/files/${id}` : `${TUS_BASE}${id}`;

        if (concat && concat.startsWith('final;')) {
            if (!extensions.includes('concatenation')) {
                return TusMockServer.response(400, {}, 'concatenation not supported');
            }
            const parts = concat.substring(6).trim().split(/\s+/).map(TusMockServer.idOf);
            const pieces: Blob[] = [];
            let length = 0;
            for (const part of parts) {
                const upload = this.uploads.get(part);
                if (!upload) {
                    return TusMockServer.response(404, {}, 'ERR_UPLOAD_NOT_FOUND: partial upload not found');
                }
                if (!upload.partial || upload.offset !== upload.length) {
                    return TusMockServer.response(400, {}, 'ERR_UPLOAD_NOT_FINISHED: partial upload not finished');
                }
                pieces.push(...upload.pieces);
                length += upload.length;
            }
            this.uploads.set(id, { id, length, offset: length, pieces, metadata, partial: false, final: true, parts });
            return TusMockServer.response(201, { Location: location, 'Tus-Resumable': '1.0.0' });
        }

        const lengthHeader = request.headers['upload-length'];
        if (lengthHeader === undefined || !/^[0-9]+$/.test(lengthHeader)) {
            return TusMockServer.response(400, {}, 'ERR_INVALID_UPLOAD_LENGTH: missing or invalid Upload-Length header');
        }
        const length = Number(lengthHeader);
        if (this.options.maxSize !== undefined && length > this.options.maxSize) {
            return TusMockServer.response(413, {}, 'ERR_MAX_SIZE_EXCEEDED: maximum size exceeded');
        }
        const partial = concat === 'partial';
        if (partial && !extensions.includes('concatenation')) {
            return TusMockServer.response(400, {}, 'concatenation not supported');
        }
        this.uploads.set(id, { id, length, offset: 0, pieces: [], metadata, partial, final: false, parts: [] });
        return TusMockServer.response(201, { Location: location, 'Tus-Resumable': '1.0.0' });
    }

    private head(request: TusMockRequest): TusMockResponse {
        const upload = request.id ? this.uploads.get(request.id) : undefined;
        if (!upload) {
            return TusMockServer.response(404);
        }
        return TusMockServer.response(200, {
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': upload.offset,
            'Upload-Length': upload.length,
            'Cache-Control': 'no-store'
        });
    }

    private async patch(request: TusMockRequest, extensions: string[]): Promise<TusMockResponse> {
        const upload = request.id ? this.uploads.get(request.id) : undefined;
        if (!upload) {
            return TusMockServer.response(404, {}, 'ERR_UPLOAD_NOT_FOUND: upload not found');
        }
        if (upload.final) {
            return TusMockServer.response(403, {}, 'ERR_MODIFY_FINAL: modifying a final upload is not allowed');
        }
        if (request.headers['content-type'] !== 'application/offset+octet-stream') {
            return TusMockServer.response(415);
        }
        if (request.headers['upload-offset'] !== String(upload.offset)) {
            return TusMockServer.response(409, {}, 'ERR_MISMATCHED_OFFSET: mismatched offset');
        }
        const body = request.body || new Blob([]);
        if (upload.offset + body.size > upload.length) {
            return TusMockServer.response(400, {}, 'ERR_UPLOAD_SIZE_EXCEEDED: upload\'s size exceeded');
        }

        const checksum = request.headers['upload-checksum'];
        if (checksum !== undefined) {
            if (!extensions.includes('checksum')) {
                return TusMockServer.response(400);
            }
            const [algorithm, expected] = checksum.split(' ');
            if (algorithm !== 'sha1' && algorithm !== 'sha256') {
                return TusMockServer.response(400, {}, 'unsupported checksum algorithm');
            }
            const bytes = Buffer.from(new Uint8Array(await TusMockServer.readBuffer(body)));
            if (createHash(algorithm).update(bytes).digest('base64') !== expected) {
                return TusMockServer.response(460, {}, 'checksum mismatch');
            }
        }

        upload.pieces.push(body);
        upload.offset += body.size;
        return TusMockServer.response(204, { 'Tus-Resumable': '1.0.0', 'Upload-Offset': upload.offset });
    }

    private static parseMetadata(header: string | undefined): Record<string, string> {
        const result: Record<string, string> = {};
        if (!header) {
            return result;
        }
        for (const pair of header.split(',')) {
            const [key, value] = pair.trim().split(' ');
            result[key] = value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8');
        }
        return result;
    }

    private static wait(ms: number, signal?: AbortSignal | null): Promise<void> {
        return new Promise((resolve, reject) => {
            const abortError = () => {
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                return error;
            };
            if (signal?.aborted) {
                reject(abortError());
                return;
            }
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(abortError());
            }, { once: true });
        });
    }

    public static readText(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(blob);
        });
    }

    public static readBuffer(blob: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }
}
