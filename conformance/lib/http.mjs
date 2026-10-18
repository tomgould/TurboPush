// @ts-check
/**
 * Minimal HTTP client for the conformance suite.
 *
 * Built on node:http and node:https rather than fetch so every header
 * (Origin, Content-Type, Content-Length) and every byte of a multipart body
 * is under the suite's control. Every exchange is recorded for the sweep
 * checks that run at the end.
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

/**
 * @typedef {object} RequestOptions
 * @property {string} [method] HTTP method (default POST)
 * @property {Record<string, string>} [headers] Request headers
 * @property {Buffer | string} [body] Request body
 * @property {string} [label] Short description used in failure messages
 * @property {boolean} [expectContinue] Send Expect: 100-continue and hold the
 *           body back until the server asks for it (or a second passes), so a
 *           server that rejects the request up front never has to read it
 */

/**
 * @typedef {object} Response
 * @property {number} status HTTP status code
 * @property {import('node:http').IncomingHttpHeaders} headers Response headers (lowercase names)
 * @property {string} text Response body as UTF-8 text
 * @property {any} json Parsed JSON body, or undefined if the body is empty or not JSON
 * @property {string} method Request method
 * @property {string} label Request description
 * @property {string} sent Request headers and body as text, to recognise echoed input
 */

/**
 * @typedef {{ name: string, value: string }} FieldPart
 * @typedef {{ name: string, filename: string, data: Buffer, contentType?: string }} FilePart
 * @typedef {FieldPart | FilePart} Part
 */

/**
 * Builds a multipart/form-data body by hand, so field names such as file[]
 * and odd values (NUL bytes, newlines) are sent exactly as given
 *
 * @param {Part[]} parts Fields and files, in order
 * @returns {{ body: Buffer, contentType: string }}
 */
export function multipart(parts) {
    const boundary = '----TurboPushConformance' + crypto.randomBytes(12).toString('hex');
    /** @type {Buffer[]} */
    const buffers = [];
    for (const part of parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
        if ('filename' in part) {
            head += `; filename="${part.filename}"\r\nContent-Type: ${part.contentType || 'application/octet-stream'}`;
        }
        buffers.push(Buffer.from(head + '\r\n\r\n', 'utf8'));
        buffers.push('filename' in part ? part.data : Buffer.from(part.value, 'utf8'));
        buffers.push(Buffer.from('\r\n', 'utf8'));
    }
    buffers.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { body: Buffer.concat(buffers), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class HttpClient {
    /**
     * @param {URL} url Endpoint URL
     * @param {{ timeout?: number, insecure?: boolean }} [options]
     */
    constructor(url, options = {}) {
        this.url = url;
        this.timeout = options.timeout || 30000;
        this.transport = url.protocol === 'https:' ? https : http;
        this.agent = url.protocol === 'https:'
            ? new https.Agent({ keepAlive: false, rejectUnauthorized: !options.insecure })
            : new http.Agent({ keepAlive: false });
        /** @type {Response[]} Every response received, in order */
        this.log = [];
    }

    /**
     * Sends one request to the endpoint
     *
     * @param {RequestOptions} [options]
     * @returns {Promise<Response>}
     */
    request(options = {}) {
        const method = options.method || 'POST';
        const headers = { ...(options.headers || {}) };
        const body = options.body === undefined
            ? undefined
            : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8');
        const hasLength = Object.keys(headers).some(name => name.toLowerCase() === 'content-length');
        if (!hasLength && (body !== undefined || method === 'POST')) {
            headers['Content-Length'] = String(body ? body.length : 0);
        }
        const expectContinue = Boolean(options.expectContinue && body !== undefined && body.length > 0);
        if (expectContinue) {
            headers['Expect'] = '100-continue';
        }

        const sent = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
            + '\n\n' + (body ? body.subarray(0, 262144).toString('latin1') : '');

        return new Promise((resolve, reject) => {
            let settled = false;
            let bodySent = false;
            /** @type {NodeJS.Timeout | undefined} */
            let continueTimer;
            const sendBody = () => {
                clearTimeout(continueTimer);
                if (!bodySent) {
                    bodySent = true;
                    req.end(body);
                }
            };
            const req = this.transport.request(this.url, { method, headers, agent: this.agent }, res => {
                // Answered before the body was asked for: never send it
                clearTimeout(continueTimer);
                const skipBody = !bodySent;
                bodySent = true;
                /** @type {Buffer[]} */
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('error', error => {
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                });
                res.on('end', () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json;
                    if (text !== '') {
                        try {
                            json = JSON.parse(text);
                        } catch (error) {
                            json = undefined;
                        }
                    }
                    /** @type {Response} */
                    const response = {
                        status: res.statusCode || 0,
                        headers: res.headers,
                        text,
                        json,
                        method,
                        label: options.label || method,
                        sent,
                    };
                    this.log.push(response);
                    resolve(response);
                    if (skipBody) {
                        req.destroy();
                    }
                });
            });
            req.setTimeout(this.timeout, () => {
                req.destroy(new Error(`no response within ${this.timeout} ms`));
            });
            req.on('error', error => {
                if (settled) {
                    return;
                }
                // A server may answer early (say 413 for a large chunk) and close
                // before reading the whole body; give its response a moment to arrive
                const code = /** @type {NodeJS.ErrnoException} */ (error).code;
                const early = body !== undefined && (code === 'EPIPE' || code === 'ECONNRESET');
                setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                }, early ? 500 : 0);
            });
            if (expectContinue) {
                // Servers that ignore Expect (PHP's built-in server does) get
                // the body after a second, as curl does
                req.on('continue', sendBody);
                req.flushHeaders();
                continueTimer = setTimeout(sendBody, 1000);
            } else {
                sendBody();
            }
        });
    }
}

/**
 * Returns a response header as a single string ('' if absent)
 *
 * @param {Response} response
 * @param {string} name Header name
 * @returns {string}
 */
export function header(response, name) {
    const value = response.headers[name.toLowerCase()];
    if (value === undefined) {
        return '';
    }
    return Array.isArray(value) ? value.join(', ') : String(value);
}
