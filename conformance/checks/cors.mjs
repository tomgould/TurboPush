// @ts-check
/**
 * Origin checks and CORS headers.
 */

import { expect, expectOk, expectStatus } from '../lib/check.mjs';
import { randomBytes } from '../lib/context.mjs';
import { header } from '../lib/http.mjs';

/** An origin no conformance setup allows */
const FOREIGN = 'https://foreign.conformance.test';

/**
 * Fails if the response carries Access-Control-Allow-Origin
 *
 * @param {import('../lib/http.mjs').Response} response
 * @param {string} what
 */
function expectNoAllowOrigin(response, what) {
    const value = header(response, 'access-control-allow-origin');
    expect(value === '', `${what}: sends Access-Control-Allow-Origin: ${value}`);
}

/**
 * Sends a CORS preflight
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @param {string} origin
 * @param {string} [requestHeaders] Access-Control-Request-Headers value
 * @returns {Promise<import('../lib/http.mjs').Response>}
 */
function preflight(ctx, origin, requestHeaders = 'content-type') {
    return ctx.client.request({
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': requestHeaders },
        label: `preflight from ${origin}`,
    });
}

/**
 * Checks whether a comma-separated header value lists a token (case-insensitive)
 *
 * @param {string} value
 * @param {string} token
 * @returns {boolean}
 */
function lists(value, token) {
    return value.split(',').map(item => item.trim().toLowerCase()).includes(token.toLowerCase());
}

/**
 * Returns the allowlisted origin without a trailing slash
 *
 * @param {import('../lib/context.mjs').Context} ctx
 * @returns {string}
 */
function allowed(ctx) {
    return String(ctx.options.allowedOrigin).replace(/\/+$/, '');
}

