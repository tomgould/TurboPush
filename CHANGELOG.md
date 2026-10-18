# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - Unreleased

The public API of both the client and the PHP endpoint is backward compatible.
Some defaults and behaviours changed to fix bugs and close security holes; they
are listed under "Changed".

### Security

- Finalize did not check the file extension, so a file uploaded as `photo.jpg`
  could be finalized as `shell.php`. The endpoint now records each upload's
  name, size and chunk count from the first chunk and refuses later chunks or
  a finalize request that differ.
- Upload IDs of `.` or `..` passed the old sanitisation and pointed chunk
  storage, and the cleanup after finalize, at the parent directory. IDs must
  now match `[A-Za-z0-9_-]{1,200}` and anything else is rejected.
- With no allowlist configured (the default), any extension was accepted,
  including `.php`, and files such as `.htaccess` and `.user.ini` could be
  written. Server-executable extensions, and types browsers run scripts in
  (`html`, `svg` and similar), are now blocked by default
  (`setBlockedExtensions()`), leading and trailing dots are stripped, and
  blocked inner extensions are neutralised (`shell.php.jpg` becomes
  `shell_php.jpg`).
- Only the size declared by the client was checked, and chunks were never
  counted, so a client could fill the disk. Chunk indexes, chunk counts and
  sizes are now validated against configurable limits (`setMaxChunkSize()`,
  `setMaxChunks()`), the bytes stored per upload may not exceed the declared
  size, and abandoned chunks are removed (`cleanup()`, `setUploadTtl()`).
- Parallel or repeated requests could corrupt or overwrite files: two finalize
  requests raced each other, and a file with the same name could be truncated.
  Each upload is now locked while chunks are stored or assembled, chunks and
  the final file are written under temporary names and renamed into place, and
  final names are reserved with an exclusive create so nothing is overwritten.
- The temp directory defaulted to `./uploads/temp/`, usually inside the web
  root. It now defaults to a folder under `sys_get_temp_dir()`, created with
  mode 0700, and the endpoint refuses to use it if another user could have
  created or opened it.
- JSON actions now require `Content-Type: application/json`, so cross-site
  finalize, status and abort requests cannot be sent without a CORS
  preflight.
- Error responses could contain server paths (for example "Failed to create
  dir: /var/www/..."), and PHP errors such as a failed `fopen()` escaped as
  fatal errors. Internal errors are now logged and reported as a generic 500.
- The example endpoint wrote its log file into the public uploads folder.

### Added

- PHP: `setAllowedMimeTypes()` (detected from file contents),
  `setFileValidator()`, `onComplete()`, `setAllowedOrigins()`,
  `setMaxChunkSize()`, `setMaxChunks()`, `setBlockedExtensions()`,
  `setUploadTtl()`, `setCleanupProbability()`, `cleanup()`, and
  `processRequest()` for use inside frameworks without `exit()`.
- PHP: `status` and `abort` actions, and an idempotent finalize so retried
  requests return the original result.
- PHP: `TurboPushException` for client-safe errors with a status code.
- Client: `TurboPushError`, with `code`, `status`, `retryable`, `chunkIndex`
  and the server's `data`, passed to `onError`.
- Client: `onRetry()` callback, and a third `result` argument to
  `onFileComplete()` with the server's response (including the stored name).
- Client: `resumable` option to continue uploads after a page reload.
- Client: `maxRetryDelay` option.
- Composer package `tomgould/turbopush` with PSR-4 autoloading, and an npm
  package with ESM and CommonJS builds and type declarations.
- PHPUnit tests for the endpoint (including concurrency tests with real
  parallel processes) and many more Jest tests.
- GitHub Actions CI for Node 18 to 24 and PHP 7.4 to 8.5.
- Demo endpoint with simulated failures, and a production example.

### Changed

- PHP: the class is now `TurboPush\TurboPushEndpoint`. `TurboPushEndpoint.php`
  still loads it and keeps the global `TurboPushEndpoint` name working.
- PHP: the second constructor argument (temp directory) now defaults to a
  folder under `sys_get_temp_dir()` instead of `./uploads/temp/`.
- PHP: directories are created on the first request instead of in the
  constructor.
- PHP: errors use specific status codes: 404 unknown upload, 405 wrong method,
  409 conflicting or incomplete upload, 413 limit exceeded, 415 type not
  allowed, 500 internal error. Everything used to be 400. Preflight requests
  get 204.
- PHP: requires PHP 7.4 or later (the README previously said 7.0).
- PHP: `setAllowedExtensions()` also accepts extensions with a leading dot.
- PHP: JSON actions sent without `Content-Type: application/json` get a 415.
  The TurboPush client has always sent this header.
- Client: `maxConcurrentUploads` limits chunk requests across all files, as
  documented, instead of per file.
- Client: `cancel()` settles a pending `push()` with `cancelled: true` (it used
  to stay pending forever), sends an `abort` request to the server, and resets
  the statistics.
- Client: `push()` skips files that are already complete and, for failed
  files, sends only the chunks the server does not have (including chunks a
  finalize reported missing).
- Client: 4xx responses other than 408 and 429 are no longer retried.
- Client: `onProgress` also fires when a file's status changes.
- Client: `averageSpeed` is based on the bytes uploaded in the session rather
  than the total size.
- Client: upload IDs use `crypto.getRandomValues()` and a shortened file name.

### Fixed

- Client: after `pause()` and `resume()`, the `push()` promise never resolved
  and `onComplete` never fired.
- Client: requests aborted by `pause()` counted as failed attempts.
- Client: `maxRetries: 0` was treated as 3.
- Client: the retry delay grew linearly although documented as exponential.
- Client: the server's error message was never shown; the client read `error`
  while the endpoint sends `message`, and ignored the body of error responses.
- Client: progress assumed every chunk was `chunkSize` bytes.
- Client: calling `push()` twice re-uploaded completed files and
  double-counted the statistics.
- Client: empty files could not be uploaded.
- Client: the finalize request had no timeout or retries.
- Client: long file names produced upload IDs the server rejected.
- Client: an exception in a callback could leave an upload stuck.
- Demo: used an out-of-date copy of the client, inserted file names as HTML,
  and never showed files as completed.

## [1.0.0] - 2025-10-28

- Initial release: TypeScript client with parallel chunk uploads, retries,
  progress, pause/resume and cancel; PHP endpoint that stores and merges chunks.

[1.1.0]: https://github.com/tomgould/TurboPush/compare/f5d56d0...HEAD
[1.0.0]: https://github.com/tomgould/TurboPush/commit/f5d56d0
