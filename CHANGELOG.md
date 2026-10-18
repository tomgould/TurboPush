# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-10-18

The client now speaks tus 1.0.0 as well as TurboPush's own protocol, so it
works with tusd, tus-node-server, tus-php and the other tus servers. The
native protocol is specified in PROTOCOL.md and checked by a conformance
suite. Nothing changes for existing setups: the default protocol and the
public API are the same.

### Added

- Client: `protocol: 'tus'` selects the tus transport. It discovers the
  server's extensions (OPTIONS), creates uploads (POST with
  `Upload-Length` and `Upload-Metadata`, including `filename` and
  `filetype`), sends chunks (PATCH), finds the offset with HEAD after a
  failure, pause or reload, deletes unfinished uploads on `cancel()` when
  the server supports termination, sends `Upload-Checksum` when the server
  offers sha1/sha256/sha384/sha512 and Web Crypto is available, and
  respects `Tus-Max-Size`.
- Client: with the concatenation extension, a file's chunks are uploaded in
  parallel as up to `maxConcurrentUploads` partial uploads joined by a
  final request. Without it, a file's chunks are sent in order (several
  files still upload at once).
- Client: retries with backoff, pause/resume, cancel, progress and
  `resumable` work with tus. Resumable mode keeps the upload URLs in
  `localStorage` and continues from the server's offsets after a reload.
- Client: `tus` options `metadata`, `parallel` and `checksum`;
  `UploadResult.uploadUrl`; exported types `TurboPushProtocol` and
  `TusOptions`.
- PROTOCOL.md: a full specification of the native endpoint protocol.
- Conformance suite (`npm run conformance -- --url ...`) that checks a
  server against PROTOCOL.md over HTTP, including path traversal, dangerous
  extensions, limits, parallel and repeated finalize, abort cleanup and
  cross-origin rejection. `npm run conformance:php` runs it against the PHP
  endpoint on PHP's built-in server, and CI does so on every PHP version.
- Interop tests against tusd (with and without concatenation) and tus-php
  in Docker (`npm run interop`), also run in CI.
- README: "TurboPush or tus?" and "Using a tus server".

### Changed

- PHP: CORS preflights from an allowed origin (listed or `*`) also allow
  the request headers the browser asks for in
  `Access-Control-Request-Headers`, and carry
  `Vary: Access-Control-Request-Headers`. A cross-origin page can now send
  its own headers, such as a CSRF token, through the client's `headers`
  option. Other origins still get no CORS headers.

### Fixed

- PHP: the `action` field of JSON requests is compared strictly. A
  non-string value such as `true` (or `0` on PHP 7) used to match
  `finalize`, because PHP's `switch` compares loosely, and with a full
  payload it finalized the upload.
- PHP: JSON actions need the media type to be exactly `application/json`
  (parameters such as `charset` are allowed). The check matched a prefix,
  so `application/jsonx` was accepted.

## [2.0.0] - 2026-10-18

A major release. The PHP endpoint was hardened throughout and the client's
upload engine was reworked. Existing method calls keep working, but some
requirements, defaults and behaviours changed; they are listed under
"Breaking changes", and "Upgrading from 1.x" says what to check.

### Breaking changes

- PHP: requires PHP 7.4 or later (the README previously said 7.0).
- PHP: the class is now `TurboPush\TurboPushEndpoint`. `TurboPushEndpoint.php`
  is kept as a shim that loads it and keeps the global `TurboPushEndpoint`
  name working.
- PHP: CORS is same-origin only by default. 1.x sent
  `Access-Control-Allow-Origin: *` to everyone; 2.0 sends no CORS headers and
  rejects browser requests (including preflights) from other origins with
  403. Origins listed with `setAllowedOrigins()` are allowed, with
  credentials, and get `Vary: Origin`; `['*']` must now be set explicitly.
  `setAllowedOrigins([])` means same-origin only (it used to turn CORS
  headers and the origin check off), and invalid entries such as
  `app.example.com` (no scheme), a path, a wildcard or `null` throw an
  `InvalidArgumentException`.
- PHP: errors use specific status codes: 403 origin not allowed, 404 unknown
  upload, 405 wrong method, 409 conflicting or incomplete upload, 413 limit
  exceeded, 415 type not allowed, 500 internal error. Everything used to be
  400. Preflight requests get 204 (403 from origins that are not allowed).
- PHP: JSON actions (finalize, status, abort) sent without
  `Content-Type: application/json` get a 415. The TurboPush client has always
  sent this header.
- PHP: executable and script-capable extensions (`php`, `phtml`, `phar`,
  `html`, `svg` and others) are blocked by default, even without an
  allowlist. See `setBlockedExtensions()`.
- PHP: the second constructor argument (temp directory) defaults to a folder
  under `sys_get_temp_dir()` instead of `./uploads/temp/`.
- Client: `cancel()` settles a pending `push()` with `cancelled: true` (it
  used to stay pending forever), sends an `abort` request to the server, and
  resets the statistics.
- Client: `maxConcurrentUploads` limits chunk requests across all files, as
  documented, instead of per file.

### Upgrading from 1.x

1. Make sure the server runs PHP 7.4 or later.
2. Code that requires `TurboPushEndpoint.php` and uses the global
   `TurboPushEndpoint` class keeps working. With Composer, use
   `TurboPush\TurboPushEndpoint`.
3. If the upload page is served from a different origin than the endpoint,
   list it: `setAllowedOrigins(['https://app.example.com'])`. Use `['*']`
   only if you really want any site to call the endpoint, and never with
   cookie authentication. If a proxy in front of PHP rewrites the `Host`
   header, same-origin requests look cross-origin, so add your site's own
   origin as well.
4. If your code checks for status 400, handle the new codes (or treat any
   4xx as a rejected upload).
5. A custom client must send JSON actions with
   `Content-Type: application/json`.
6. If you upload HTML, SVG or other blocked types on purpose, pass your own
   list to `setBlockedExtensions()`.
7. Pass a temp directory to the constructor if chunks must live somewhere
   specific. The old `./uploads/temp/` folder can be deleted.
8. Code that waited on `push()` after `cancel()` now gets a result: check
   `stats.cancelled`.

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
- Any website could call the endpoint from a visitor's browser, because the
  default CORS policy was `*` and cross-origin chunk uploads (ordinary
  multipart posts) were accepted. The endpoint is now same-origin only unless
  you list other origins (see "Breaking changes").
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

- PHP: directories are created on the first request instead of in the
  constructor.
- PHP: `setAllowedExtensions()` also accepts extensions with a leading dot.
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

[2.1.0]: https://github.com/tomgould/TurboPush/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/tomgould/TurboPush/compare/f5d56d0...v2.0.0
[1.0.0]: https://github.com/tomgould/TurboPush/commit/f5d56d0
