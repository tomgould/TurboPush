// @ts-check
/**
 * Shared state and request helpers for checks.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpClient, multipart } from './http.mjs';
import { expectOk } from './check.mjs';

/**
 * @typedef {object} Options
 * @property {URL} url Endpoint URL
 * @property {number | null} maxFileSize Server's maximum file size, if known
 * @property {number | null} maxChunkSize Server's maximum chunk size, if known
 * @property {number | null} maxChunks Server's maximum chunk count, if known
 * @property {string | null} uploadDir Absolute path of the server's upload directory, if readable
 * @property {string | null} allowedOrigin An origin on the server's CORS allowlist, if any
 * @property {number} timeout Per-request timeout in ms
 * @property {boolean} insecure Skip TLS certificate verification
 */

/**
 * @typedef {object} ChunkRequest
 * @property {string} fileId
 * @property {string} fileName
 * @property {number | string} fileSize
 * @property {number | string} totalChunks
 * @property {number | string} chunkIndex
 * @property {Buffer} data Chunk contents
 * @property {Record<string, string>} [headers] Extra request headers, such as Origin
 * @property {string[]} [omit] Fields to leave out; 'file' leaves out the file part
 * @property {import('./http.mjs').Part[]} [extra] Additional parts, sent before the file
 * @property {string} [label] Request description for failure messages
 * @property {boolean} [expectRejection] The server should refuse the body: send it with Expect: 100-continue
 */

/**
 * @typedef {object} RequestExtras
 * @property {Record<string, string>} [headers] Extra request headers
 * @property {string} [label] Request description for failure messages
 * @property {boolean} [expectRejection] The server should refuse the body: send it with Expect: 100-continue
 */

export class Context {
    /**
     * @param {Options} options
     */
    constructor(options) {
        this.options = options;
        this.url = options.url;
        /** Origin of the endpoint itself, as a browser on the same origin sends it */
        this.origin = options.url.origin;
        this.client = new HttpClient(options.url, { timeout: options.timeout, insecure: options.insecure });
        /** @type {Set<string>} Names the server reported for stored files */
        this.storedNames = new Set();
        /** @type {string[]} Upload IDs created by the running check, aborted after it */
        this.ids = [];
        /** @type {Set<string>} Upload directory entries that existed before the checks ran */
        this.initialEntries = new Set(this.listUploadDir());
    }

    /**
     * Lists the upload directory again after one harmless upload, so files a
     * server creates there on first use (such as an access-control file) are
     * not taken for stray files
     *
     * @returns {Promise<void>}
     */
    async snapshotUploadDir() {
        if (!this.options.uploadDir) {
            return;
        }
        const fileId = 'tpc_' + crypto.randomBytes(8).toString('hex');
        const fields = { fileId, fileName: this.name('warmup'), fileSize: 16, totalChunks: 1 };
        try {
            const chunk = await this.chunk({ ...fields, chunkIndex: 0, data: randomBytes(16), label: 'warm-up chunk' });
            if (chunk.status === 200) {
                await this.finalize(fields, { label: 'warm-up finalize' });
            }
            await this.abort(fileId, { label: 'warm-up abort' });
        } catch (error) {
            // The checks report whatever went wrong
        }
        this.initialEntries = new Set(this.listUploadDir());
    }

    /**
     * Returns a new random upload ID, registered for cleanup
     *
     * @returns {string}
     */
    id() {
        const id = 'tpc_' + crypto.randomBytes(8).toString('hex');
        this.ids.push(id);
        return id;
    }

    /**
     * Returns a unique file name that sanitisation leaves unchanged
     *
     * @param {string} label Part of the name, for recognising it
     * @param {string} [extension] Extension without the dot ('' for none)
     * @returns {string}
     */
    name(label, extension = 'txt') {
        return `tpc-${crypto.randomBytes(4).toString('hex')}-${label}${extension ? '.' + extension : ''}`;
    }

    /**
     * Sends a chunk request with the fields the client sends, in its order
     *
     * @param {ChunkRequest} request
     * @returns {Promise<import('./http.mjs').Response>}
     */
    chunk(request) {
        const omit = request.omit || [];
        /** @type {import('./http.mjs').Part[]} */
        const parts = [];
        /** @type {Array<[string, number | string]>} */
        const fields = [
            ['fileName', request.fileName],
            ['fileId', request.fileId],
            ['chunkIndex', request.chunkIndex],
            ['totalChunks', request.totalChunks],
            ['fileSize', request.fileSize],
        ];
        for (const [name, value] of fields) {
            if (!omit.includes(name)) {
                parts.push({ name, value: String(value) });
            }
        }
        parts.push(...(request.extra || []));
        if (!omit.includes('file')) {
            parts.push({ name: 'file', filename: 'blob', data: request.data });
        }
        return this.parts(parts, {
            headers: request.headers,
            label: request.label || `chunk ${request.chunkIndex}`,
            expectRejection: request.expectRejection,
        });
    }

    /**
     * Sends a hand-built multipart request
     *
     * @param {import('./http.mjs').Part[]} parts
     * @param {RequestExtras} [extras]
     * @returns {Promise<import('./http.mjs').Response>}
     */
    parts(parts, extras = {}) {
        const { body, contentType } = multipart(parts);
        return this.client.request({
            body,
            headers: { 'Content-Type': contentType, ...(extras.headers || {}) },
            label: extras.label || 'multipart request',
            expectContinue: extras.expectRejection,
        });
    }

