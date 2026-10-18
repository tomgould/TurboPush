# TurboPush Tests

Two suites: Jest for the TypeScript client and PHPUnit for the PHP endpoint.

## Running

```bash
npm test                 # Jest
npm run test:coverage    # Jest with a coverage report in coverage/
npx jest -t "pause"      # tests whose name matches

composer install
vendor/bin/phpunit       # PHPUnit
vendor/bin/phpunit --filter ConcurrencyTest
```

## Client (Jest)

Runs in jsdom, which provides real `Blob`, `File`, `FormData`, `AbortController` and `localStorage`. Only `fetch` is replaced.

| File | Covers |
|------|--------|
| `TurboPush.test.ts` | Configuration, request contents and headers, empty files, upload IDs, retry classification, exponential backoff and jitter, timeouts, finalize retries, error details, callback exceptions. `fetch` is a `jest.fn()` |
| `TurboPush.integration.test.ts` | Whole uploads against `MockServer`: byte-exact reassembly, progress, the global concurrency limit, pause/resume, cancel, retrying failed files, one bad file among good ones |
| `TurboPush.resume.test.ts` | The `resumable` option: continuing after a simulated reload, completed and incompatible server state, storage failures |
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
