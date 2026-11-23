#!/usr/bin/env node
// @ts-check
/**
 * TurboPush endpoint conformance suite.
 *
 * Sends real HTTP requests to an endpoint and checks its behaviour against
 * PROTOCOL.md. Zero dependencies, Node 18 or later.
 *
 *   node conformance/run.mjs --url http://localhost:8000/endpoint.php
 *
 * See conformance/README.md for the options.
 */

import path from 'node:path';
import { CheckFailure, CheckSkip } from './lib/check.mjs';
import { Context } from './lib/context.mjs';
import lifecycle from './checks/lifecycle.mjs';
import requests from './checks/requests.mjs';
import security from './checks/security.mjs';
import concurrency from './checks/concurrency.mjs';
import cors from './checks/cors.mjs';
import sweeps from './checks/sweeps.mjs';

/** @type {import('./lib/check.mjs').Check[]} */
const CHECKS = [...lifecycle, ...requests, ...security, ...concurrency, ...cors, ...sweeps];

const USAGE = `Usage: node conformance/run.mjs --url <endpoint URL> [options]

Options:
  --url URL               Endpoint to test (required)
  --max-file-size N       Server's maximum file size in bytes
  --max-chunk-size N      Server's maximum chunk size in bytes
  --max-chunks N          Server's maximum number of chunks per upload
  --upload-dir PATH       Server's upload directory, readable by this process
  --allowed-origin ORIGIN An origin on the server's CORS allowlist
  --only TEXT             Run only checks whose id contains TEXT (repeatable, comma-separated);
                          selected sweep checks still run last
  --json                  Print the results as JSON
  --timeout MS            Per-request timeout (default 30000)
  --insecure              Do not verify TLS certificates
  --list                  List the checks and exit
  --help                  Show this help

Checks that need an option you did not give are skipped. Exit code 1 if any
MUST check fails, 2 for invalid arguments.`;

/**
 * @typedef {object} Args
 * @property {URL | null} url
 * @property {number | null} maxFileSize
 * @property {number | null} maxChunkSize
 * @property {number | null} maxChunks
 * @property {string | null} uploadDir
 * @property {string | null} allowedOrigin
 * @property {string[]} only
 * @property {boolean} json
 * @property {number} timeout
 * @property {boolean} insecure
 * @property {boolean} list
 * @property {boolean} help
 */

/**
 * @typedef {object} Result
 * @property {string} id
 * @property {'MUST' | 'SHOULD'} severity
 * @property {string} description
 * @property {'pass' | 'fail' | 'warn' | 'skip'} status
 * @property {string} reason Why it failed or was skipped ('' when it passed)
 * @property {number} ms Duration
 */

/**
 * Prints an argument error and exits with 2
 *
 * @param {string} message
 * @returns {never}
 */
function usageError(message) {
    process.stderr.write(`${message}\n\n${USAGE}\n`);
    process.exit(2);
}

/**
 * @param {string} flag
 * @param {string} value
 * @param {number} min
 * @returns {number}
 */
function parseCount(flag, value, min) {
    if (!/^[0-9]+$/.test(value) || Number(value) < min || !Number.isSafeInteger(Number(value))) {
        usageError(`${flag} must be an integer of at least ${min}`);
    }
    return Number(value);
}

