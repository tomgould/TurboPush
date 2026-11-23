# TurboPush endpoint protocol

This document specifies TurboPush's native upload protocol: the HTTP exchange between the TurboPush browser client and an upload endpoint. It is written so that a compatible server can be built in any language. The reference implementation is [`php/TurboPushEndpoint.php`](php/TurboPushEndpoint.php); where this document describes "the reference implementation", it means that file. Other upload protocols the client may support are out of scope.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in RFC 2119.

Behaviour verified by the [conformance suite](conformance/README.md) is marked with the id of the check, for example [check: `upload.single-chunk`]. A requirement without a marker is not checked over HTTP, usually because it needs server internals or a long wait.

## 1. Overview

A client uploads a file in five steps:

1. It picks a random upload ID (`fileId`) and splits the file into `totalChunks` chunks.
2. It sends each chunk in its own multipart request. Chunks MAY be sent in any order, in parallel, and more than once.
3. When every chunk has been acknowledged, it sends a `finalize` request. The server checks that it has every chunk, assembles them in index order and stores the file under a safe name, which it returns.
4. To resume an interrupted upload, the client sends a `status` request and uploads only the chunks the server does not have.
5. To cancel, the client sends an `abort` request and the server deletes the chunks.

## 2. Transport

- Every operation is a `POST` to a single endpoint URL. There are no per-operation paths and no query parameters.
- `OPTIONS` is answered as a CORS preflight (section 8).
- Any other method MUST be answered with 405 and an `Allow: POST, OPTIONS` header [check: `method.not-allowed`].
- The body selects the operation:
  - A `multipart/form-data` body is a chunk upload (section 5.1).
  - A JSON object with an `action` member, sent with `Content-Type: application/json`, is a `finalize`, `status` or `abort` action (sections 5.2 to 5.4).
  - Anything else is answered with 400 [check: `request.empty`, `request.malformed-json`].
- Authentication, authorisation and rate limiting are outside the protocol. A server SHOULD apply them before handling a request. The client can send cookies (`withCredentials`) and extra headers such as `Authorization` or a CSRF token.
- Servers SHOULD be reached over HTTPS.

## 3. Responses

### 3.1 Envelope

Every response except a 204 preflight answer MUST have a JSON body of this form, with `Content-Type: application/json` (a `charset=utf-8` parameter is allowed) [check: `response.json`]:

```json
{"success": true, "message": "Chunk uploaded", "data": {"chunkIndex": 0, "totalChunks": 3}}
```

- `success` is a boolean. It MUST be `true` for 2xx responses and `false` for every other status. A server MUST NOT send `success: false` with a 2xx status; the client treats that as a permanent failure.
- `message` is a short human-readable string. The client shows it in its errors, so it MUST be safe to display and MUST NOT contain server paths or internal details (section 9.5). Clients MUST NOT parse it.
- `data` is an object. Its members for each operation are listed in section 5. An empty `data` MAY be encoded as an empty array `[]`; the reference implementation does this because of how PHP encodes empty arrays, so clients MUST accept both `{}` and `[]`.
- Clients MUST ignore members they do not know, in the envelope and in `data`.

Responses SHOULD carry `X-Content-Type-Options: nosniff` [check: `response.nosniff`] and `Cache-Control: no-store` [check: `response.no-store`].

### 3.2 Status codes

