# TurboPush

[![CI](https://github.com/tomgould/TurboPush/actions/workflows/ci.yml/badge.svg)](https://github.com/tomgould/TurboPush/actions/workflows/ci.yml)

TurboPush uploads large files from the browser in chunks, and comes with a PHP endpoint that checks and reassembles them safely.

## Why use it

A single multi-gigabyte POST is fragile: one dropped connection and the user starts again, and PHP's upload limits get in the way. TurboPush splits each file into chunks (1MB by default) and sends several at once. Failed chunks are retried with exponential backoff, uploads can be paused, resumed and cancelled, and with `resumable: true` an upload carries on after a page reload instead of starting over.

The PHP endpoint is the part that faces the internet, so it is strict: it validates every ID, index and size against limits you set, sanitises file names, blocks executable extensions by default, supports extension and MIME allowlists, keeps chunks outside the web root, locks each upload so parallel or repeated requests cannot corrupt a file, and never reveals server paths in its errors.

- Client: TypeScript, no dependencies, ESM and CommonJS builds with type declarations.
- Server: a single PHP endpoint class with no dependencies, for PHP 7.4 to 8.5.
- The protocol is small and documented below, so you can pair either half with your own code.

## Install

```bash
npm install turbopush              # browser client
composer require tomgould/turbopush  # PHP endpoint
```

Both can also be installed straight from GitHub: `npm install github:tomgould/TurboPush` (builds on install), or for Composer add the repository as a [VCS repository](https://getcomposer.org/doc/05-repositories.md#vcs). Without Composer, copy `TurboPushEndpoint.php` and the `php/` folder and `require_once 'TurboPushEndpoint.php'`.

## Quick start

Client:

```typescript
import { TurboPush } from 'turbopush';

const uploader = new TurboPush({ endpoint: '/upload.php' })
    .onProgress(files => files.forEach(f => console.log(`${f.fileName}: ${Math.round(f.percentage)}%`)))
    .onError((error, fileName) => console.error(`${fileName}: ${error.message}`));

input.addEventListener('change', async () => {
    const stats = await uploader.addFiles(input.files).push();
    console.log(`${stats.completedFiles} of ${stats.totalFiles} files uploaded`);
});
```

Server (`upload.php`):

```php
<?php
require __DIR__ . '/../vendor/autoload.php';

use TurboPush\TurboPushEndpoint;

(new TurboPushEndpoint('/var/lib/myapp/uploads'))   // outside the web root
    ->setMaxFileSize(2 * 1024 * 1024 * 1024)        // 2GB
    ->setAllowedExtensions(['jpg', 'png', 'pdf', 'zip'])
    ->handle();
```

`examples/upload-endpoint.php` shows a fuller production setup.

## Client

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | required | URL of the upload endpoint |
| `chunkSize` | number | `1048576` (1MB) | Chunk size in bytes. Must not exceed the server's chunk limit or PHP's `upload_max_filesize` |
| `maxConcurrentUploads` | number | `3` | Chunk requests in flight at once, across all files (1-10) |
| `maxRetries` | number | `3` | Retries per chunk and for the finalize request. `0` disables retries |
| `retryDelay` | number | `1000` | Delay before the first retry in ms (minimum 100). Doubles each attempt, with jitter |
| `maxRetryDelay` | number | `30000` | Upper limit for the retry delay in ms |
| `timeout` | number | `30000` | Per-request timeout in ms (minimum 5000). Timed-out requests are retried |
| `headers` | object | `{}` | Extra headers for every request, such as a CSRF token |
| `withCredentials` | boolean | `false` | Send cookies with cross-origin requests. The page's origin must be listed in the endpoint's `setAllowedOrigins()` |
| `resumable` | boolean | `false` | Remember uploads in `localStorage` and continue them after a page reload |

### Methods

```typescript
addFile(file: File): this
addFiles(files: File[] | FileList): this

push(): Promise<UploadStats>      // also available as upload()
pause(): void
resume(): Promise<void>
cancel(): void

onProgress(cb: (progress: UploadProgress[]) => void): this
onFileComplete(cb: (fileName: string, fileId: string, result: UploadResult) => void): this
onComplete(cb: (stats: UploadStats) => void): this
onError(cb: (error: Error, fileName: string, fileId: string) => void): this
onRetry(cb: (info: RetryInfo) => void): this

setChunkSize(bytes: number): this            // minimum 64KB, applies to files not yet started
setMaxConcurrentUploads(count: number): this
setMaxRetries(count: number): this

getStats(): UploadStats
getProgress(): UploadProgress[]
getFileProgress(fileName: string): UploadProgress | undefined
isPausedState(): boolean
getQueueSize(): number
```

How they behave:

- `push()` uploads every queued file that is not complete and resolves once each file has completed or failed. It does not reject when files fail; use `onError` or the returned stats. Calling `push()` again retries the failed files, sending only the chunks the server does not have yet. Calling it while an upload is running returns the same promise.
- `pause()` aborts in-flight chunk requests and stops starting new ones. Aborted chunks are sent again on `resume()` and do not count as retries. The `push()` promise stays pending until the upload finishes.
- `cancel()` aborts everything, asks the server to delete the stored chunks, and clears the queue and statistics. A pending `push()` resolves with `cancelled: true`; `onComplete` is not called.
- `onProgress` fires as chunks complete and whenever a file's status changes (`pending`, `uploading`, `paused`, `completed`, `failed`).
- `onFileComplete` receives the server's response data, including the name the file was stored under, which can differ from the original (see Security below).
- Exceptions thrown in your callbacks do not break the upload; they are rethrown asynchronously so they still show up in the console.

### Errors

`onError` receives a `TurboPushError` (a subclass of `Error`) carrying the server's message:

| Property | Description |
|----------|-------------|
| `message` | The server's error message when it sent one, otherwise a description such as `HTTP 502: Bad Gateway` |
| `code` | `network`, `timeout`, `http`, `server` (200 with `success: false`), `invalid_response` or `cancelled` |
| `status` | HTTP status code, if the server answered |
| `retryable` | Whether the failure was considered temporary |
| `chunkIndex` | The chunk that failed, if it was a chunk request |
| `data` | The `data` field of the server's error response |

Network errors, timeouts, invalid responses and HTTP 408, 429 and 5xx are retried. Other 4xx responses (a rejected file type, a file that is too large) fail the file straight away.

### Resuming after a reload

With `resumable: true`, each file's upload ID is stored in `localStorage` under a key made from the endpoint, file name, size and last-modified time. When the same file is added again (after a reload, or in another tab), TurboPush asks the server which chunks it already has and sends only the rest. If the server has nothing usable, for example because the chunk size changed, it starts over. The stored ID is removed when the upload completes or is cancelled. IDs are random and never leave the browser except in requests to your endpoint, so one user cannot resume into another user's upload.

## Server

### Configuration

| Method | Default | Description |
|--------|---------|-------------|
| `new TurboPushEndpoint($uploadDir, $tempDir = null)` | `./uploads/`, temp under `sys_get_temp_dir()` | Where finished files go, and where chunks wait |
| `setMaxFileSize($bytes)` | 5GB | Largest file accepted |
| `setMaxChunkSize($bytes)` | 100MB | Largest chunk accepted. PHP's `upload_max_filesize` and `post_max_size` also apply |
| `setMaxChunks($count)` | 100000 | Most chunks one upload may use |
| `setAllowedExtensions(array)` | `[]` (any) | Extension allowlist, case-insensitive |
| `setBlockedExtensions(array)` | see below | Always rejected, even without an allowlist |
| `setAllowedMimeTypes(array)` | `[]` (not checked) | Allowlist checked against the type detected from the file's contents. Wildcards such as `image/*` work. Needs `ext-fileinfo` |
| `setFileValidator(callable)` | none | `function ($path, $info)`: inspect the assembled file before it is stored. Return `false` to reject with 415, or throw `TurboPushException` to choose the message and status |
| `onComplete(callable)` | none | `function ($path, $info)`: called after the file is stored. Return an array to add fields to the response. If it throws, the file is removed and the chunks kept so the client can retry |
| `setAllowedOrigins(array)` | `[]` (same-origin only) | Other origins allowed to call the endpoint, such as `['https://app.example.com']`. They get CORS headers with credentials. `['*']` allows any origin, without credentials. See CORS below |
| `setUploadTtl($seconds)` | 86400 | Abandoned uploads are deleted after this long without activity |
| `setCleanupProbability($p)` | 0.01 | Share of requests that also run `cleanup()`. Set to 0 and call `cleanup()` from cron if you prefer |
| `enableLogging($file)` | off | Log file for activity and internal error details |

The default blocklist covers extensions a web server may execute (`php`, `php2` to `php8`, `phtml`, `phtm`, `pht`, `phar`, `phps`, `inc`, `cgi`, `pl`, `asp`, `aspx`, `ashx`, `asmx`, `jsp`, `jspx`, `shtml`, `shtm`, `htaccess`, `htpasswd`) and ones a browser runs scripts in when served from your domain (`html`, `htm`, `xhtml`, `xht`, `svg`, `svgz`, `mht`, `mhtml`, `hta`). Pass your own list to change it, or `[]` to turn it off.

Running it:

- `handle()` processes the current request, sends the JSON response and exits.
- `processRequest($server, $post, $files, $body)` returns `['status' => int, 'headers' => array, 'body' => array|null]` without sending anything, for use inside a framework controller.
- `cleanup($maxAge = null)` removes abandoned uploads and returns how many it removed.

```php
// Inside a framework controller
$result = $endpoint->processRequest($_SERVER, $_POST, $_FILES, file_get_contents('php://input'));
return new JsonResponse($result['body'], $result['status'], $result['headers']);
```

### Protocol

All requests are `POST` to the endpoint. Responses are JSON: `{"success": bool, "message": string, "data": object}`.

| Request | Body | Success `data` |
|---------|------|----------------|
| Chunk | multipart: `fileId`, `fileName`, `fileSize`, `totalChunks`, `chunkIndex`, `file` | `chunkIndex`, `totalChunks` |
| Finalize | JSON: `{"action": "finalize", "fileId", "fileName", "fileSize", "totalChunks"}` | `fileName` (as stored), `fileSize`, plus anything `onComplete` returned |
| Status | JSON: `{"action": "status", "fileId"}` | `complete`, `fileName`, `fileSize`, `totalChunks`, `receivedBytes`, `uploadedChunks` |
| Abort | JSON: `{"action": "abort", "fileId"}` | none |

`fileId` must match `[A-Za-z0-9_-]{1,200}`. JSON actions must be sent with `Content-Type: application/json`. Finalize is idempotent: repeating it after success returns the same result.

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 204 | CORS preflight |
| 400 | Malformed request: missing field, invalid ID or index, inconsistent sizes |
| 403 | Browser request (or preflight) from an origin that is not allowed |
| 404 | Unknown upload (finalize or status) |
| 405 | Method other than POST or OPTIONS |
| 409 | Conflicts with the upload so far: metadata differs from earlier chunks, chunks missing at finalize (listed in `data.missingChunks`), upload already finalized, cancelled or expired |
| 413 | Over a configured limit, or PHP's upload limits |
| 415 | Extension or MIME type not allowed, rejected by the validator, or a JSON action without `Content-Type: application/json` |
| 500 | Internal error. The client gets a generic message; details go to the log |

## Security notes

- **Authenticate first.** Anyone who can reach the endpoint can upload. Check the session or token before calling `handle()`, and add rate limiting at the web server or application level.
- **CSRF.** If you authenticate with cookies, protect against cross-site requests. The endpoint rejects browser requests from origins you have not allowed, including chunk uploads, which are ordinary multipart posts that need no preflight. That check relies on the `Origin` header, so for defence in depth also send a CSRF token in `headers` and check it. Do not use `setAllowedOrigins(['*'])` with cookie authentication.
- **Keep files out of the web root.** Store uploads where the web server will not serve or execute them, and serve them through your application. If they must be public, serve them from a separate domain or with `Content-Disposition: attachment`, because uploaded HTML or SVG can run scripts on your origin.
- **Allowlist what you expect.** Executable extensions are blocked by default, but an extension allowlist plus `setAllowedMimeTypes()` is much stronger. The MIME type is detected from the contents, not taken from the client. Use `setFileValidator()` for deeper checks such as virus scanning.
- **Limits.** Uploads above `setMaxFileSize()` are refused on the first chunk. A client cannot store more bytes than it declared, more chunks than `setMaxChunks()`, or chunks above `setMaxChunkSize()`. Set PHP's `upload_max_filesize` and `post_max_size` just above the client's `chunkSize`. Assembling a very large file takes time, so check `max_execution_time`.
- **Temp directory.** Chunks go to a folder under `sys_get_temp_dir()` named after a hash of the upload directory, created with mode 0700, so they are never in the web root. Because that location is shared, the endpoint refuses to use the folder if it is a symlink or other users can access it. If you set your own, keep it outside the web root and on a local disk: per-upload locking uses `flock()`, which is unreliable on NFS. On systems where `/tmp` is a RAM-backed tmpfs, set a temp directory on disk so large uploads do not fill memory. Abandoned uploads are deleted after `setUploadTtl()`.
- **File names.** Names are reduced to letters, digits, dots, dashes and underscores. Leading and trailing dots are removed (no `.htaccess` or `.user.ini`), inner executable extensions are neutralised (`shell.php.jpg` becomes `shell_php.jpg`), and an existing file is never overwritten: the new file gets a `_<timestamp>` suffix. The stored name is returned to the client.
- **CORS.** The endpoint is same-origin only by default: it sends no CORS headers and answers browser requests from other origins, preflights included, with 403. Requests without an `Origin` header (curl, server-to-server) are allowed. If the upload page is on another origin, list it with `setAllowedOrigins(['https://app.example.com', ...])`: those origins get `Access-Control-Allow-Origin` set to their own origin, with credentials, and responses carry `Vary: Origin`. Entries must be exact `scheme://host[:port]` origins; anything else throws. `['*']` allows any origin without credentials and has to be set explicitly. Same-origin is judged by comparing the `Origin` header with the `Host` header, so if a proxy in front of PHP rewrites `Host`, add your site's own origin to the list.
- **Errors and logs.** Error responses never include server paths. Internal details go to the log, so keep the log file outside the web root.

## Supported platforms

- **Browsers:** current Chrome, Edge, Firefox and Safari. The client targets ES2020 and needs `fetch`, `AbortController`, `FormData` and `Blob.slice`, which means Chrome/Edge 80+, Firefox 74+ and Safari 13.1+. `resumable` also needs `localStorage`.
- **Node.js:** 18 or later (tested on 18, 20, 22 and 24).
- **PHP:** 7.4 to 8.5 (all tested in CI). `ext-fileinfo` is needed only for `setAllowedMimeTypes()`. Tested on Linux.

## Demo

```bash
npm install
npm run demo
```

Then open http://localhost:8000/demo/. Files are stored under your system temp directory (`/tmp/turbopush-demo/` on Linux). The page can simulate failing chunks so you can watch the retries, and can turn on resuming after a reload. See [demo/README.md](demo/README.md).

## Development

```bash
npm install            # also builds dist/
npm test               # Jest
npm run test:coverage
npm run typecheck
npm run build          # dist/esm and dist/cjs, with .d.ts files

composer install
composer test          # PHPUnit
```

The PHPUnit suite includes concurrency tests that start real parallel PHP processes. More detail in [tests/README.md](tests/README.md).

## Upgrading from 1.0

The public API is unchanged, but a few behaviours changed. See [CHANGELOG.md](CHANGELOG.md) for the full list. The main ones:

- The PHP class is now `TurboPush\TurboPushEndpoint`. The old global name still works through `TurboPushEndpoint.php`.
- The default temp directory moved from `./uploads/temp/` to a folder under `sys_get_temp_dir()`.
- The endpoint returns specific status codes (404, 409, 413, 415, 500 and so on) instead of 400 for everything, and blocks executable and script-capable extensions (such as `php`, `html` and `svg`) by default.
- JSON actions must be sent with `Content-Type: application/json`. The bundled client always did this.
- `cancel()` now settles the pending `push()` promise instead of leaving it pending forever.
- `maxConcurrentUploads` now limits requests across all files, not per file.

## License

MIT. See [LICENSE](LICENSE).