/**
 * @param {string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
    /** @type {Args} */
    const args = {
        url: null, maxFileSize: null, maxChunkSize: null, maxChunks: null, uploadDir: null,
        allowedOrigin: null, only: [], json: false, timeout: 30000, insecure: false, list: false, help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        let flag = argv[i];
        /** @type {string | undefined} */
        let inline;
        const eq = flag.indexOf('=');
        if (flag.startsWith('--') && eq !== -1) {
            inline = flag.slice(eq + 1);
            flag = flag.slice(0, eq);
        }
        const value = () => {
            if (inline !== undefined) {
                return inline;
            }
            if (i + 1 >= argv.length) {
                usageError(`${flag} needs a value`);
            }
            return argv[++i];
        };
        switch (flag) {
            case '--url': {
                const raw = value();
                let url;
                try {
                    url = new URL(raw);
                } catch (error) {
                    usageError(`--url is not a valid URL: ${raw}`);
                }
                if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                    usageError('--url must be an http or https URL');
                }
                args.url = url;
                break;
            }
            case '--max-file-size': args.maxFileSize = parseCount(flag, value(), 0); break;
            case '--max-chunk-size': args.maxChunkSize = parseCount(flag, value(), 1); break;
            case '--max-chunks': args.maxChunks = parseCount(flag, value(), 1); break;
            case '--upload-dir': args.uploadDir = path.resolve(value()); break;
            case '--allowed-origin': {
                const origin = value().replace(/\/+$/, '');
                let parsed;
                try {
                    parsed = new URL(origin);
                } catch (error) {
                    usageError(`--allowed-origin is not an origin: ${origin}`);
                }
                if (parsed.origin !== origin) {
                    usageError(`--allowed-origin must be a scheme://host[:port] origin, such as ${parsed.origin}`);
                }
                args.allowedOrigin = origin;
                break;
            }
            case '--only': args.only.push(...value().split(',').map(item => item.trim()).filter(Boolean)); break;
            case '--timeout': args.timeout = parseCount(flag, value(), 1000); break;
            case '--json': args.json = true; break;
            case '--insecure': args.insecure = true; break;
            case '--list': args.list = true; break;
            case '--help': case '-h': args.help = true; break;
            default: usageError(`Unknown option: ${argv[i]}`);
        }
        if (inline !== undefined && ['--json', '--insecure', '--list', '--help'].includes(flag)) {
            usageError(`${flag} takes no value`);
        }
    }
    return args;
}

/** Command-line flag for each input a check can require */
const INPUT_FLAGS = {
    maxFileSize: '--max-file-size',
    maxChunkSize: '--max-chunk-size',
    maxChunks: '--max-chunks',
    uploadDir: '--upload-dir',
    allowedOrigin: '--allowed-origin',
};

/**
 * Runs one check and turns its outcome into a result
 *
 * @param {import('./lib/check.mjs').Check} check
 * @param {Context} ctx
 * @returns {Promise<Result>}
 */
async function runCheck(check, ctx) {
    /** @type {Result} */
    const result = { id: check.id, severity: check.severity, description: check.description, status: 'pass', reason: '', ms: 0 };
    const missing = (check.requires || []).filter(input => ctx.options[input] === null);
    if (missing.length > 0) {
        return { ...result, status: 'skip', reason: `needs ${missing.map(input => INPUT_FLAGS[input]).join(' and ')}` };
    }

    const started = Date.now();
    ctx.ids = [];
    try {
        await check.run(ctx);
    } catch (error) {
        if (error instanceof CheckSkip) {
            result.status = 'skip';
            result.reason = error.message;
        } else {
            result.status = check.severity === 'MUST' ? 'fail' : 'warn';
            result.reason = error instanceof CheckFailure
                ? error.message
                : `error: ${error instanceof Error ? error.message : String(error)}`;
        }
    } finally {
        // Remove what the check left on the server; abort is harmless for
        // unknown and finished uploads
        for (const fileId of ctx.ids) {
            await ctx.abort(fileId, { label: 'cleanup abort' }).catch(() => undefined);
        }
        ctx.ids = [];
    }
    result.ms = Date.now() - started;
    return result;
}

/**
 * @param {Result[]} results
 * @returns {{ total: number, passed: number, failed: number, warnings: number, skipped: number }}
 */
function summarize(results) {
    /** @param {Result['status']} status */
    const count = status => results.filter(result => result.status === status).length;
    return { total: results.length, passed: count('pass'), failed: count('fail'), warnings: count('warn'), skipped: count('skip') };
}

/**
 * Prints the human-readable report
 *
 * @param {Args & { url: URL }} args
 * @param {Result[]} results
 * @param {number} requests Number of requests sent
 * @param {number} ms
 */