| Status | Returned when |
|--------|---------------|
| 200 | The operation succeeded. This includes a repeated `finalize` of a completed upload and an `abort` of an unknown upload. |
| 204 | A preflight (`OPTIONS`) from an allowed origin. No body. |
| 400 | The request is malformed: no operation recognised, unknown or non-string `action`, a missing or invalid field, a `fileId` outside the pattern, an integer that is not a plain non-negative integer, `totalChunks` below 1 or above `max(1, fileSize)`, `chunkIndex` not below `totalChunks`, stored bytes that would exceed `fileSize`, a chunk request without exactly one file part, or an incomplete file part. |
| 403 | The request has an `Origin` header that is neither same-origin nor allowed, including `Origin: null`. Applies to every method, including `OPTIONS` and multipart chunks. |
| 404 | `finalize` or `status` for an upload the server does not hold: never started, aborted or expired. |
| 405 | A method other than `POST` or `OPTIONS`. MUST carry `Allow: POST, OPTIONS`. |
| 409 | The request conflicts with the upload's state: metadata differs from what was recorded, `finalize` with chunks missing (listed in `data.missingChunks`), `finalize` when the stored bytes do not add up to `fileSize`, a chunk for an upload that is already finalized, or an upload removed by `abort` or expiry while the request waited for it. |
| 413 | A limit is exceeded: `fileSize` above the maximum file size, `totalChunks` above the maximum chunk count, `fileSize` above `totalChunks` times the maximum chunk size, a chunk above the maximum chunk size or a platform upload limit, or a JSON body above the JSON size limit. |
| 415 | The file type is refused: a blocked extension, an extension not on a configured allowlist, a failed content type check or a custom validator's rejection. Also a JSON action sent without `Content-Type: application/json`. |
| 500 | An internal error. The message MUST be generic (the reference implementation sends `Internal server error`); details belong in the server log. |

Error responses carry an empty `data`, except a 409 for missing chunks (section 5.2). A custom validator MAY choose its own status and add members to `data`.

The method check (405) comes first, then the origin check (403, section 8), so a request from a foreign origin never has any effect. When a request has several other problems, which status is returned is implementation-defined; clients MUST NOT depend on the order of checks.

## 4. Field formats

### 4.1 `fileId`

