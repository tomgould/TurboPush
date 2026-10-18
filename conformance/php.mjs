#!/usr/bin/env node
// @ts-check
/**
 * Runs the conformance suite against the bundled PHP endpoint.
 *
 * Starts PHP's built-in server on a free port with four workers, serving
 * conformance/server with fresh temporary storage, runs the suite twice
 * (the default same-origin profile, then the CORS checks and the sweeps
 * against the allowlist endpoint), stops the server and removes the storage.
 *
 *   node conformance/php.mjs [--php /usr/bin/php8.4] [suite options]
 *
 * The PHP binary comes from --php, then PHP_BINARY, then "php". Other
 * options (such as --json or --only) are passed to the suite; with --only,
 * the allowlist pass is skipped.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_ORIGIN = 'https://allowed.conformance.test';

/** Limits of the conformance profile (conformance/profile.php) */
const PROFILE = ['--max-file-size', '8388608', '--max-chunk-size', '262144', '--max-chunks', '64'];

/**
 * Finds a free TCP port on 127.0.0.1
 *
 * @returns {Promise<number>}
 */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Resolves once the server answers HTTP requests
 *
 * @param {number} port
 * @param {() => boolean} exited Whether the server process has already exited
 * @returns {Promise<void>}
 */
async function waitForServer(port, exited) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (exited()) {
            throw new Error('PHP server exited during startup');
        }
        const up = await new Promise(resolve => {
            const req = http.request({ host: '127.0.0.1', port, path: '/endpoint.php', method: 'GET' }, res => {
                res.resume();
                resolve(true);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(1000, () => req.destroy());
            req.end();
        });
        if (up) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('PHP server did not answer within 15 s');
}

/**
 * Runs the suite and resolves with its exit code and (in JSON mode) its output
 *
 * @param {string[]} args
 * @param {boolean} capture Capture stdout instead of passing it through
 * @returns {Promise<{ code: number, stdout: string }>}
 */
function runSuite(args, capture) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(HERE, 'run.mjs'), ...args], {
            stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
        });
        let stdout = '';
        if (child.stdout) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                stdout += chunk;
            });
        }
        child.on('error', reject);
        child.on('close', code => resolve({ code: code === null ? 1 : code, stdout }));
    });
}

/**
 * Starts the PHP server
 *
 * @param {string} php PHP binary
 * @param {number} port
 * @param {string} storage Storage directory for the conformance profile
 * @param {string[]} log Receives the server's output lines (last 200 kept)
 * @returns {{ child: import('node:child_process').ChildProcess, exit: Promise<void> }}
 */
