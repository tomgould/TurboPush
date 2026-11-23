# TurboPush Tests

Jest for the TypeScript client, PHPUnit for the PHP endpoint, interop tests that run the client against real tus servers, and an HTTP conformance suite for TurboPush's own protocol (see [conformance/README.md](../conformance/README.md)).

## Running

```bash
npm test                 # Jest
npm run test:coverage    # Jest with a coverage report in coverage/
npx jest -t "pause"      # tests whose name matches

composer install
vendor/bin/phpunit       # PHPUnit
vendor/bin/phpunit --filter ConcurrencyTest

npm run interop          # starts tusd and tus-php in Docker, runs the interop tests, stops them
npm run interop -- --keep  # leave the servers running; then `npm run test:interop` reruns quickly
```

## Client (Jest)

Runs in jsdom, which provides real `Blob`, `File`, `FormData`, `AbortController` and `localStorage`. Only `fetch` is replaced.

| File | Covers |
|------|--------|
| `TurboPush.test.ts` | Configuration, request contents and headers, empty files, upload IDs, retry classification, exponential backoff and jitter, timeouts, finalize retries, error details, callback exceptions. `fetch` is a `jest.fn()` |
| `TurboPush.integration.test.ts` | Whole uploads against `MockServer`: byte-exact reassembly, progress, the global concurrency limit, pause/resume, cancel, retrying failed files, one bad file among good ones |
| `TurboPush.resume.test.ts` | The `resumable` option: continuing after a simulated reload, completed and incompatible server state, storage failures |
| `TurboPush.tus.test.ts` | The tus transport against `TusMockServer`: discovery, creation and metadata, sequential and concatenation (parallel) uploads, offsets after dropped connections, partial PATCHes and 409s, lost uploads, retries, timeouts, Tus-Max-Size, checksums, pause/resume, cancel with termination, resumable mode |
| `mocks/TusMockServer.ts` | An in-memory tus 1.0.0 server installed as `global.fetch`, with creation, HEAD, PATCH, termination, concatenation and checksums. It records requests and PATCH concurrency and takes interceptors, including one that stores part of a PATCH body before dropping the connection |
| `mocks/MockServer.ts` | A fake endpoint installed as `global.fetch`. It stores chunks, implements finalize/status/abort, honours abort signals, records peak concurrency, and takes interceptors to inject failures |
| `setup.ts` | Clears `localStorage` and restores mocks and timers between tests |

Example of injecting a failure:

```typescript
// Answer chunk 3 with a 503 once, then behave normally
mockServer.intercept(
    req => req.chunkIndex === 3 ? MockServer.json(503, { success: false, message: 'Busy' }) : undefined,
    1
);
```

## Endpoint (PHPUnit)

Each test gets its own directory under the system temp directory and calls `processRequest()` directly. `TestableEndpoint` replaces `move_uploaded_file()`, which only works for real HTTP uploads, with `rename()`.

| File | Covers |
|------|--------|
| `PathTraversalTest.php` | Upload IDs, file names and chunk indexes that try to leave the configured directories |
| `FileNameSanitizationTest.php` | Dotfiles, double extensions, trailing dots, Windows device names, long names, never overwriting existing files |
| `ExtensionPolicyTest.php` | Default blocklist, allowlist, and renaming a file at finalize time |
| `RequestValidationTest.php` | Size, chunk and count limits, metadata that changes between chunks, PHP upload error codes |
| `AssemblyTest.php` | Out-of-order chunks, empty files, missing chunks, idempotent finalize, temp directory location and permissions |
| `ConcurrencyTest.php` | Duplicate chunks sent in parallel, parallel finalize requests, finalize waiting for the lock. Uses real separate PHP processes (`fixtures/worker.php`) |
| `MimeAndHooksTest.php` | MIME allowlist, file validator, completion callback |
| `CleanupTest.php` | Removing abandoned uploads, skipping locked ones, never deleting foreign files |
| `StatusAndAbortTest.php` | The status and abort actions |
| `CorsTest.php` | CORS headers and the origin check |
| `HttpResponseTest.php` | Status codes, headers, no paths in error responses, the legacy entry point |

## Interop (real tus servers)

`interop/docker-compose.yml` starts tusd 2.10 with concatenation (port 1080), tusd with `-disable-concatenation` (1081) and stock tus-php 2.4 on PHP's built-in server (1082). `interop/tus.interop.test.ts` runs in Node against each of them: several files at once, an empty file, pause and resume, a connection dropped halfway through a PATCH (the body is streamed and cut off), resuming after a simulated reload, and cancel with termination. Every upload is downloaded again and compared by SHA-256.

tus-php announces concatenation but crashes on a spec-compliant final request, so it is tested with `tus: { parallel: false }`, plus one test that the client fails cleanly when it tries concatenation. tus-php also stores uploads under the client's file name, so the tests give every file a unique name.

Override the server URLs with `TUSD_URL`, `TUSD_NOCONCAT_URL` and `TUS_PHP_URL`.