- The upload ID is chosen by the client. It MUST match `^[A-Za-z0-9_-]{1,200}$` in full: 1 to 200 ASCII letters, digits, `_` or `-`, with nothing before or after (a trailing newline does not match).
- The server MUST reject any other value with 400, on every operation, without trimming, decoding or rewriting it [check: `fileid.chunk`, `fileid.finalize`, `fileid.status`, `fileid.abort`]. This includes `..`, `.`, values with `/`, `\`, `%2F`, NUL bytes, dots, spaces or non-ASCII characters, the empty string and 201 characters.
- A 200-character ID using every allowed character class MUST be accepted [check: `fileid.max-length`].
- In JSON requests `fileId` MUST be a string; numbers, booleans, arrays and objects are rejected with 400.
- The ID MAY be used as a directory or file name for the upload's temporary data, and only because of this pattern.
- IDs SHOULD be unguessable. The client currently builds them from the file name (reduced to letters, digits and underscores), the size, a timestamp and 8 random bytes in hex. Anyone who knows an upload's ID can query, extend or abort it, so a server with several users SHOULD tie uploads to the authenticated user.

### 4.2 `fileName`

- The client sends the file's original name. It MUST be a non-empty string that is not only whitespace, otherwise the request is rejected with 400.
- The server MUST NOT use it as a path. Section 9.2 describes how the stored name is derived from it.
- When the server compares names (section 5), it MAY compare either the name as sent or its sanitised form. The reference implementation compares the sanitised form.

### 4.3 Integers: `fileSize`, `totalChunks`, `chunkIndex`

- In multipart fields, an integer MUST consist of ASCII decimal digits only. Values with a sign, whitespace, an exponent, a hex prefix, a decimal point, a thousands separator or non-ASCII digits, and the empty string, MUST be rejected with 400 [check: `integer.chunk-fields`]. Leading zeros MAY be accepted (the reference implementation accepts `007` as 7).
- In JSON, an integer MUST be a non-negative whole number. Negative numbers, fractions such as `3.5`, booleans, `null`, arrays, objects and strings that are not plain digits MUST be rejected with 400 [check: `finalize.fields`]. A server MAY also accept a string of digits (the reference implementation does). A JSON number written with a fraction or exponent part, such as `10.0` or `1e3`, MAY be rejected even though its value is whole: parsers in some languages cannot tell it from `10`, so the conformance suite does not test it, and clients MUST send plain integers.
- Values too large for the server to represent exactly MUST be rejected with 400 or 413 [check: `integer.overflow`]. The reference implementation accepts at most 18 digits in a multipart field or JSON string, and JSON numbers up to the 64-bit integer limit.

### 4.4 Unknown and repeated fields

- Unknown multipart fields and unknown JSON members MUST be ignored [check: `chunk.unknown-fields`, `request.json-size-allowed`], so that clients can add fields later.
- Array-style field names such as `fileId[]` are not the field `fileId`; a chunk sent with them instead of the plain names is rejected with 400 [check: `chunk.array-fields`].

## 5. Operations

### 5.1 Chunk

Request: `POST` with a `multipart/form-data` body containing these text fields and exactly one file part named `file`:

| Field | Value |
|-------|-------|
| `fileName` | Original file name |
| `fileId` | Upload ID |
| `chunkIndex` | Zero-based index of this chunk |
| `totalChunks` | Number of chunks in the upload |
| `fileSize` | Size of the whole file in bytes |
| `file` | The chunk's bytes. The part's own filename is ignored (browsers send `blob`). |

The client sends the metadata fields before the file part, so a streaming server can validate them early. Servers MUST accept the fields in any order.

The server MUST:

1. Reject a request without a `file` part, with `file` sent as a plain field, or with more than one file part under that name (such as two `file[]` parts) with 400 [check: `chunk.missing-fields`, `chunk.multiple-files`]. Reject a request missing any of the five fields with 400 [check: `chunk.missing-fields`].
2. Validate the fields (section 4) and the upload shape and limits (section 6).
3. Reject a blocked or not-allowed extension with 415. A server MAY defer this to `finalize`, but MUST NOT store a file with such a name (section 9).
4. Reject the chunk with 409 if the upload has already been finalized [check: `chunk.after-finalize`].
5. On the upload's first chunk, record `fileName`, `fileSize` and `totalChunks`. On later chunks, reject any difference in these three values with 409 [check: `metadata.chunk-mismatch`].
6. Reject a chunk larger than the maximum chunk size with 413 (section 6).
7. Keep a running total of the bytes stored for the upload, counting each index once. If storing this chunk (replacing any earlier copy of the same index) would make the total exceed `fileSize`, reject it with 400 and do not store it [check: `shape.too-many-bytes`].
8. Store the chunk under its index, replacing any earlier copy atomically, so that a partly received or partly written chunk is never used.

Response data: `{"chunkIndex": <int>, "totalChunks": <int>}`, echoing the request [check: `upload.single-chunk`].

Further rules:

- Chunks MAY arrive in any order [check: `upload.multi-chunk`] and concurrently [check: `concurrency.parallel-chunks`].
- Sending a chunk again MUST succeed and MUST NOT count its bytes twice [check: `upload.duplicate-chunk`]. Concurrent copies of one chunk with different contents MUST all succeed and leave exactly one complete copy [check: `concurrency.same-chunk`].
- An empty file is uploaded as one empty chunk with `fileSize` 0 and `totalChunks` 1 [check: `upload.empty-file`]. Clients MUST NOT send other empty chunks; a server MAY reject them with 400.
- A request whose body is incomplete (for example an aborted request) MUST NOT store a chunk.
- A rejected first chunk SHOULD leave no upload behind, so `status` still answers 404 [check: `chunk.rejected-no-state`].
- An upload exists once its first chunk is stored. A chunk that arrives after an `abort` has completed starts a new upload under the same ID. A chunk that was waiting while the upload was aborted or expired MAY be rejected with 409.

### 5.2 Finalize

Request: `POST`, `Content-Type: application/json`:

```json
{"action": "finalize", "fileId": "photo_jpg-52428800-1760800000000-9f3a1c07d2b4e861", "fileName": "photo.jpg", "fileSize": 52428800, "totalChunks": 50}
```

The server MUST:

1. Reject a missing or malformed `fileId`, `fileName`, `fileSize` or `totalChunks` with 400 [check: `finalize.fields`], and apply the shape and limit rules of section 6, before looking up the upload.
2. Answer 404 if it holds nothing for the upload [check: `finalize.unknown`].
3. If the upload is already complete, answer 200 with the same `data` as the first successful finalize [check: `finalize.idempotent`], unless `fileName` or `fileSize` differ from the completed upload, which is a 409 [check: `metadata.finalize-mismatch`]. A server MAY also compare `totalChunks` here; the reference implementation does not.
4. Reject a `fileName`, `fileSize` or `totalChunks` that differs from the recorded metadata with 409 [check: `metadata.finalize-mismatch`].
5. If any chunk from 0 to `totalChunks - 1` is missing, answer 409 with `data.missingChunks`: the missing indexes in ascending order [check: `finalize.missing-chunks`]. The list MAY be truncated; the reference implementation sends at most the first 100.
6. If the stored chunks do not add up to exactly `fileSize` bytes, answer 409 [check: `finalize.size-mismatch`].
7. Assemble the chunks in index order and store the result under a final name (section 9). The file MUST appear under its final name complete or not at all.
8. Run any configured content checks on the assembled file before it is stored, and reject a failure with 415 (or the status a custom validator chooses). A rejected file MUST NOT remain in the upload directory [check: `storage.no-stray-files`].
9. Delete the chunks and keep a completion record, so repeated finalize requests and `status` return the result until the upload expires.

Response data: `{"fileName": <stored name>, "fileSize": <int>}` plus any implementation-defined members (the reference implementation adds whatever its `onComplete` callback returns) [check: `upload.single-chunk`]. `fileName` is the name the file was stored under, which can differ from the name sent [check: `upload.no-overwrite`]. A safe, unused name SHOULD be kept unchanged [check: `upload.keeps-safe-name`].

Concurrent finalize requests for one upload MUST result in exactly one stored file, and every successful response MUST carry the same `data` [check: `finalize.parallel`]. Requests MAY wait for each other.

If something fails after the file has been stored (in the reference implementation, an exception in the `onComplete` callback), the server SHOULD remove the stored file and keep the chunks, so the client can retry the finalize request.

### 5.3 Status

Request: `{"action": "status", "fileId": "..."}` with `Content-Type: application/json`.

- Unknown upload: 404 [check: `status.unknown`].
- Upload in progress: 200 with [check: `status.in-progress`]

  | Member | Value |
  |--------|-------|
  | `complete` | `false` |
  | `fileName` | Recorded (sanitised) file name |
  | `fileSize` | Recorded file size |
  | `totalChunks` | Recorded chunk count |
  | `receivedBytes` | Bytes currently stored |
  | `uploadedChunks` | Indexes of the stored chunks, ascending |

- Completed upload: 200 with `complete: true` and the members of the finalize response data [check: `status.complete`].

Status MUST NOT change the upload's state.

### 5.4 Abort

Request: `{"action": "abort", "fileId": "..."}` with `Content-Type: application/json`.

- The server MUST delete everything it holds for the upload: chunks, metadata and completion record. Afterwards `status` and `finalize` answer 404 [check: `abort.removes-upload`].
- Abort MUST NOT delete a file that has already been stored [check: `abort.keeps-stored-file`].
- Abort of an unknown upload MUST succeed with 200, so it can be repeated safely [check: `abort.unknown`]. An invalid `fileId` is still a 400 [check: `fileid.abort`].
- Response data: empty.
- Requests for the upload that are in progress when it is aborted MAY fail with 409.

### 5.5 Actions in general

- `action` MUST be exactly one of the strings `finalize`, `status` or `abort`. Matching is case-sensitive. Any other value, including other strings, numbers, booleans, arrays and objects, MUST be answered with 400 [check: `action.unknown`, `action.non-string`].
- A body that is not valid JSON, is not an object, or has no `action` member is answered with 400 [check: `request.malformed-json`].
- A server MUST accept JSON bodies of at least 8 KiB [check: `request.json-size-allowed`] and SHOULD reject bodies larger than 64 KiB with 413 [check: `request.json-too-large`]. The reference limit is 65536 bytes.

## 6. Upload shape and limits

A server has three limits: a maximum file size, a maximum chunk size and a maximum number of chunks per upload. The reference defaults are 5 GiB, 100 MiB and 100000.

For every chunk and every finalize request, the server MUST check:

| Rule | Status |
|------|--------|
| `fileSize` is at most the maximum file size [check: `limits.file-size`, `limits.huge-file-size`] | 413 |
| `totalChunks` is at least 1 [check: `shape.zero-chunks`] | 400 |
| `totalChunks` is at most the maximum number of chunks [check: `limits.max-chunks`] | 413 |
| `totalChunks` is at most `max(1, fileSize)`: every chunk carries at least one byte, except the single chunk of an empty file [check: `shape.chunks-exceed-size`] | 400 |
| `fileSize` is at most `totalChunks` times the maximum chunk size [check: `limits.chunks-vs-size`] | 413 |
| `chunkIndex` is below `totalChunks` (chunks only) [check: `shape.chunk-index`] | 400 |

In addition, a chunk larger than the maximum chunk size MUST be rejected with 413 [check: `limits.chunk-size`], as MUST a chunk above a platform limit (PHP's `upload_max_filesize` and `post_max_size` in the reference implementation). A file larger than the maximum file size is therefore refused on its first chunk, before any data is stored. Each limit is inclusive: a value equal to the limit is accepted.

## 7. Cross-site request protection

Browsers send `text/plain`, `application/x-www-form-urlencoded` and `multipart/form-data` requests to other origins without a preflight. The protocol therefore requires:

- JSON actions MUST be sent with `Content-Type: application/json` (parameters such as `charset` are allowed). A JSON action sent with any other content type (apart from the two covered by the next point), or none, MUST be rejected with 415 and MUST have no effect [check: `action.content-type`, `csrf.simple-requests`]. Because `application/json` is not a simple content type, a cross-origin action always needs a preflight, which the origin check refuses.
- The media type SHOULD be compared exactly and case-insensitively, ignoring parameters: `Application/JSON; charset=utf-8` is accepted, while a type that only starts with it, such as `application/jsonx`, is rejected with 415 [check: `action.content-type-exact`].
- A urlencoded or multipart body is never treated as an action, even if it contains an `action` field or a JSON text. It MUST be rejected with a 4xx status and MUST have no effect; the reference implementation handles it as a chunk and answers 400 because it has no file [check: `csrf.simple-requests`].
- Chunks are multipart and need no preflight, so they rely on the origin check of section 8. A cookie-authenticated server SHOULD also check a CSRF token, which the client can send through its `headers` option.

## 8. Origins and CORS

### 8.1 Origin check

The origin check runs before any other processing, for every method including `OPTIONS`:

- A request without an `Origin` header MUST be allowed. Non-browser clients do not send one [check: `cors.no-origin`].
- A same-origin request MUST be allowed [check: `cors.same-origin`]. Same-origin means the `Origin` header is a valid serialised origin (`scheme://host[:port]`) whose host, followed by `:port` if the origin has a port, equals the request's `Host` header, compared case-insensitively. The reference implementation compares the scheme only when it received the request over HTTPS itself, because behind a TLS-terminating proxy it sees plain HTTP. If a proxy rewrites `Host`, the site's own origin has to be added to the allowlist.
- `Origin: null` MUST be refused [check: `cors.null-origin`]. Any sandboxed page can send it, so it can neither be same-origin nor be listed.
- Any other origin MUST be refused with 403 unless it is on the allowlist [check: `cors.foreign-json`, `cors.foreign-chunk`, `cors.foreign-preflight`]. This includes origins that only resemble the endpoint: another port, the host as a prefix of another host, userinfo or a path [check: `cors.lookalike-origins`]. A refused request MUST have no effect: a refused chunk is not stored and a refused abort deletes nothing.