/** @type {import('../lib/check.mjs').Check[]} */
export default [
    {
        id: 'cors.no-origin',
        severity: 'MUST',
        description: 'Requests without an Origin header (non-browser clients) are allowed',
        async run(ctx) {
            const fileId = ctx.id();
            expectOk(await ctx.chunk({ fileId, fileName: ctx.name('noorigin'), fileSize: 4, totalChunks: 1, chunkIndex: 0, data: randomBytes(4) }),
                'chunk without Origin');
            expectOk(await ctx.status(fileId), 'status without Origin');
        },
    },
    {
        id: 'cors.same-origin',
        severity: 'MUST',
        description: 'Requests whose Origin matches the endpoint (scheme, host, port of --url) are allowed',
        async run(ctx) {
            const headers = { Origin: ctx.origin };
            const fileId = ctx.id();
            const fileName = ctx.name('sameorigin');
            const fields = { fileId, fileName, fileSize: 4, totalChunks: 1 };
            const chunk = await ctx.chunk({ ...fields, chunkIndex: 0, data: randomBytes(4), headers });
            expectOk(chunk, `chunk with Origin ${ctx.origin}`);
            const finalize = await ctx.finalize(fields, { headers });
            expectOk(finalize, `finalize with Origin ${ctx.origin}`);
            for (const response of [chunk, finalize]) {
                const value = header(response, 'access-control-allow-origin');
                expect(value === '' || value === ctx.origin, `same-origin response sends Access-Control-Allow-Origin: ${value}`);
            }
        },
    },
    {
        id: 'cors.foreign-json',
        severity: 'MUST',
        description: 'A JSON action from a foreign Origin is 403 without CORS headers and does nothing',
        async run(ctx) {
            const fileId = ctx.id();
            await ctx.sendChunks({ fileId, fileName: ctx.name('foreignjson', 'bin'), data: randomBytes(2000), order: [0] });
            const response = await ctx.abort(fileId, { headers: { Origin: FOREIGN } });
            expectStatus(response, 403, `abort with Origin ${FOREIGN}`);
            expectNoAllowOrigin(response, 'foreign abort');
            const status = expectOk(await ctx.status(fileId), 'status after the foreign abort');
            expect(status.complete === false, 'the upload changed after the foreign abort');
        },
    },
    {
        id: 'cors.foreign-chunk',
        severity: 'MUST',
        description: 'A multipart chunk from a foreign Origin is 403 without CORS headers and is not stored',
        async run(ctx) {
            const fileId = ctx.id();
            const response = await ctx.chunk({
                fileId, fileName: ctx.name('foreignchunk'), fileSize: 4, totalChunks: 1, chunkIndex: 0, data: randomBytes(4), headers: { Origin: FOREIGN },
            });
            expectStatus(response, 403, `chunk with Origin ${FOREIGN}`);
            expectNoAllowOrigin(response, 'foreign chunk');
            expectStatus(await ctx.status(fileId), 404, 'status after the foreign chunk');
        },
    },
    {
        id: 'cors.foreign-preflight',
        severity: 'MUST',
        description: 'A preflight from a foreign Origin is 403 without CORS headers',
        async run(ctx) {
            const response = await preflight(ctx, FOREIGN);
            expectStatus(response, 403, `preflight from ${FOREIGN}`);
            expectNoAllowOrigin(response, 'foreign preflight');
        },
    },
    {
        id: 'cors.null-origin',
        severity: 'MUST',
        description: 'Origin: null (sandboxed pages, file: URLs) is 403',
        async run(ctx) {
            const headers = { Origin: 'null' };
            const fileId = ctx.id();
            const chunk = await ctx.chunk({ fileId, fileName: ctx.name('null'), fileSize: 4, totalChunks: 1, chunkIndex: 0, data: randomBytes(4), headers });
            expectStatus(chunk, 403, 'chunk with Origin: null');
            expectStatus(await ctx.status(fileId, { headers }), 403, 'status with Origin: null');
            expectStatus(await preflight(ctx, 'null'), 403, 'preflight with Origin: null');
            expectNoAllowOrigin(chunk, 'Origin: null');
        },
    },
    {
        id: 'cors.lookalike-origins',
        severity: 'MUST',
        description: 'Origins that only resemble the endpoint (other port, suffix, userinfo, path) are 403',
        async run(ctx) {
            const url = ctx.url;
            const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
            const otherPort = port === 65535 ? port - 1 : port + 1;
            const portPart = url.port ? `:${url.port}` : '';
            const origins = [
                `${url.protocol}//${url.hostname}:${otherPort}`,
                `${url.protocol}//${url.hostname}.foreign.test${portPart}`,
                `${url.protocol}//foreign.test${portPart}`,
                `${url.origin}.foreign.test`,
                `${url.origin}@foreign.test`,
                `${url.protocol}//foreign.test/${url.host}`,
            ];
            const fileId = ctx.id();
            for (const origin of origins) {
                const response = await ctx.status(fileId, { headers: { Origin: origin } });
                expectStatus(response, 403, `status with Origin ${origin}`);
                expectNoAllowOrigin(response, `Origin ${origin}`);
            }
        },
    },
    {
        id: 'cors.allowlist-request',
        severity: 'MUST',
        description: 'An allowlisted Origin gets Access-Control-Allow-Origin set to it, with Vary: Origin',
        requires: ['allowedOrigin'],
        async run(ctx) {
            const origin = allowed(ctx);
            const headers = { Origin: origin };
            const fileId = ctx.id();
            const chunk = await ctx.chunk({ fileId, fileName: ctx.name('allowed'), fileSize: 4, totalChunks: 1, chunkIndex: 0, data: randomBytes(4), headers });
            expectOk(chunk, `chunk with Origin ${origin}`);
            const missing = await ctx.status(ctx.id(), { headers });
            expectStatus(missing, 404, `status of an unknown upload with Origin ${origin}`);
            for (const response of [chunk, missing]) {
                const value = header(response, 'access-control-allow-origin');
                expect(value === origin, `${response.label}: Access-Control-Allow-Origin is ${JSON.stringify(value)}, expected ${origin}`);
                expect(lists(header(response, 'vary'), 'origin'), `${response.label}: no Vary: Origin`);
            }
        },
    },
    {
        id: 'cors.allowlist-preflight',
        severity: 'MUST',
        description: 'A preflight from an allowlisted Origin is answered with 2xx and allows POST and Content-Type',
        requires: ['allowedOrigin'],
        async run(ctx) {
            const origin = allowed(ctx);
            const response = await preflight(ctx, origin);
            expectStatus(response, [204, 200], `preflight from ${origin}`);
            const allowOrigin = header(response, 'access-control-allow-origin');
            expect(allowOrigin === origin, `preflight: Access-Control-Allow-Origin is ${JSON.stringify(allowOrigin)}, expected ${origin}`);
            const methods = header(response, 'access-control-allow-methods');
            expect(lists(methods, 'POST'), `preflight: Access-Control-Allow-Methods ${JSON.stringify(methods)} does not list POST`);
            const allowHeaders = header(response, 'access-control-allow-headers');
            expect(lists(allowHeaders, 'content-type'),
                `preflight: Access-Control-Allow-Headers ${JSON.stringify(allowHeaders)} does not list Content-Type`);
        },
    },
    {
        id: 'cors.allowlist-credentials',
        severity: 'SHOULD',
        description: 'Responses to an allowlisted Origin allow credentials',
        requires: ['allowedOrigin'],
        async run(ctx) {
            const origin = allowed(ctx);
            for (const response of [await preflight(ctx, origin), await ctx.status(ctx.id(), { headers: { Origin: origin } })]) {
                const value = header(response, 'access-control-allow-credentials');
                expect(value === 'true', `${response.label}: Access-Control-Allow-Credentials is ${JSON.stringify(value)}`);
            }
        },
    },
    {
        id: 'cors.allowlist-request-headers',
        severity: 'SHOULD',
        description: 'A preflight from an allowlisted Origin allows the custom request headers it asks for, such as a CSRF token header',
        requires: ['allowedOrigin'],
        async run(ctx) {
            const origin = allowed(ctx);
            const response = await preflight(ctx, origin, 'content-type,x-csrf-token');
            expectStatus(response, [204, 200], `preflight from ${origin}`);
            const allowHeaders = header(response, 'access-control-allow-headers');
            expect(lists(allowHeaders, 'x-csrf-token'),
                `preflight asking for X-CSRF-Token: Access-Control-Allow-Headers is ${JSON.stringify(allowHeaders)}`);

            // An answer that depends on the request headers must say so, or a cache may reuse it
            const plain = await preflight(ctx, origin, 'content-type');
            if (header(plain, 'access-control-allow-headers') !== allowHeaders) {
                for (const item of [response, plain]) {
                    expect(lists(header(item, 'vary'), 'access-control-request-headers'),
                        `Access-Control-Allow-Headers depends on Access-Control-Request-Headers, but Vary is ${JSON.stringify(header(item, 'vary'))}`);
                }
            }
        },
    },
];
