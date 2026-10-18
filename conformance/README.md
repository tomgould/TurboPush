# Conformance suite

HTTP-level tests for any server that implements the TurboPush endpoint protocol ([PROTOCOL.md](../PROTOCOL.md)). Plain Node.js, no dependencies, Node 18 or later.

## Against any server

```bash
node conformance/run.mjs --url http://localhost:8000/endpoint.php
# or, in this repo
npm run conformance -- --url http://localhost:8000/endpoint.php
```

| Option | Effect |
|--------|--------|
| `--url URL` | Endpoint to test (required) |
| `--max-file-size N` | The server's file size limit in bytes; with `--max-chunk-size`, enables `limits.file-size` |
| `--max-chunk-size N` | The server's chunk size limit; enables `limits.chunk-size` and `limits.chunks-vs-size` |
| `--max-chunks N` | The server's chunk count limit; enables `limits.max-chunks` |
| `--upload-dir PATH` | The server's upload directory, readable from where the suite runs. Enables byte-for-byte checks of stored files, the path traversal checks on disk, `abort.keeps-stored-file` and `storage.no-stray-files` |
| `--allowed-origin ORIGIN` | An origin on the server's CORS allowlist; enables the `cors.allowlist-*` checks |
| `--only TEXT` | Run only checks whose id contains `TEXT` (repeatable, comma-separated) |
| `--json` | Print the results as JSON |
| `--timeout MS` | Per-request timeout (default 30000) |
| `--insecure` | Do not verify TLS certificates |
| `--list` | List the checks |

Checks whose inputs are not given are skipped, not failed. Each check is a MUST (a failure fails the run) or a SHOULD (a failure is a warning). The report has one line per check, then the totals. The exit code is 1 if any MUST check failed, 2 for invalid arguments, 0 otherwise.

The sweep checks (`response.*`, `errors.no-server-paths`, `storage.no-stray-files`) run last, over every response the checks before them produced. `--only` selects sweeps like any other check, so `--only upload.,response.` runs the `upload.*` checks and then the `response.*` sweeps over their responses.

A limit check whose requests would also break another limit you gave is skipped, so that it cannot pass for the wrong reason. A limit you did not give cannot be taken into account, so give all three.

Things to know before pointing it at a server:

- Run it against a test deployment. It stores small files whose names start with `tpc-` (and a few such as `htaccess` and `user.ini`) and leaves them in the upload directory. It aborts the uploads it starts, so no chunks are left behind.
- Same-origin is judged from `--url`: the suite sends `Origin: <scheme>://<host>[:port]` of that URL and expects it to be accepted. If a proxy rewrites the `Host` header, that check fails unless the origin is on the server's allowlist.
- The suite expects the default extension blocklist and a server that does not allow every origin (`*`).
- With `--upload-dir`, the suite makes one warm-up upload before the checks and then lists the directory, so files the server creates there on first use (such as an access-control file) are not reported by `storage.no-stray-files`. Files it creates later are.
- Without `--upload-dir`, the path traversal check still looks for escaped files in the system temp directory, the filesystem root and the current directory, but cannot tell an escape from a server whose upload directory is one of those.
- Expiry of abandoned uploads is not checked.

## Against the PHP reference implementation

```bash
npm run conformance:php
node conformance/php.mjs --php /usr/bin/php8.4     # a specific PHP binary
node conformance/php.mjs --json                    # other options go to the suite
```

`php.mjs` starts `php -S 127.0.0.1:<free port> -t conformance/server` with `PHP_CLI_SERVER_WORKERS=4` and fresh temporary storage, runs the suite twice and removes the storage again:

1. `endpoint.php`, the default profile (same-origin only), with all limit flags and `--upload-dir`;
2. `endpoint-allowlist.php` with `--allowed-origin https://allowed.conformance.test`, running the `cors.*` checks and the sweeps (skipped when you pass `--only`).

The PHP binary comes from `--php`, then `PHP_BINARY`, then `php`. PHP runs with `display_errors=1` and `error_reporting=-1`, so any warning or deprecation the endpoint emits breaks the JSON of that response and fails `response.json`. On failure, PHP's own output (not its access log) is printed.

The conformance profile ([profile.php](profile.php)):

| Setting | Value |
|---------|-------|
| Maximum file size | 8 MiB (8388608) |
| Maximum chunk size | 256 KiB (262144) |
| Maximum chunks | 64 |
| Extension blocklist | the default |
| CORS | same-origin only; `endpoint-allowlist.php` lists the origins in `TURBOPUSH_CONFORMANCE_ALLOWED_ORIGINS` |
| Cleanup probability | 0 |
| Storage | `$TURBOPUSH_CONFORMANCE_DIR/uploads` and `$TURBOPUSH_CONFORMANCE_DIR/chunks` |

To test another PHP version without installing it, start the server in Docker with the repo and a storage directory mounted at the same paths, then run the suite from the host with the profile's flags:

```bash
STORE=$(mktemp -d)
docker run --rm --init --network host --user "$(id -u):$(id -g)" \
  -v "$PWD:$PWD:ro" -v "$STORE:$STORE" -w "$PWD" \
  -e PHP_CLI_SERVER_WORKERS=4 -e TURBOPUSH_CONFORMANCE_DIR="$STORE" \
  php:7.4-cli php -S 127.0.0.1:8099 -t conformance/server &
sleep 1
node conformance/run.mjs --url http://127.0.0.1:8099/endpoint.php \
  --max-file-size 8388608 --max-chunk-size 262144 --max-chunks 64 --upload-dir "$STORE/uploads"
```

## Adding a check

Checks live in `checks/*.mjs`, grouped by topic, and are registered in `run.mjs`. A check is an object:

```js
{
    id: 'status.unknown',                 // topic.name, stable: PROTOCOL.md refers to it
    severity: 'MUST',                     // or 'SHOULD'
    description: 'Status of an unknown upload is 404',
    requires: ['uploadDir'],              // optional: inputs it needs, otherwise skipped
    async run(ctx) {
        expectStatus(await ctx.status(ctx.id()), 404, 'status of an unknown upload');
    },
}
```

- `ctx` ([lib/context.mjs](lib/context.mjs)) sends requests: `ctx.chunk()`, `ctx.parts()` for hand-built multipart bodies, `ctx.json()`, `ctx.finalize()`, `ctx.status()`, `ctx.abort()`, plus `ctx.sendChunks()` and `ctx.upload()` for whole uploads. Use `ctx.id()` for upload IDs, so each check is independent and its uploads are aborted afterwards, and `ctx.name()` for file names.
- Fail with the helpers in [lib/check.mjs](lib/check.mjs): `expectStatus()`, `expectOk()`, `expect()`, `fail()`, or `skip()` when the check cannot run. Keep reasons short and say what was sent and what came back.
- Add a `[check: id]` marker next to the requirement in PROTOCOL.md.
- Run it against the reference endpoint with `node conformance/php.mjs --only <id>`, and make sure it fails against an endpoint that breaks the rule.