### 8.2 CORS headers

- By default (no allowlist) the server is same-origin only and MUST NOT send any CORS headers. Responses to refused origins MUST NOT carry `Access-Control-Allow-Origin` [check: `cors.foreign-json`, `cors.foreign-chunk`, `cors.foreign-preflight`].
- With an allowlist, entries are exact `scheme://host[:port]` origins, compared after lowercasing and removing a trailing slash. For a request from a listed origin the server MUST send `Access-Control-Allow-Origin` set to the listed entry (never copied from the request) and `Vary: Origin` [check: `cors.allowlist-request`], and SHOULD send `Access-Control-Allow-Credentials: true` [check: `cors.allowlist-credentials`]. In allowlist mode the reference implementation sends `Vary: Origin` on every response, including refusals.
- A preflight from a listed origin MUST be answered with a 2xx status (SHOULD be 204, with no body) whose `Access-Control-Allow-Methods` includes `POST` and whose `Access-Control-Allow-Headers` includes `Content-Type` [check: `cors.allowlist-preflight`]. The reference implementation sends `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers` (see the next point) and `Access-Control-Max-Age: 600`.
- A preflight SHOULD also allow the other request headers it asks for in `Access-Control-Request-Headers`, such as a CSRF token header the client is configured to send [check: `cors.allowlist-request-headers`]. If `Access-Control-Allow-Headers` depends on `Access-Control-Request-Headers`, the response SHOULD carry `Vary: Access-Control-Request-Headers` [check: `cors.allowlist-request-headers`]. The reference implementation allows `Content-Type, Authorization, X-Requested-With` plus every syntactically valid header name the preflight asks for (at most 20), and sends `Vary: Origin, Access-Control-Request-Headers` on preflights from a listed origin (`Vary: Access-Control-Request-Headers` with `*`).
- An allowlist of `*` allows every origin and sends `Access-Control-Allow-Origin: *` without credentials. It MUST be an explicit opt-in, never the default. The conformance suite assumes it is not in use.