function startServer(php, port, storage, log) {
    const child = spawn(php, [
        '-d', 'display_errors=1',
        '-d', 'error_reporting=-1',
        '-d', 'upload_max_filesize=2M',
        '-d', 'post_max_size=8M',
        '-S', `127.0.0.1:${port}`,
        '-t', path.join(HERE, 'server'),
    ], {
        env: {
            ...process.env,
            PHP_CLI_SERVER_WORKERS: '4',
            TURBOPUSH_CONFORMANCE_DIR: storage,
            TURBOPUSH_CONFORMANCE_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so the workers can be stopped with it
        detached: process.platform !== 'win32',
    });
    for (const stream of [child.stdout, child.stderr]) {
        if (stream) {
            stream.setEncoding('utf8');
            stream.on('data', chunk => {
                log.push(...String(chunk).split('\n').filter(Boolean));
                log.splice(0, Math.max(0, log.length - 200));
            });
        }
    }
    const exit = new Promise(resolve => {
        child.on('exit', () => resolve(undefined));
        child.on('error', error => {
            log.push(`Cannot start ${php}: ${error.message}`);
            resolve(undefined);
        });
    });
    return { child, exit };
}

async function main() {
    const argv = process.argv.slice(2);
    let php = process.env.PHP_BINARY || 'php';
    /** @type {string[]} */
    const passthrough = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--php' && i + 1 < argv.length) {
            php = argv[++i];
        } else if (argv[i].startsWith('--php=')) {
            php = argv[i].slice('--php='.length);
        } else {
            passthrough.push(argv[i]);
        }
    }
    if (passthrough.some(arg => ['--help', '-h', '--list'].includes(arg))) {
        return (await runSuite(passthrough, false)).code;
    }
    const json = passthrough.includes('--json');
    const only = passthrough.some(arg => arg === '--only' || arg.startsWith('--only='));

    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'turbopush-conformance-'));
    /** @type {string[]} */
    const serverLog = [];
    /** @type {{ child: import('node:child_process').ChildProcess, exit: Promise<void> } | null} */
    let server = null;
    let exited = false;

    /** @param {NodeJS.Signals} name */
    const signal = name => {
        const pid = server && server.child.pid;
        if (!server || !pid) {
            return;
        }
        try {
            if (process.platform === 'win32') {
                server.child.kill(name);
            } else {
                process.kill(-pid, name);
            }
        } catch (error) {
            // Already gone
        }
    };
    let stopped = false;
    const stop = async () => {
        if (stopped) {
            return;
        }
        stopped = true;
        if (server && !exited) {
            signal('SIGTERM');
            const timer = setTimeout(() => signal('SIGKILL'), 3000);
            await server.exit;
            clearTimeout(timer);
        }
        signal('SIGKILL'); // Any worker that outlived the main process
        fs.rmSync(storage, { recursive: true, force: true });
    };
    for (const [name, number] of /** @type {Array<[NodeJS.Signals, number]>} */ ([['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]])) {
        process.on(name, () => {
            stop().finally(() => process.exit(128 + number));
        });
    }
    process.on('exit', () => {
        signal('SIGKILL');
        fs.rmSync(storage, { recursive: true, force: true });
    });

    let code = 1;
    try {
        const port = await freePort();
        server = startServer(php, port, storage, serverLog);
        server.exit.then(() => {
            exited = true;
        });
        await waitForServer(port, () => exited);

        const base = `http://127.0.0.1:${port}`;
        const uploads = path.join(storage, 'uploads');
        const passes = [
            {
                title: 'Default profile (same-origin only)',
                args: ['--url', `${base}/endpoint.php`, ...PROFILE, '--upload-dir', uploads],
            },
        ];
        if (!only) {
            passes.push({
                title: 'Allowlist profile (CORS checks)',
                args: ['--url', `${base}/endpoint-allowlist.php`, ...PROFILE, '--upload-dir', uploads,
                    '--allowed-origin', ALLOWED_ORIGIN, '--only', 'cors.,response.,errors.,storage.'],
            });
        }

        /** @type {unknown[]} */
        const reports = [];
        code = 0;
        for (const pass of passes) {
            if (!json) {
                process.stdout.write(`\n== ${pass.title} ==\n\n`);
            }
            const result = await runSuite([...pass.args, ...passthrough], json);
            code = Math.max(code, result.code);
            if (json) {
                try {
                    reports.push({ title: pass.title, ...JSON.parse(result.stdout) });
                } catch (error) {
                    reports.push({ title: pass.title, error: result.stdout });
                }
            }
        }
        if (json) {
            process.stdout.write(JSON.stringify({ php, ok: code === 0, passes: reports }, null, 2) + '\n');
        }
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        code = 1;
    } finally {
        // Show what PHP reported besides its access log (startup errors, warnings)
        const diagnostics = serverLog.filter(line => !/\] \S+:\d+ (Accepted|Closing|\[\d{3}\]: )/.test(line));
        if (code !== 0 && diagnostics.length > 0) {
            process.stderr.write(`\nPHP server output:\n${diagnostics.slice(-40).join('\n')}\n`);
        }
        await stop();
    }
    return code;
}

main().then(code => {
    process.exitCode = code;
}, error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
});