function printReport(args, results, requests, ms) {
    const color = process.stdout.isTTY && !process.env.NO_COLOR;
    /** @type {Record<Result['status'], [string, string]>} */
    const labels = { pass: ['PASS', '32'], fail: ['FAIL', '31'], warn: ['WARN', '33'], skip: ['SKIP', '2'] };
    const width = Math.max(...results.map(result => result.id.length));
    /** @param {number | null} value */
    const show = value => (value === null ? '-' : String(value));

    const lines = [
        `TurboPush conformance suite: ${args.url.href}`,
        `max-file-size ${show(args.maxFileSize)}, max-chunk-size ${show(args.maxChunkSize)}, max-chunks ${show(args.maxChunks)}, `
            + `upload-dir ${args.uploadDir || '-'}, allowed-origin ${args.allowedOrigin || '-'}`,
        '',
    ];
    for (const result of results) {
        const [label, code] = labels[result.status];
        const status = color ? `\x1b[${code}m${label}\x1b[0m` : label;
        lines.push(`${status}  ${result.severity.padEnd(6)}  ${result.id.padEnd(width)}  ${result.reason || result.description}`);
    }
    const summary = summarize(results);
    /** @param {number} count @param {string} noun */
    const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
    lines.push('', `${plural(summary.total, 'check')}: ${summary.passed} passed, ${summary.failed} failed, `
        + `${plural(summary.warnings, 'warning')}, ${summary.skipped} skipped `
        + `(${plural(requests, 'request')}, ${(ms / 1000).toFixed(1)} s)`);
    process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(USAGE + '\n');
        return 0;
    }
    if (args.list) {
        const width = Math.max(...CHECKS.map(check => check.id.length));
        for (const check of CHECKS) {
            const needs = check.requires ? ` (needs ${check.requires.map(input => INPUT_FLAGS[input]).join(', ')})` : '';
            process.stdout.write(`${check.severity.padEnd(6)}  ${check.id.padEnd(width)}  ${check.description}${needs}\n`);
        }
        return 0;
    }
    if (!args.url) {
        usageError('--url is required');
    }
    const url = args.url;

    const ctx = new Context({
        url,
        maxFileSize: args.maxFileSize,
        maxChunkSize: args.maxChunkSize,
        maxChunks: args.maxChunks,
        uploadDir: args.uploadDir,
        allowedOrigin: args.allowedOrigin,
        timeout: args.timeout,
        insecure: args.insecure,
    });

    /** @param {import('./lib/check.mjs').Check} check */
    const matches = check => args.only.length === 0 || args.only.some(text => check.id.includes(text));
    const selected = CHECKS.filter(matches);
    if (selected.length === 0) {
        usageError(`No check id contains ${args.only.map(text => JSON.stringify(text)).join(' or ')}`);
    }

    try {
        await ctx.status('tpc_reachability_probe');
    } catch (error) {
        process.stderr.write(`Cannot reach ${url.href}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
    await ctx.snapshotUploadDir();

    const started = Date.now();
    /** @type {Result[]} */
    const results = [];
    // Sweeps go last, over the responses of everything before them
    for (const check of [...selected.filter(item => !item.sweep), ...selected.filter(item => item.sweep)]) {
        results.push(await runCheck(check, ctx));
    }
    const ms = Date.now() - started;
    const summary = summarize(results);

    if (args.json) {
        const report = {
            endpoint: url.href,
            inputs: {
                maxFileSize: args.maxFileSize,
                maxChunkSize: args.maxChunkSize,
                maxChunks: args.maxChunks,
                uploadDir: args.uploadDir,
                allowedOrigin: args.allowedOrigin,
            },
            ok: summary.failed === 0,
            summary,
            requests: ctx.client.log.length,
            durationMs: ms,
            results,
        };
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
        printReport({ ...args, url }, results, ctx.client.log.length, ms);
    }
    return summary.failed > 0 ? 1 : 0;
}

main().then(code => {
    process.exitCode = code;
}, error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
});