## 9. Storage and file names

### 9.1 Temporary data

- Chunks and upload metadata MUST be stored outside any directory the web server serves, keyed by `fileId`.
- Temporary data MUST NOT be created outside the server's temporary directory, whatever the request contains.
- The reference implementation keeps each upload in `<temp dir>/<fileId>/`, with chunks named `chunk_<index padded to 10 digits>`, metadata in `upload.json`, a completion record in `complete.json` and a lock file `.lock`. Its default temporary directory is under the system temp directory, created with mode 0700, and is refused if it is a symlink or accessible to other users.

### 9.2 Stored file names

The stored name is derived from the client's `fileName`. Whatever algorithm a server uses, the stored name MUST:

- be a single path segment: no `/`, `\` or NUL, so nothing is ever written outside the upload directory [check: `filename.traversal`];
- not start with a dot, so names such as `.htaccess` or `.user.ini` cannot create hidden or configuration files [check: `filename.dangerous`];
- not end with a dot or a space, which Windows drops [check: `filename.dangerous`];
- not have a blocked final extension (those uploads are rejected, see 9.3) [check: `filename.dangerous`];
- not contain a blocked extension as an inner segment, because some web servers execute `shell.php.jpg` [check: `filename.dangerous`];
- be at most 255 bytes long [check: `filename.long`].

The reference implementation:

1. removes NUL bytes, treats `\` as `/` and keeps only the part after the last `/`;
2. replaces every character other than ASCII letters, digits, `.`, `-` and `_` with `_`;
3. removes leading and trailing dots;
4. truncates names over 200 bytes, keeping an extension of up to 20 characters;
5. replaces the dot before any inner segment that is a blocked extension with `_` (`shell.php.jpg` becomes `shell_php.jpg`);
6. prefixes Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`) with `_`;
7. uses `file` if nothing is left.