    /**
     * Sends a JSON request
     *
     * @param {unknown} payload Value to encode, or a string sent as is
     * @param {RequestExtras & { contentType?: string | null }} [extras]
     *        contentType null sends no Content-Type header
     * @returns {Promise<import('./http.mjs').Response>}
     */
    json(payload, extras = {}) {
        const contentType = extras.contentType === undefined ? 'application/json' : extras.contentType;
        /** @type {Record<string, string>} */
        const headers = { ...(extras.headers || {}) };
        if (contentType !== null) {
            headers['Content-Type'] = contentType;
        }
        return this.client.request({
            body: typeof payload === 'string' ? payload : JSON.stringify(payload),
            headers,
            label: extras.label || 'JSON request',
        });
    }

    /**
     * Sends a finalize request and remembers the stored name on success
     *
     * @param {{ fileId: unknown, fileName: unknown, fileSize: unknown, totalChunks: unknown }} fields
     * @param {RequestExtras} [extras]
     * @returns {Promise<import('./http.mjs').Response>}
     */
    async finalize(fields, extras = {}) {
        const response = await this.json({ action: 'finalize', ...fields }, { label: 'finalize', ...extras });
        if (response.status === 200 && response.json && response.json.data
            && typeof response.json.data.fileName === 'string') {
            this.storedNames.add(response.json.data.fileName);
        }
        return response;
    }

    /**
     * Sends a status request
     *
     * @param {unknown} fileId
     * @param {RequestExtras} [extras]
     * @returns {Promise<import('./http.mjs').Response>}
     */
    status(fileId, extras = {}) {
        return this.json({ action: 'status', fileId }, { label: 'status', ...extras });
    }

    /**
     * Sends an abort request
     *
     * @param {unknown} fileId
     * @param {RequestExtras} [extras]
     * @returns {Promise<import('./http.mjs').Response>}
     */
    abort(fileId, extras = {}) {
        return this.json({ action: 'abort', fileId }, { label: 'abort', ...extras });
    }

    /**
     * Uploads every chunk of a file and checks each is accepted
     *
     * @param {object} upload
     * @param {string} upload.fileId
     * @param {string} upload.fileName
     * @param {Buffer} upload.data File contents
     * @param {number} [upload.chunkSize] Chunk size (default 1000)
     * @param {number[]} [upload.order] Order to send the chunks in (default ascending)
     * @param {boolean} [upload.parallel] Send all chunks at once
     * @returns {Promise<number>} Number of chunks
     */
    async sendChunks(upload) {
        const chunks = splitChunks(upload.data, upload.chunkSize || 1000);
        const order = upload.order || chunks.map((_, index) => index);
        /** @param {number} index */
        const send = async index => {
            const response = await this.chunk({
                fileId: upload.fileId,
                fileName: upload.fileName,
                fileSize: upload.data.length,
                totalChunks: chunks.length,
                chunkIndex: index,
                data: chunks[index],
            });
            expectOk(response, `chunk ${index}`);
        };
        if (upload.parallel) {
            await settleAll(order.map(send));
        } else {
            for (const index of order) {
                await send(index);
            }
        }
        return chunks.length;
    }

    /**
     * Uploads and finalizes a whole file, checking every step succeeds
     *
     * @param {object} upload
     * @param {string} upload.fileName
     * @param {Buffer} upload.data File contents
     * @param {string} [upload.fileId] Upload ID (default: a new one)
     * @param {number} [upload.chunkSize] Chunk size (default 1000)
     * @returns {Promise<{ fileId: string, totalChunks: number, result: Record<string, any> }>}
     */
    async upload(upload) {
        const fileId = upload.fileId || this.id();
        const totalChunks = await this.sendChunks({ ...upload, fileId });
        const response = await this.finalize({
            fileId,
            fileName: upload.fileName,
            fileSize: upload.data.length,
            totalChunks,
        });
        return { fileId, totalChunks, result: expectOk(response, 'finalize') };
    }

    /**
     * Reads a stored file from the upload directory
     *
     * @param {string} name Stored name
     * @returns {Buffer | null} Contents, or null if there is no such file
     */
    readStored(name) {
        if (!this.options.uploadDir || /[/\\\0]/.test(name)) {
            return null;
        }
        try {
            return fs.readFileSync(path.join(this.options.uploadDir, name));
        } catch (error) {
            return null;
        }
    }

    /**
     * Lists the upload directory ([] if unknown or missing)
     *
     * @returns {string[]}
     */
    listUploadDir() {
        if (!this.options.uploadDir) {
            return [];
        }
        try {
            return fs.readdirSync(this.options.uploadDir);
        } catch (error) {
            return [];
        }
    }
}

/**
 * Splits file contents into chunks the way the client does: equal sizes
 * with a shorter last chunk, and a single empty chunk for an empty file
 *
 * @param {Buffer} data
 * @param {number} chunkSize
 * @returns {Buffer[]}
 */
export function splitChunks(data, chunkSize) {
    if (data.length === 0) {
        return [Buffer.alloc(0)];
    }
    /** @type {Buffer[]} */
    const chunks = [];
    for (let start = 0; start < data.length; start += chunkSize) {
        chunks.push(data.subarray(start, start + chunkSize));
    }
    return chunks;
}

/**
 * Waits for every promise, then returns their values or throws the first
 * error, so no request is still running when a check ends
 *
 * @template T
 * @param {Promise<T>[]} promises
 * @returns {Promise<T[]>}
 */
export async function settleAll(promises) {
    const results = await Promise.allSettled(promises);
    const failed = results.find(result => result.status === 'rejected');
    if (failed && failed.status === 'rejected') {
        throw failed.reason;
    }
    return results.map(result => /** @type {PromiseFulfilledResult<T>} */ (result).value);
}

/**
 * Returns random bytes
 *
 * @param {number} length
 * @returns {Buffer}
 */
export function randomBytes(length) {
    return crypto.randomBytes(length);
}