For example, `../../evil.txt` and `C:\evil.txt` are stored as `evil.txt`, and `.htaccess` as `htaccess`.

### 9.3 Extensions

- A server MUST reject a file whose final extension is blocked with 415, at chunk or at finalize time [check: `filename.dangerous`]. Extensions are compared case-insensitively, on the sanitised name, so `shell.PHP` and `shell.php.` are both caught.
- The default blocklist covers extensions a web server may execute and types a browser runs scripts in when served from the site's origin: `php`, `php2` to `php8`, `phtml`, `phtm`, `pht`, `phar`, `phps`, `inc`, `cgi`, `pl`, `asp`, `aspx`, `ashx`, `asmx`, `jsp`, `jspx`, `shtml`, `shtm`, `htaccess`, `htpasswd`, `html`, `htm`, `xhtml`, `xht`, `svg`, `svgz`, `mht`, `mhtml` and `hta`.
- A server MAY let operators change the blocklist or add an extension allowlist; an extension not on a configured allowlist is rejected with 415. The conformance suite expects the default blocklist.
- A server MAY check the assembled file's contents (the reference implementation can match the MIME type detected from the contents against an allowlist, and run a custom validator) and reject a failure with 415.

### 9.4 Never overwrite

- A new upload MUST NOT overwrite an existing file [check: `upload.no-overwrite`]. If the name is taken, the server picks another one. The reference implementation tries `name.ext`, then `name_<unix time>.ext`, then `name_<unix time>_<n>.ext`.
- Reserving the name MUST be atomic, so uploads of the same name finalized at the same time get distinct files [check: `concurrency.same-name`].
- The stored name is returned in `data.fileName` of the finalize response; clients MUST use it rather than the name they sent.
- When a request completes, the upload directory MUST NOT contain any new file other than the stored files the server reported [check: `storage.no-stray-files`]. Files a server keeps there independently of uploads, such as an access-control file written at installation, are outside this rule; the conformance suite ignores files that exist after its first upload, which it makes before running the checks. The reference implementation assembles into a hidden `.turbopush-<hex>.part` file in the upload directory and renames it into place; cleanup removes such files if a crash leaves one behind.

### 9.5 Errors

Error responses MUST NOT reveal server paths, stack traces or other internal details [check: `errors.no-server-paths`]. Unexpected failures are answered with a generic 500; details belong in the server log, which SHOULD be outside the web root.

## 10. Concurrency

The client sends several chunks of a file at once and may retry a request while an earlier attempt is still running. A server MUST serialise the work on one upload: storing a chunk and updating the byte count, finalizing, reading the status and aborting. The reference implementation holds an exclusive `flock()` on the upload's lock file for each of these, which is unreliable on NFS.

The observable requirements are in sections 5.1, 5.2 and 9.4 [check: `concurrency.parallel-chunks`, `concurrency.same-chunk`, `finalize.parallel`, `concurrency.same-name`].

## 11. Expiry and cleanup

- A server MUST eventually delete the temporary data of uploads that see no activity, and SHOULD document the delay. The reference implementation deletes uploads with no activity for 24 hours (`setUploadTtl()`), either on a random 1% of requests or from cron (`cleanup()`).
- Completion records expire the same way. After expiry, `status` and `finalize` answer 404, and a client resuming the upload starts again.
- Cleanup MUST NOT delete an upload while a request is working on it, and MUST NOT delete files it did not create.
- The conformance suite does not check expiry, because it would have to wait for the delay.

## 12. Client behaviour (informative)

This section describes how the TurboPush client uses the protocol. The README has the full option reference.

- **IDs and chunks.** Each file gets a new random `fileId` (section 4.1). Chunks have equal sizes (default 1 MiB, minimum 64 KiB) with a shorter last chunk; an empty file is one empty chunk. Up to `maxConcurrentUploads` chunk requests (default 3) are in flight across all files.
- **Retries.** Network errors, timeouts, responses that are not JSON, and HTTP 408, 429 and 5xx are retried, up to `maxRetries` times (default 3) per chunk. The delay starts at `retryDelay` (default 1 s), doubles with each attempt up to `maxRetryDelay` (default 30 s), and is randomised between half and all of that value. Any other 4xx, and a 2xx with `success: false`, fails the file at once.
- **Finalize.** Once every chunk is acknowledged the client sends `finalize`, retrying it under the same rules; this is safe because finalize is idempotent. If finalize answers 409 with `missingChunks`, those chunks are marked as not uploaded; on a 404, or a 409 without a list, all chunks are. The file then fails, and calling `push()` again sends the marked chunks and finalizes again.
- **Resuming.** With `resumable: true`, the client stores each upload's `fileId` in `localStorage`, keyed by the endpoint, file name, size and last-modified time. When the same file is added again, it sends `status`:
  - 404: it starts a new upload;
  - `complete: true` with a matching `fileSize`: the file is reported as completed with the returned data;
  - `complete: false` with matching `fileSize` and `totalChunks`: it skips the chunks in `uploadedChunks` and sends the rest;
  - anything else, including other errors: it sends `abort` and starts again.
- **Pause and cancel.** Pausing aborts in-flight chunk requests; those chunks are sent again on resume, so a server sees incomplete requests and duplicates. Cancelling aborts everything and sends `abort` for each unfinished upload as a best-effort request; abandoned uploads are left to expiry.

## 13. Conformance suite

[`conformance/`](conformance/README.md) holds an HTTP-level test suite for any server that implements this protocol:

```bash
node conformance/run.mjs --url https://uploads.example.test/endpoint \
  --max-file-size 8388608 --max-chunk-size 262144 --max-chunks 64 --upload-dir /srv/uploads
```

Each check has an id, used in the markers above, and a severity: a failed MUST check fails the run, a failed SHOULD check is reported as a warning. Checks that need a limit, the upload directory or an allowlisted origin are skipped when that input is not given. `node conformance/php.mjs` runs the suite against the reference implementation.
