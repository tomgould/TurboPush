<?php

namespace TurboPush;

/**
 * TurboPush Server Endpoint
 *
 * Handles chunked file uploads from the TurboPush JavaScript/TypeScript client library.
 * Receives file chunks, stores them temporarily, and merges them into final files.
 *
 * Features:
 * - Chunked upload handling with per-upload locking
 * - Atomic chunk writes and atomic file assembly
 * - Strict validation of upload IDs, chunk indexes, counts and sizes
 * - Filename sanitisation, extension allowlist and a default blocklist
 *   of server-executable extensions
 * - Optional MIME type allowlist and custom validation hook
 * - Temporary chunks kept outside the web root by default, with automatic
 *   cleanup of abandoned uploads
 * - Status and abort actions for resuming and cancelling uploads
 * - Same-origin only by default, with an optional CORS origin allowlist
 * - Optional logging
 *
 * @package    TurboPush
 * @version    2.0.0
 * @license    MIT
 * @author     TomGould
 *
 * @example
 * ```php
 * use TurboPush\TurboPushEndpoint;
 *
 * $turbopush = new TurboPushEndpoint('/var/www/uploads/');
 * $turbopush
 *     ->setMaxFileSize(10 * 1024 * 1024 * 1024)  // 10GB
 *     ->setAllowedExtensions(['jpg', 'png', 'pdf'])
 *     ->enableLogging('/var/log/turbopush.log')
 *     ->handle();
 * ```
 */

/**
 * TurboPushEndpoint Class
 *
 * Main server-side handler for TurboPush chunked file uploads.
 * Manages chunk reception, storage, validation, and final file assembly.
 *
 * @class TurboPushEndpoint
 * @since 1.0.0
 */
class TurboPushEndpoint
{
    /**
     * Upload IDs may only contain letters, digits, dashes and underscores,
     * so they can never point outside the temporary directory.
     */
    const UPLOAD_ID_PATTERN = '/^[A-Za-z0-9_-]{1,200}$/D';

    /**
     * Maximum size of a JSON request body (finalize requests) in bytes
     */
    const MAX_JSON_BODY = 65536;

    /**
     * Name of the metadata file kept in each upload's temporary directory
     */
    const META_FILE = 'upload.json';

    /**
     * Name of the marker file written once an upload has been assembled
     */
    const DONE_FILE = 'complete.json';

    /**
     * Name of the lock file used to serialise work on one upload
     */
    const LOCK_FILE = '.lock';

    /**
     * Directory where final merged files are stored
     * @var string
     */
    private $uploadDir = './uploads/';

    /**
     * Directory where temporary chunk files are stored during upload
     * @var string
     */
    private $tempDir;

    /**
     * Maximum allowed file size in bytes (default: 5GB)
     * @var int
     */
    private $maxFileSize = 5368709120; // 5GB

    /**
     * Maximum allowed size of a single chunk in bytes (default: 100MB)
     * @var int
     */
    private $maxChunkSize = 104857600; // 100MB

    /**
     * Maximum number of chunks a single upload may be split into (default: 100000)
     * @var int
     */
    private $maxChunks = 100000;

    /**
     * Array of allowed file extensions (empty array = all extensions allowed)
     * @var array
     */
    private $allowedExtensions = [];

    /**
     * Extensions that are always rejected: ones a web server may execute, and
     * ones a browser runs scripts in when served from your domain.
     * Applied even when no allowlist is set. Override with setBlockedExtensions().
     * @var array
     */
    private $blockedExtensions = [
        'php', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'phtm',
        'pht', 'phar', 'phps', 'inc', 'cgi', 'pl', 'asp', 'aspx', 'ashx', 'asmx', 'jsp',
        'jspx', 'shtml', 'shtm', 'htaccess', 'htpasswd',
        'html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'mht', 'mhtml', 'hta',
    ];

    /**
     * Allowed MIME types, detected from file contents (empty array = not checked)
     * @var array
     */
    private $allowedMimeTypes = [];

    /**
     * Custom validator called with the assembled file before it is stored
     * @var callable|null
     */
    private $fileValidator = null;

    /**
     * Callback called after a file has been stored
     * @var callable|null
     */
    private $completeCallback = null;

    /**
     * Seconds after the last activity before an upload's chunks are removed (default: 24 hours)
     * @var int
     */
    private $uploadTtl = 86400;

    /**
     * Probability (0-1) that a request also runs cleanup() (default: 0.01)
     * @var float
     */
    private $cleanupProbability = 0.01;

    /**
     * Origins allowed to call the endpoint cross-origin ([] = same-origin only, ['*'] = any)
     * @var array
     */
    private $allowedOrigins = [];

    /**
     * Path to log file (null = logging disabled)
     * @var string|null
     */
    private $logFile = null;

    /**
     * Whether the temp directory is the shared-location default
     * @var bool
     */
    private $defaultTempDir = false;

    /**
     * Constructs a new TurboPushEndpoint instance
     *
     * Directories are created on first use, not here, so a misconfigured
     * path is reported through the normal error response.
     *
     * @param string      $uploadDir Directory for final uploaded files (default: './uploads/')
     * @param string|null $tempDir   Directory for temporary chunk storage. Defaults to a
     *                               folder under sys_get_temp_dir(), outside the web root.
     *
     * @example
     * ```php
     * $endpoint = new TurboPushEndpoint('/var/www/uploads/', '/var/tmp/turbopush/');
     * ```
     */
    public function __construct($uploadDir = './uploads/', $tempDir = null) {
        // Normalize directory paths with trailing slashes
        $this->uploadDir = rtrim($uploadDir, '/\\') . '/';
        $this->defaultTempDir = $tempDir === null;
        $this->tempDir = rtrim($tempDir !== null ? $tempDir : $this->defaultTempDir(), '/\\') . '/';
    }

    /**
     * Sets the maximum allowed file size
     *
     * Files exceeding this size will be rejected during chunk upload.
     *
     * @param int $bytes Maximum file size in bytes
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->setMaxFileSize(10 * 1024 * 1024 * 1024); // 10GB
     * ```
     */
    public function setMaxFileSize($bytes) {
        $this->maxFileSize = max(0, (int) $bytes);
        return $this;
    }

    /**
     * Sets the maximum allowed size of a single chunk
     *
     * Must be at least the chunkSize configured on the client.
     * PHP's upload_max_filesize and post_max_size also apply.
     *
     * @param int $bytes Maximum chunk size in bytes
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->setMaxChunkSize(10 * 1024 * 1024); // 10MB
     * ```
     */
    public function setMaxChunkSize($bytes) {
        $this->maxChunkSize = max(1, (int) $bytes);
        return $this;
    }

    /**
     * Sets the maximum number of chunks a single upload may use
     *
     * Limits how many files one upload can create in the temporary directory.
     *
     * @param int $count Maximum number of chunks
     * @return $this Fluent interface for method chaining
     */
    public function setMaxChunks($count) {
        $this->maxChunks = max(1, (int) $count);
        return $this;
    }

    /**
     * Sets allowed file extensions
     *
     * Only files with these extensions will be accepted.
     * Extensions are case-insensitive. Empty array allows all extensions
     * except the blocked ones (see setBlockedExtensions()).
     *
     * @param array $extensions Array of allowed extensions without dots (e.g., ['jpg', 'png'])
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->setAllowedExtensions(['jpg', 'png', 'pdf', 'zip']);
     * ```
     */
    public function setAllowedExtensions($extensions) {
        $this->allowedExtensions = $this->normalizeExtensions($extensions);
        return $this;
    }

    /**
     * Sets extensions that are always rejected
     *
     * By default this blocks extensions a web server may execute (php, phtml,
     * phar, cgi, asp, jsp and similar) and types a browser runs scripts in
     * when served from your domain (html, htm, xhtml, svg and similar). Pass
     * an empty array to disable the blocklist, for example when uploads are
     * stored outside the web root and an allowlist is in place.
     *
     * @param array $extensions Array of blocked extensions without dots
     * @return $this Fluent interface for method chaining
     */
    public function setBlockedExtensions($extensions) {
        $this->blockedExtensions = $this->normalizeExtensions($extensions);
        return $this;
    }

    /**
     * Sets allowed MIME types
     *
     * The type is detected from the assembled file's contents with the
     * fileinfo extension, not taken from the client. Wildcards such as
     * 'image/*' are supported. Empty array disables the check.
     *
     * @param array $mimeTypes Allowed MIME types (e.g., ['image/png', 'image/*'])
     * @return $this Fluent interface for method chaining
     * @throws \RuntimeException If the fileinfo extension is not available
     *
     * @example
     * ```php
     * $endpoint->setAllowedMimeTypes(['image/jpeg', 'image/png', 'application/pdf']);
     * ```
     */
    public function setAllowedMimeTypes($mimeTypes) {
        $normalized = [];
        foreach ((array) $mimeTypes as $mimeType) {
            $mimeType = strtolower(trim((string) $mimeType));
            if ($mimeType !== '') {
                $normalized[] = $mimeType;
            }
        }

        if (!empty($normalized) && !class_exists('finfo')) {
            throw new \RuntimeException('setAllowedMimeTypes() requires the fileinfo extension');
        }

        $this->allowedMimeTypes = $normalized;
        return $this;
    }

    /**
     * Sets a custom validator for assembled files
     *
     * Called with the path of the assembled (not yet stored) file and an info
     * array with fileId, fileName, fileSize and mimeType. Return false to
     * reject the file with 415, or throw a TurboPushException to choose the
     * message and status code. Useful for virus scans or image checks.
     *
     * @param callable|null $validator function (string $path, array $info): bool|void
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->setFileValidator(function ($path, $info) {
     *     return getimagesize($path) !== false;
     * });
     * ```
     */
    public function setFileValidator($validator) {
        $this->fileValidator = $validator;
        return $this;
    }

    /**
     * Registers a callback for stored files
     *
     * Called with the final path and an info array with fileId, fileName
     * (the stored name), originalName, fileSize and mimeType. Return an array
     * to add fields to the response data. If the callback throws, the stored
     * file is removed and the chunks are kept so the client can retry.
     *
     * @param callable|null $callback function (string $path, array $info): array|void
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->onComplete(function ($path, $info) use ($db) {
     *     return ['id' => $db->insertUpload($path, $info['fileSize'])];
     * });
     * ```
     */
    public function onComplete($callback) {
        $this->completeCallback = $callback;
        return $this;
    }

    /**
     * Sets how long abandoned uploads are kept
     *
     * Chunks of uploads with no activity for this long are removed by
     * cleanup(). Completed uploads keep a small marker for the same time so
     * repeated finalize requests are answered correctly.
     *
     * @param int $seconds Time since the last activity (default: 86400)
     * @return $this Fluent interface for method chaining
     */
    public function setUploadTtl($seconds) {
        $this->uploadTtl = max(0, (int) $seconds);
        return $this;
    }

    /**
     * Sets the probability that a request also runs cleanup()
     *
     * Works like PHP's session garbage collection. Set to 0 and call
     * cleanup() from cron instead if you prefer.
     *
     * @param float $probability Between 0 (never) and 1 (every request), default 0.01
     * @return $this Fluent interface for method chaining
     */
    public function setCleanupProbability($probability) {
        $this->cleanupProbability = min(1.0, max(0.0, (float) $probability));
        return $this;
    }

    /**
     * Sets the origins allowed to call the endpoint cross-origin
     *
     * By default (or with an empty array) the endpoint is same-origin only:
     * it sends no CORS headers and rejects browser requests from other
     * origins with 403. A list of origins allows those as well, with
     * credentials: their requests (including preflights) get
     * Access-Control-Allow-Origin set to the matching entry, and responses
     * carry Vary: Origin. ['*'] allows any origin, without credentials.
     *
     * Same-origin requests and requests without an Origin header (non-browser
     * clients) are always allowed.
     *
     * @param array|string $origins Origins such as ['https://app.example.com'], or ['*']
     * @return $this Fluent interface for method chaining
     * @throws \InvalidArgumentException If an entry is not '*' or a scheme://host[:port] origin
     *
     * @example
     * ```php
     * $endpoint->setAllowedOrigins(['https://app.example.com', 'https://admin.example.com']);
     * ```
     */
    public function setAllowedOrigins($origins) {
        $normalized = [];
        foreach ((array) $origins as $origin) {
            $origin = strtolower(rtrim(trim((string) $origin), '/'));
            if ($origin === '') {
                continue;
            }
            if ($origin !== '*' && !$this->isValidOrigin($origin)) {
                // Catches typos such as a missing scheme or a path, which would
                // never match, and 'null', which any sandboxed page can send
                throw new \InvalidArgumentException('Invalid origin: ' . $origin);
            }
            $normalized[] = $origin;
        }
        $this->allowedOrigins = array_values(array_unique($normalized));
        return $this;
    }

    /**
     * Enables logging to a file
     *
     * All upload activities will be logged with timestamps.
     * Keep the log file outside the web root.
     *
     * @param string $logFile Path to log file
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->enableLogging('/var/log/turbopush.log');
     * ```
     */
    public function enableLogging($logFile) {
        $this->logFile = $logFile;
        return $this;
    }

    /**
     * Main request handler
     *
     * Processes the current request, sends the JSON response and exits.
     * Use processRequest() instead when integrating with a framework.
     *
     * @return void Outputs JSON response and exits
     *
     * @example
     * ```php
     * $endpoint = new TurboPushEndpoint('/var/www/uploads/');
     * $endpoint->handle(); // Process the current request
     * ```
     */
    public function handle() {
        $response = $this->processRequest($_SERVER, $_POST, $_FILES, $this->readRequestBody($_SERVER));
        $this->sendResponse($response);
        exit;
    }

    /**
     * Processes a request without sending output
     *
     * Useful for frameworks: pass the request superglobals (or their framework
     * equivalents) and turn the returned array into a response yourself.
     *
     * @param array  $server Server parameters, usually $_SERVER
     * @param array  $post   Parsed form fields, usually $_POST
     * @param array  $files  Uploaded files, usually $_FILES
     * @param string $body   Raw request body (used for JSON requests)
     * @return array Response as ['status' => int, 'headers' => array, 'body' => array|null]
     *
     * @since 2.0.0
     */
    public function processRequest(array $server, array $post, array $files, $body = '') {
        $response = $this->dispatch($server, $post, $files, $body);

        $headers = $response['headers'] + $this->corsHeaders($server);
        if ($response['body'] !== null) {
            $headers += [
                'Content-Type' => 'application/json; charset=utf-8',
                'X-Content-Type-Options' => 'nosniff',
                'Cache-Control' => 'no-store',
            ];
        }
        $response['headers'] = $headers;

        return $response;
    }

    /**
     * Routes a request and turns exceptions into error responses
     *
     * @param array  $server Server parameters
     * @param array  $post   Form fields
     * @param array  $files  Uploaded files
     * @param string $body   Raw request body
     * @return array Response array
     *
     * @private
     */
    private function dispatch(array $server, array $post, array $files, $body) {
        try {
            $method = isset($server['REQUEST_METHOD']) ? strtoupper($server['REQUEST_METHOD']) : 'GET';

            if ($method !== 'POST' && $method !== 'OPTIONS') {
                throw new TurboPushException('Method not allowed', 405);
            }

            if (!$this->isOriginAllowed($server)) {
                throw new TurboPushException('Origin not allowed', 403);
            }

            // Answer CORS preflight requests (the CORS headers are added by processRequest())
            if ($method === 'OPTIONS') {
                return ['status' => 204, 'headers' => [], 'body' => null];
            }

            $this->maybeCleanup();

            // Multipart requests carry chunks
            if (!empty($files) || !empty($post)) {
                return $this->handleChunk($post, $files);
            }

            $body = (string) $body;
            if (strlen($body) > self::MAX_JSON_BODY) {
                throw new TurboPushException('Request body too large', 413);
            }

            // JSON requests carry actions
            $json = $body !== '' ? json_decode($body, true) : null;
            if (is_array($json) && isset($json['action'])) {
                // Requiring the JSON content type means browsers must send a CORS
                // preflight for cross-site actions, which blocks simple CSRF
                if (!isset($server['CONTENT_TYPE']) || stripos($server['CONTENT_TYPE'], 'application/json') !== 0) {
                    throw new TurboPushException('Content-Type must be application/json', 415);
                }
                return $this->handleAction($json);
            }

            // PHP drops the whole body when it exceeds post_max_size
            $postMaxSize = $this->iniBytes((string) ini_get('post_max_size'));
            if ($this->isMultipart($server) && isset($server['CONTENT_LENGTH'])
                && $postMaxSize > 0 && (int) $server['CONTENT_LENGTH'] > $postMaxSize) {
                throw new TurboPushException('Chunk exceeds the server upload size limit', 413);
            }

            throw new TurboPushException('No file uploaded', 400);
        } catch (TurboPushException $e) {
            $this->log('REJECTED (' . $e->getHttpStatus() . '): ' . $e->getMessage());
            $headers = $e->getHttpStatus() === 405 ? ['Allow' => 'POST, OPTIONS'] : [];
            return $this->errorResponse($e->getHttpStatus(), $e->getMessage(), $e->getData(), $headers);
        } catch (\Throwable $e) {
            // Never expose internal details (paths, PHP errors) to the client
            $this->log('ERROR: ' . get_class($e) . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            return $this->errorResponse(500, 'Internal server error', [], []);
        }
    }

    /**
     * Routes a JSON action request
     *
     * @param array $data Decoded JSON body
     * @return array Response array
     * @throws TurboPushException If the action is unknown
     *
     * @private
     */
    private function handleAction(array $data) {
        switch ($data['action']) {
            case 'finalize':
                return $this->finalizeUpload($data);
            case 'status':
                return $this->uploadStatus($data);
            case 'abort':
                return $this->abortUpload($data);
            default:
                throw new TurboPushException('Unknown action', 400);
        }
    }

    /**
     * Handles individual chunk upload
     *
     * Validates the request and its metadata, then stores the chunk in the
     * upload's temporary directory. Metadata from the first chunk is recorded
     * and later chunks (and the finalize request) must match it.
     *
     * @param array $post  Form fields
     * @param array $files Uploaded files
     * @return array Response array
     * @throws TurboPushException If validation fails
     *
     * @private
     */
    private function handleChunk(array $post, array $files) {
        // Validate required fields and file upload
        $upload = $this->validateChunkRequest($post, $files);

        // Extract and validate metadata from POST
        $uploadId = $this->validateUploadId($post['fileId']);
        $fileName = $this->validateFileName($post['fileName']);
        $fileSize = $this->parseInteger($post['fileSize'], 'fileSize');
        $totalChunks = $this->parseInteger($post['totalChunks'], 'totalChunks');
        $chunkIndex = $this->parseInteger($post['chunkIndex'], 'chunkIndex');

        $this->validateUploadShape($fileSize, $totalChunks);

        if ($chunkIndex >= $totalChunks) {
            throw new TurboPushException('Invalid chunkIndex', 400);
        }

        $this->log("Receiving chunk $chunkIndex/$totalChunks for: $fileName ($uploadId)");

        // Create temporary directory for this upload's chunks
        $fileTempDir = $this->uploadTempDir($uploadId);
        $this->ensureDirectory($this->tempDir, 0700);
        $this->assertTempDirIsPrivate();
        $this->ensureDirectory($fileTempDir, 0700);

        $lock = $this->acquireLock($fileTempDir);
        $partPath = null;

        try {
            if (is_file($fileTempDir . self::DONE_FILE)) {
                throw new TurboPushException('Upload already finalized', 409);
            }

            $meta = $this->readJsonFile($fileTempDir . self::META_FILE);
            if ($meta === null) {
                $meta = [
                    'fileName' => $fileName,
                    'fileSize' => $fileSize,
                    'totalChunks' => $totalChunks,
                    'receivedBytes' => 0,
                    'createdAt' => time(),
                ];
            } else {
                $this->assertMetadataMatches($meta, $fileName, $fileSize, $totalChunks);
            }

            // Write to a unique temporary name first, then rename into place, so a
            // duplicate or retried chunk can never leave a half-written file behind
            $chunkPath = $fileTempDir . $this->chunkFileName($chunkIndex);
            $partPath = $chunkPath . '.' . bin2hex(random_bytes(6)) . '.part';

            if (!$this->moveUploadedFile($upload['tmp_name'], $partPath)) {
                throw new \RuntimeException('Failed to move uploaded chunk to ' . $partPath);
            }

            $chunkSize = $this->fileSize($partPath);
            if ($chunkSize > $this->maxChunkSize) {
                throw new TurboPushException('Chunk size exceeds limit', 413);
            }

            // Keep a running total so a client cannot store more than it declared
            $previousSize = is_file($chunkPath) ? $this->fileSize($chunkPath) : 0;
            $receivedBytes = (int) $meta['receivedBytes'] - $previousSize + $chunkSize;
            if ($receivedBytes > $fileSize) {
                throw new TurboPushException('Upload exceeds the declared file size', 400);
            }

            if (!rename($partPath, $chunkPath)) {
                throw new \RuntimeException('Failed to rename chunk to ' . $chunkPath);
            }
            $partPath = null;

            $meta['receivedBytes'] = $receivedBytes;
            $this->writeJsonFile($fileTempDir . self::META_FILE, $meta);
        } finally {
            if ($partPath !== null && is_file($partPath)) {
                @unlink($partPath);
            }
            $this->releaseLock($lock);
        }

        $this->log("Chunk $chunkIndex saved ($uploadId)");

        // Return success response
        return $this->successResponse('Chunk uploaded', [
            'chunkIndex' => $chunkIndex,
            'totalChunks' => $totalChunks
        ]);
    }

    /**
     * Finalizes upload by merging all chunks into final file
     *
     * Verifies the request matches the recorded metadata and that every chunk
     * is present, assembles the chunks into a temporary file inside the upload
     * directory and renames it into place. The operation holds the upload's
     * lock, so parallel or repeated finalize requests cannot corrupt the file.
     * Repeating a finalize request after success returns the same result.
     *
     * @param array $data Finalization request data containing:
     *                    - fileName: Name of the final file
     *                    - fileId: Unique upload identifier
     *                    - fileSize: Expected final file size
     *                    - totalChunks: Total number of chunks
     *
     * @return array Response array
     * @throws TurboPushException If chunks are missing, merge fails, or size mismatch
     *
     * @private
     */
    private function finalizeUpload(array $data) {
        foreach (['fileName', 'fileId', 'fileSize', 'totalChunks'] as $field) {
            if (!isset($data[$field])) {
                throw new TurboPushException("Missing: $field", 400);
            }
        }

        // Extract and validate finalization data
        $uploadId = $this->validateUploadId($data['fileId']);
        $fileName = $this->validateFileName($data['fileName']);
        $fileSize = $this->parseInteger($data['fileSize'], 'fileSize');
        $totalChunks = $this->parseInteger($data['totalChunks'], 'totalChunks');

        $this->validateUploadShape($fileSize, $totalChunks);

        $this->log("Finalizing: $fileName ($uploadId)");

        // Locate temporary directory containing chunks
        $this->assertTempDirIsPrivate();
        $fileTempDir = $this->uploadTempDir($uploadId);
        if (!is_dir($fileTempDir)) {
            throw new TurboPushException('Upload not found', 404);
        }

        $lock = $this->acquireLock($fileTempDir);

        try {
            // A repeated finalize (for example a client retry) returns the original result
            $done = $this->readJsonFile($fileTempDir . self::DONE_FILE);
            if ($done !== null) {
                if ($done['sourceName'] !== $fileName || (int) $done['fileSize'] !== $fileSize) {
                    throw new TurboPushException('Upload metadata does not match', 409);
                }
                return $this->successResponse('Upload complete', $done['data']);
            }

            $meta = $this->readJsonFile($fileTempDir . self::META_FILE);
            if ($meta === null) {
                throw new TurboPushException('Upload not found', 404);
            }
            $this->assertMetadataMatches($meta, $fileName, $fileSize, $totalChunks);

            // Verify all chunks are present before merging
            $missing = [];
            $totalSize = 0;
            for ($i = 0; $i < $totalChunks; $i++) {
                $chunkPath = $fileTempDir . $this->chunkFileName($i);
                if (!is_file($chunkPath)) {
                    $missing[] = $i;
                    continue;
                }
                $totalSize += $this->fileSize($chunkPath);
            }

            if (!empty($missing)) {
                throw new TurboPushException('Missing chunks', 409, [
                    'missingChunks' => array_slice($missing, 0, 100)
                ]);
            }

            if ($totalSize !== $fileSize) {
                throw new TurboPushException('File size mismatch', 409);
            }

            // Assemble into a hidden temporary file next to the destination,
            // then rename it so the final file appears complete or not at all
            $this->ensureDirectory($this->uploadDir, 0755);
            $partPath = $this->uploadDir . '.turbopush-' . bin2hex(random_bytes(8)) . '.part';
            $this->assembleChunks($fileTempDir, $totalChunks, $partPath);

            $info = [
                'fileId' => $uploadId,
                'fileName' => $fileName,
                'fileSize' => $fileSize,
                'mimeType' => null,
            ];

            try {
                // Verify final file size matches expected size
                if ($this->fileSize($partPath) !== $fileSize) {
                    throw new \RuntimeException('Assembled file size mismatch for ' . $partPath);
                }

                $info['mimeType'] = $this->validateMimeType($partPath);
                $this->runFileValidator($partPath, $info);

                $finalPath = $this->moveToFinalPath($partPath, $fileName);
            } catch (\Throwable $e) {
                @unlink($partPath);
                throw $e;
            }

            $result = [
                'fileName' => basename($finalPath),
                'fileSize' => $fileSize
            ];

            if ($this->completeCallback !== null) {
                try {
                    $extra = call_user_func($this->completeCallback, $finalPath, [
                        'fileName' => $result['fileName'],
                        'originalName' => $fileName,
                    ] + $info);
                } catch (\Throwable $e) {
                    // Keep the chunks so the client can retry the finalize request
                    @unlink($finalPath);
                    throw $e;
                }
                if (is_array($extra)) {
                    $result += $extra;
                }
            }

            // Remember the result so repeated finalize requests are harmless,
            // then clean up the chunks
            $this->writeJsonFile($fileTempDir . self::DONE_FILE, [
                'sourceName' => $fileName,
                'fileSize' => $fileSize,
                'data' => $result,
            ]);
            for ($i = 0; $i < $totalChunks; $i++) {
                @unlink($fileTempDir . $this->chunkFileName($i));
            }
            @unlink($fileTempDir . self::META_FILE);
        } finally {
            $this->releaseLock($lock);
        }

        $this->log("Complete: $fileName -> {$result['fileName']} ($uploadId)");

        // Return success response with file information
        return $this->successResponse('Upload complete', $result);
    }

    /**
     * Reports which chunks of an upload the server already has
     *
     * Lets a client resume an interrupted upload by sending only the
     * missing chunks.
     *
     * @param array $data Request data containing fileId
     * @return array Response array
     * @throws TurboPushException If the upload is unknown
     *
     * @private
     */
    private function uploadStatus(array $data) {
        if (!isset($data['fileId'])) {
            throw new TurboPushException('Missing: fileId', 400);
        }
        $uploadId = $this->validateUploadId($data['fileId']);

        $this->assertTempDirIsPrivate();
        $fileTempDir = $this->uploadTempDir($uploadId);
        if (!is_dir($fileTempDir)) {
            throw new TurboPushException('Upload not found', 404);
        }

        $lock = $this->acquireLock($fileTempDir);

        try {
            $done = $this->readJsonFile($fileTempDir . self::DONE_FILE);
            if ($done !== null) {
                return $this->successResponse('Upload complete', ['complete' => true] + $done['data']);
            }

            $meta = $this->readJsonFile($fileTempDir . self::META_FILE);
            if ($meta === null) {
                throw new TurboPushException('Upload not found', 404);
            }

            $uploaded = [];
            foreach (scandir($fileTempDir) ?: [] as $entry) {
                if (preg_match('/^chunk_([0-9]{10})$/D', $entry, $match)) {
                    $uploaded[] = (int) $match[1];
                }
            }
            sort($uploaded);

            return $this->successResponse('Upload in progress', [
                'complete' => false,
                'fileName' => $meta['fileName'],
                'fileSize' => (int) $meta['fileSize'],
                'totalChunks' => (int) $meta['totalChunks'],
                'receivedBytes' => (int) $meta['receivedBytes'],
                'uploadedChunks' => $uploaded,
            ]);
        } finally {
            $this->releaseLock($lock);
        }
    }

    /**
     * Deletes the stored chunks of an upload
     *
     * Called by the client when an upload is cancelled. Unknown uploads are
     * not an error, so the request can safely be repeated.
     *
     * @param array $data Request data containing fileId
     * @return array Response array
     *
     * @private
     */
    private function abortUpload(array $data) {
        if (!isset($data['fileId'])) {
            throw new TurboPushException('Missing: fileId', 400);
        }
        $uploadId = $this->validateUploadId($data['fileId']);

        $this->assertTempDirIsPrivate();
        $fileTempDir = $this->uploadTempDir($uploadId);
        if (is_dir($fileTempDir)) {
            $this->removeUploadDir($fileTempDir, false);
        }

        $this->log("Aborted ($uploadId)");

        return $this->successResponse('Upload aborted', []);
    }

    /**
     * Removes abandoned uploads
     *
     * Deletes the temporary data of uploads with no activity for longer than
     * the upload TTL, and leftover assembly files in the upload directory.
     * Uploads that are being worked on (locked) are skipped. Only files
     * TurboPush created are deleted. Call it from cron, or rely on the
     * probabilistic cleanup (see setCleanupProbability()).
     *
     * @param int|null $maxAge Override the TTL in seconds
     * @return int Number of uploads removed
     *
     * @since 2.0.0
     *
     * @example
     * ```php
     * // cron: php -r "require 'vendor/autoload.php'; (new TurboPush\TurboPushEndpoint('/var/uploads'))->cleanup();"
     * $removed = $endpoint->cleanup();
     * ```
     */
    public function cleanup($maxAge = null) {
        $cutoff = time() - ($maxAge === null ? $this->uploadTtl : max(0, (int) $maxAge));
        $removed = 0;

        if (is_dir($this->tempDir)) {
            $this->assertTempDirIsPrivate();
            foreach (scandir($this->tempDir) ?: [] as $entry) {
                $dir = $this->tempDir . $entry;
                if (!preg_match(self::UPLOAD_ID_PATTERN, $entry) || is_link($dir) || !is_dir($dir)) {
                    continue;
                }
                clearstatcache(true, $dir);
                if (filemtime($dir) >= $cutoff) {
                    continue;
                }
                if ($this->removeUploadDir($dir . '/', true)) {
                    $removed++;
                }
            }
        }

        // Assembly files left behind by a crashed finalize
        foreach ((is_dir($this->uploadDir) ? scandir($this->uploadDir) : false) ?: [] as $entry) {
            $partPath = $this->uploadDir . $entry;
            if (!preg_match('/^\.turbopush-[0-9a-f]+\.part$/D', $entry) || !is_file($partPath)) {
                continue;
            }
            clearstatcache(true, $partPath);
            if (filemtime($partPath) < $cutoff) {
                @unlink($partPath);
            }
        }

        if ($removed > 0) {
            $this->log("Cleanup removed $removed abandoned upload(s)");
        }

        return $removed;
    }

    /**
     * Runs cleanup() with the configured probability
     *
     * @return void
     *
     * @private
     */
    private function maybeCleanup() {
        if ($this->cleanupProbability <= 0) {
            return;
        }
        if ($this->cleanupProbability < 1 && mt_rand() / mt_getrandmax() >= $this->cleanupProbability) {
            return;
        }
        try {
            $this->cleanup();
        } catch (\Throwable $e) {
            $this->log('ERROR: cleanup failed: ' . $e->getMessage());
        }
    }

    /**
     * Deletes an upload's temporary directory
     *
     * Only files TurboPush creates are deleted; the directory itself is only
     * removed once it is empty.
     *
     * @param string $fileTempDir   Upload directory with trailing slash
     * @param bool   $skipIfLocked  Skip the upload if another request holds its lock
     * @return bool True if the directory was removed
     *
     * @private
     */
    private function removeUploadDir($fileTempDir, $skipIfLocked) {
        $lock = @fopen($fileTempDir . self::LOCK_FILE, 'c');
        if ($lock === false) {
            return false;
        }
        if (!flock($lock, $skipIfLocked ? LOCK_EX | LOCK_NB : LOCK_EX)) {
            fclose($lock);
            return false;
        }

        foreach (scandir($fileTempDir) ?: [] as $entry) {
            if ($entry === self::META_FILE
                || $entry === self::DONE_FILE
                || preg_match('/^chunk_[0-9]{10}(\.[0-9a-f]+\.part)?$/D', $entry)
                || preg_match('/^(upload|complete)\.json\.[0-9a-f]+\.tmp$/D', $entry)) {
                @unlink($fileTempDir . $entry);
            }
        }

        // Unlink the lock file while holding it; waiting requests notice
        // and stop (see acquireLock())
        @unlink($fileTempDir . self::LOCK_FILE);
        flock($lock, LOCK_UN);
        fclose($lock);

        return @rmdir($fileTempDir);
    }

    /**
     * Validates chunk upload request
     *
     * Ensures the request contains a successfully uploaded file and all
     * required POST fields.
     *
     * @param array $post  Form fields
     * @param array $files Uploaded files
     * @return array The uploaded file entry from $files
     * @throws TurboPushException If validation fails
     *
     * @private
     */
    private function validateChunkRequest(array $post, array $files) {
        // Check for uploaded file
        if (!isset($files['file']) || !is_array($files['file']) || !isset($files['file']['tmp_name'])) {
            throw new TurboPushException('No file uploaded', 400);
        }

        $upload = $files['file'];
        if (is_array($upload['tmp_name'])) {
            throw new TurboPushException('Only one chunk per request is allowed', 400);
        }

        $error = isset($upload['error']) ? (int) $upload['error'] : UPLOAD_ERR_OK;
        switch ($error) {
            case UPLOAD_ERR_OK:
                break;
            case UPLOAD_ERR_INI_SIZE:
            case UPLOAD_ERR_FORM_SIZE:
                throw new TurboPushException('Chunk exceeds the server upload size limit', 413);
            case UPLOAD_ERR_PARTIAL:
                throw new TurboPushException('Chunk upload was incomplete', 400);
            case UPLOAD_ERR_NO_FILE:
                throw new TurboPushException('No file uploaded', 400);
            default:
                // UPLOAD_ERR_NO_TMP_DIR, UPLOAD_ERR_CANT_WRITE, UPLOAD_ERR_EXTENSION
                throw new \RuntimeException('PHP upload error code ' . $error);
        }

        if (isset($upload['size']) && (int) $upload['size'] > $this->maxChunkSize) {
            throw new TurboPushException('Chunk size exceeds limit', 413);
        }

        // Check for required POST fields
        $required = ['fileName', 'fileId', 'chunkIndex', 'totalChunks', 'fileSize'];
        foreach ($required as $field) {
            if (!isset($post[$field])) {
                throw new TurboPushException("Missing: $field", 400);
            }
        }

        return $upload;
    }

    /**
     * Validates an upload ID
     *
     * The ID becomes a directory name, so only a strict character set is
     * accepted. Anything else is rejected rather than rewritten.
     *
     * @param mixed $uploadId Upload ID from the request
     * @return string The validated upload ID
     * @throws TurboPushException If the ID is invalid
     *
     * @private
     */
    private function validateUploadId($uploadId) {
        if (!is_string($uploadId) || !preg_match(self::UPLOAD_ID_PATTERN, $uploadId)) {
            throw new TurboPushException('Invalid fileId', 400);
        }
        return $uploadId;
    }

    /**
     * Sanitizes a file name and checks its extension
     *
     * @param mixed $fileName File name from the request
     * @return string The sanitized file name
     * @throws TurboPushException If the name is missing or its extension is not allowed
     *
     * @private
     */
    private function validateFileName($fileName) {
        if (!is_string($fileName) || trim($fileName) === '') {
            throw new TurboPushException('Missing: fileName', 400);
        }

        $fileName = $this->sanitizeFileName($fileName);
        $this->validateFileExtension($fileName);

        return $fileName;
    }

    /**
     * Parses a non-negative integer request field
     *
     * Accepts integers and strings of digits only, so values such as "-1",
     * "1e3", "0x10" or "3.5" are rejected instead of being silently cast.
     *
     * @param mixed  $value Raw value
     * @param string $field Field name for the error message
     * @return int Parsed value
     * @throws TurboPushException If the value is not a valid non-negative integer
     *
     * @private
     */
    private function parseInteger($value, $field) {
        if (is_int($value)) {
            if ($value < 0) {
                throw new TurboPushException("Invalid $field", 400);
            }
            return $value;
        }

        if (!is_string($value) || !preg_match('/^[0-9]{1,18}$/D', $value)) {
            throw new TurboPushException("Invalid $field", 400);
        }

        return (int) $value;
    }

    /**
     * Validates file size and chunk count against the configured limits
     *
     * @param int $fileSize    Declared file size in bytes
     * @param int $totalChunks Declared number of chunks
     * @return void
     * @throws TurboPushException If a limit is exceeded or the values are inconsistent
     *
     * @private
     */
    private function validateUploadShape($fileSize, $totalChunks) {
        // Validate file size doesn't exceed limit
        if ($fileSize > $this->maxFileSize) {
            throw new TurboPushException('File size exceeds limit', 413);
        }

        if ($totalChunks < 1) {
            throw new TurboPushException('Invalid totalChunks', 400);
        }

        if ($totalChunks > $this->maxChunks) {
            throw new TurboPushException('Too many chunks', 413);
        }

        // Every chunk carries at least one byte, except the single chunk of an empty file
        if ($totalChunks > max(1, $fileSize)) {
            throw new TurboPushException('totalChunks does not match fileSize', 400);
        }

        // The file must fit in totalChunks chunks of at most maxChunkSize bytes
        if ($fileSize > $totalChunks * $this->maxChunkSize) {
            throw new TurboPushException('Chunk size exceeds limit', 413);
        }
    }

    /**
     * Checks request metadata against the metadata recorded for the upload
     *
     * @param array  $meta        Recorded metadata
     * @param string $fileName    Sanitized file name from the request
     * @param int    $fileSize    File size from the request
     * @param int    $totalChunks Chunk count from the request
     * @return void
     * @throws TurboPushException If anything differs
     *
     * @private
     */
    private function assertMetadataMatches(array $meta, $fileName, $fileSize, $totalChunks) {
        if ($meta['fileName'] !== $fileName
            || (int) $meta['fileSize'] !== $fileSize
            || (int) $meta['totalChunks'] !== $totalChunks) {
            throw new TurboPushException('Upload metadata does not match', 409);
        }
    }

    /**
     * Validates file extension against the blocklist and the allowlist
     *
     * Extensions are compared case-insensitively.
     *
     * @param string $fileName Name of file to validate
     * @return void
     * @throws TurboPushException If file extension is not allowed
     *
     * @private
     */
    private function validateFileExtension($fileName) {
        // Extract and check extension
        $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
        $label = $ext === '' ? 'File type not allowed' : "File type not allowed: .$ext";

        if ($ext !== '' && in_array($ext, $this->blockedExtensions, true)) {
            throw new TurboPushException($label, 415);
        }

        // Skip allowlist validation if no restrictions set
        if (!empty($this->allowedExtensions) && !in_array($ext, $this->allowedExtensions, true)) {
            throw new TurboPushException($label, 415);
        }
    }

    /**
     * Sanitizes filename for safe filesystem storage
     *
     * Keeps only the last path segment, replaces anything other than letters,
     * digits, dot, dash and underscore, strips leading and trailing dots (no
     * hidden files such as .htaccess or .user.ini), truncates long names while
     * preserving the extension, neutralises blocked inner extensions
     * (shell.php.jpg becomes shell_php.jpg) and avoids Windows device names.
     *
     * @param string $fileName Original filename
     * @return string Sanitized filename safe for storage
     *
     * @private
     */
    private function sanitizeFileName($fileName) {
        // Remove directory components (prevent traversal attacks), on any platform
        $fileName = str_replace(["\0", '\\'], ['', '/'], (string) $fileName);
        $slash = strrpos($fileName, '/');
        if ($slash !== false) {
            $fileName = substr($fileName, $slash + 1);
        }

        // Replace special characters with underscores (keep alphanumeric, dot, dash)
        $fileName = preg_replace('/[^a-zA-Z0-9._-]/', '_', $fileName);

        // No hidden files, no "..", no trailing dots (Windows drops them)
        $fileName = trim($fileName, '.');

        // Truncate long filenames first, leaving room for a collision suffix,
        // so truncation cannot undo anything below
        if (strlen($fileName) > 200) {
            $ext = pathinfo($fileName, PATHINFO_EXTENSION);
            if ($ext !== '' && strlen($ext) <= 20) {
                $fileName = substr($fileName, 0, 200 - strlen($ext) - 1) . '.' . $ext;
            } else {
                $fileName = substr($fileName, 0, 200);
            }
            $fileName = trim($fileName, '.');
        }

        // Neutralise blocked extensions in the middle of the name
        $parts = explode('.', $fileName);
        if (count($parts) > 2) {
            $name = array_shift($parts);
            $ext = array_pop($parts);
            foreach ($parts as $part) {
                $name .= (in_array(strtolower($part), $this->blockedExtensions, true) ? '_' : '.') . $part;
            }
            $fileName = $name . '.' . $ext;
        }

        // Avoid Windows device names such as CON or NUL
        if (preg_match('/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i', $fileName)) {
            $fileName = '_' . $fileName;
        }

        if ($fileName === '') {
            $fileName = 'file';
        }

        return $fileName;
    }

    /**
     * Normalizes a list of extensions: lowercase, without leading dots
     *
     * @param array $extensions Extensions to normalize
     * @return array Normalized extensions
     *
     * @private
     */
    private function normalizeExtensions($extensions) {
        $normalized = [];
        foreach ((array) $extensions as $extension) {
            $extension = strtolower(ltrim(trim((string) $extension), '.'));
            if ($extension !== '') {
                $normalized[] = $extension;
            }
        }
        return array_values(array_unique($normalized));
    }

    /**
     * Checks the detected MIME type of a file against the allowlist
     *
     * @param string $path File to inspect
     * @return string|null Detected MIME type, or null if no allowlist is set
     * @throws TurboPushException If the type is not allowed
     *
     * @private
     */
    private function validateMimeType($path) {
        if (empty($this->allowedMimeTypes)) {
            return null;
        }

        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mimeType = strtolower((string) $finfo->file($path));

        foreach ($this->allowedMimeTypes as $allowed) {
            if ($allowed === $mimeType) {
                return $mimeType;
            }
            if (substr($allowed, -2) === '/*' && strpos($mimeType, substr($allowed, 0, -1)) === 0) {
                return $mimeType;
            }
        }

        throw new TurboPushException('File type not allowed', 415);
    }

    /**
     * Runs the custom file validator, if any
     *
     * @param string $path File to validate
     * @param array  $info File information
     * @return void
     * @throws TurboPushException If the validator rejects the file
     *
     * @private
     */
    private function runFileValidator($path, array $info) {
        if ($this->fileValidator === null) {
            return;
        }
        if (call_user_func($this->fileValidator, $path, $info) === false) {
            throw new TurboPushException('File rejected', 415);
        }
    }

    /**
     * Assembles chunks in order into a new file
     *
     * @param string $fileTempDir Directory holding the chunks
     * @param int    $totalChunks Number of chunks
     * @param string $targetPath  File to create (must not exist)
     * @return void
     * @throws \RuntimeException If any file operation fails
     *
     * @private
     */
    private function assembleChunks($fileTempDir, $totalChunks, $targetPath) {
        // Open final file for writing; 'x' fails if the file already exists
        $out = @fopen($targetPath, 'xb');
        if ($out === false) {
            throw new \RuntimeException('Failed to create ' . $targetPath);
        }

        try {
            // Merge all chunks in order
            for ($i = 0; $i < $totalChunks; $i++) {
                $chunkPath = $fileTempDir . $this->chunkFileName($i);
                $in = @fopen($chunkPath, 'rb');
                if ($in === false) {
                    throw new \RuntimeException('Failed to open ' . $chunkPath);
                }
                $copied = stream_copy_to_stream($in, $out);
                fclose($in);
                if ($copied === false) {
                    throw new \RuntimeException('Failed to copy ' . $chunkPath);
                }
            }

            if (!fflush($out)) {
                throw new \RuntimeException('Failed to flush ' . $targetPath);
            }
        } catch (\Throwable $e) {
            fclose($out);
            @unlink($targetPath);
            throw $e;
        }

        fclose($out);
    }

    /**
     * Moves an assembled file to its final name without overwriting anything
     *
     * Tries the sanitized name first, then name_<timestamp>.ext, then
     * name_<timestamp>_<n>.ext. Each candidate is reserved with an exclusive
     * create, so two uploads of the same name can never overwrite each other.
     *
     * @param string $partPath Assembled temporary file
     * @param string $fileName Sanitized file name
     * @return string Final path
     * @throws \RuntimeException If no name could be reserved
     *
     * @private
     */
    private function moveToFinalPath($partPath, $fileName) {
        $info = pathinfo($fileName);
        $base = $info['filename'];
        $ext = isset($info['extension']) && $info['extension'] !== '' ? '.' . $info['extension'] : '';
        $timestamp = time();

        for ($attempt = 0; $attempt < 100; $attempt++) {
            if ($attempt === 0) {
                $candidate = $fileName;
            } elseif ($attempt === 1) {
                $candidate = $base . '_' . $timestamp . $ext;
            } else {
                $candidate = $base . '_' . $timestamp . '_' . ($attempt - 1) . $ext;
            }

            $finalPath = $this->uploadDir . $candidate;
            $handle = @fopen($finalPath, 'xb');
            if ($handle === false) {
                if (file_exists($finalPath)) {
                    continue; // Name taken, try the next one
                }
                throw new \RuntimeException('Failed to create ' . $finalPath);
            }
            fclose($handle);

            if (!rename($partPath, $finalPath)) {
                @unlink($finalPath);
                throw new \RuntimeException('Failed to move ' . $partPath . ' to ' . $finalPath);
            }

            return $finalPath;
        }

        throw new \RuntimeException('Could not find a free file name for ' . $fileName);
    }

    /**
     * Moves an uploaded file into place
     *
     * Wraps move_uploaded_file(), which refuses anything that was not
     * uploaded in the current request. Kept separate so tests can override it.
     *
     * @param string $from Temporary upload path
     * @param string $to   Destination path
     * @return bool True on success
     */
    protected function moveUploadedFile($from, $to) {
        return @move_uploaded_file($from, $to);
    }

    /**
     * Gets the temporary directory for an upload
     *
     * @param string $uploadId Validated upload ID
     * @return string Directory path with trailing slash
     *
     * @private
     */
    private function uploadTempDir($uploadId) {
        return $this->tempDir . $uploadId . '/';
    }

    /**
     * Gets the file name of a chunk, zero-padded for proper sorting
     *
     * @param int $index Chunk index
     * @return string For example chunk_0000000003 for index 3
     *
     * @private
     */
    private function chunkFileName($index) {
        return 'chunk_' . str_pad((string) $index, 10, '0', STR_PAD_LEFT);
    }

    /**
     * Gets the default temporary directory
     *
     * A folder under sys_get_temp_dir(), outside the web root. The name
     * includes a hash of the upload directory so separate sites on the same
     * server do not share (or fight over permissions on) the same folder.
     *
     * @return string Directory path
     *
     * @private
     */
    private function defaultTempDir() {
        $uploadDir = $this->uploadDir;
        if (!preg_match('#^([A-Za-z]:)?[/\\\\]#', $uploadDir)) {
            $uploadDir = getcwd() . '/' . $uploadDir;
        }
        return rtrim(sys_get_temp_dir(), '/\\') . '/turbopush-' . substr(sha1($uploadDir), 0, 12);
    }

    /**
     * Refuses to use the default temp directory if other users can access it
     *
     * The default lives in the shared system temp directory under a
     * predictable name, so another local user could create it first and
     * plant files or symlinks. A directory TurboPush created is mode 0700 and
     * not a symlink; anything else is rejected. Skipped on Windows and for a
     * temp directory you configured yourself.
     *
     * @return void
     * @throws \RuntimeException If the directory is not private
     *
     * @private
     */
    private function assertTempDirIsPrivate() {
        if (!$this->defaultTempDir || DIRECTORY_SEPARATOR === '\\') {
            return;
        }
        $dir = rtrim($this->tempDir, '/');
        clearstatcache(true, $dir);
        if (!file_exists($dir)) {
            return;
        }
        if (is_link($dir) || !is_dir($dir) || (fileperms($dir) & 0077) !== 0) {
            throw new \RuntimeException('Refusing to use temp directory ' . $dir . ': it is a symlink or other users can access it');
        }
    }

    /**
     * Opens and exclusively locks an upload's lock file
     *
     * @param string $fileTempDir Upload directory
     * @return resource Lock handle
     * @throws \RuntimeException If the lock cannot be acquired
     *
     * @private
     */
    private function acquireLock($fileTempDir) {
        $lockPath = $fileTempDir . self::LOCK_FILE;

        for ($attempt = 0; $attempt < 5; $attempt++) {
            $handle = @fopen($lockPath, 'c');
            if ($handle === false) {
                if (!is_dir($fileTempDir)) {
                    // Removed by abort or cleanup since the caller checked
                    throw new TurboPushException('Upload was cancelled or has expired', 409);
                }
                throw new \RuntimeException('Failed to open lock file in ' . $fileTempDir);
            }
            if (!flock($handle, LOCK_EX)) {
                fclose($handle);
                throw new \RuntimeException('Failed to lock ' . $fileTempDir);
            }

            // removeUploadDir() unlinks the lock file while holding it. If that
            // happened while we waited, our handle points at the old file, and
            // the path may already hold a new one: only the file currently at
            // the path counts, so check it is the one we locked
            $locked = fstat($handle);
            clearstatcache(true, $lockPath);
            $current = @stat($lockPath);
            if ($current !== false && $locked !== false
                && $current['ino'] === $locked['ino'] && $current['dev'] === $locked['dev']) {
                return $handle;
            }

            $this->releaseLock($handle);
            if (!is_dir($fileTempDir)) {
                throw new TurboPushException('Upload was cancelled or has expired', 409);
            }
        }

        throw new \RuntimeException('Could not lock ' . $fileTempDir);
    }

    /**
     * Releases a lock acquired with acquireLock()
     *
     * @param resource $handle Lock handle
     * @return void
     *
     * @private
     */
    private function releaseLock($handle) {
        flock($handle, LOCK_UN);
        fclose($handle);
    }

    /**
     * Reads a JSON file
     *
     * @param string $path File path
     * @return array|null Decoded data, or null if the file does not exist
     * @throws \RuntimeException If the file exists but cannot be read
     *
     * @private
     */
    private function readJsonFile($path) {
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($path), true);
        if (!is_array($data)) {
            throw new \RuntimeException('Corrupt metadata file ' . $path);
        }
        return $data;
    }

    /**
     * Writes a JSON file atomically
     *
     * @param string $path File path
     * @param array  $data Data to write
     * @return void
     * @throws \RuntimeException If the file cannot be written
     *
     * @private
     */
    private function writeJsonFile($path, array $data) {
        $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (file_put_contents($tmp, json_encode($data)) === false || !rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException('Failed to write ' . $path);
        }
    }

    /**
     * Gets the size of a file, bypassing PHP's stat cache
     *
     * @param string $path File path
     * @return int Size in bytes
     *
     * @private
     */
    private function fileSize($path) {
        clearstatcache(true, $path);
        return (int) filesize($path);
    }

    /**
     * Ensures a directory exists, creating it if necessary
     *
     * @param string $dir  Directory path to ensure exists
     * @param int    $mode Permissions for a new directory
     * @return void
     * @throws \RuntimeException If directory cannot be created
     *
     * @private
     */
    private function ensureDirectory($dir, $mode) {
        if (!is_dir($dir) && !@mkdir($dir, $mode, true) && !is_dir($dir)) {
            throw new \RuntimeException('Failed to create directory ' . $dir);
        }
    }

    /**
     * Converts a php.ini size such as "8M" to bytes
     *
     * @param string $value php.ini value
     * @return int Bytes (0 = unlimited or unknown)
     *
     * @private
     */
    private function iniBytes($value) {
        $value = trim($value);
        if (!preg_match('/^([0-9]+)\s*([kmg]?)$/iD', $value, $match)) {
            return 0;
        }
        $bytes = (int) $match[1];
        switch (strtolower($match[2])) {
            case 'g':
                $bytes *= 1024;
                // no break
            case 'm':
                $bytes *= 1024;
                // no break
            case 'k':
                $bytes *= 1024;
        }
        return $bytes;
    }

    /**
     * Checks whether the request is multipart/form-data
     *
     * @param array $server Server parameters
     * @return bool
     *
     * @private
     */
    private function isMultipart(array $server) {
        return isset($server['CONTENT_TYPE']) && stripos($server['CONTENT_TYPE'], 'multipart/form-data') === 0;
    }

    /**
     * Reads the raw request body for JSON requests
     *
     * Multipart bodies are parsed by PHP into $_POST and $_FILES, so they are
     * not read here. At most MAX_JSON_BODY + 1 bytes are read.
     *
     * @param array $server Server parameters
     * @return string Request body
     *
     * @private
     */
    private function readRequestBody(array $server) {
        if ($this->isMultipart($server)) {
            return '';
        }
        $body = file_get_contents('php://input', false, null, 0, self::MAX_JSON_BODY + 1);
        return $body === false ? '' : $body;
    }

    /**
     * Builds the CORS headers for a response
     *
     * Same-origin only (the default): none. ['*']: Access-Control-Allow-Origin: *
     * without credentials. A list: the matching entry with credentials, and
     * Vary: Origin on every response because the headers depend on the Origin.
     * The header value always comes from the list, never from the request.
     * See setAllowedOrigins().
     *
     * @param array $server Server parameters
     * @return array Header name => value
     *
     * @private
     */
    private function corsHeaders(array $server) {
        if (empty($this->allowedOrigins)) {
            return [];
        }

        $allow = [
            'Access-Control-Allow-Methods' => 'POST, OPTIONS',
            'Access-Control-Allow-Headers' => 'Content-Type, Authorization, X-Requested-With',
            'Access-Control-Max-Age' => '600',
        ];

        if (in_array('*', $this->allowedOrigins, true)) {
            return ['Access-Control-Allow-Origin' => '*'] + $allow;
        }

        $origin = $this->requestOrigin($server);
        $index = $origin !== '' ? array_search($origin, $this->allowedOrigins, true) : false;
        if ($index !== false) {
            return [
                'Access-Control-Allow-Origin' => $this->allowedOrigins[$index],
                'Access-Control-Allow-Credentials' => 'true',
                'Vary' => 'Origin',
            ] + $allow;
        }

        return ['Vary' => 'Origin'];
    }

    /**
     * Checks the Origin header against the allowed origins
     *
     * Requests without an Origin header (non-browser clients) and
     * same-origin requests are always allowed. Other origins must be on
     * the list, unless it contains '*'.
     *
     * Same-origin means the Origin's host and port match the Host header.
     * The scheme is only compared when PHP itself received the request over
     * HTTPS, because behind a TLS-terminating proxy PHP sees plain HTTP.
     *
     * @param array $server Server parameters
     * @return bool
     *
     * @private
     */
    private function isOriginAllowed(array $server) {
        if (in_array('*', $this->allowedOrigins, true)) {
            return true;
        }

        $origin = $this->requestOrigin($server);
        if ($origin === '' || in_array($origin, $this->allowedOrigins, true)) {
            return true;
        }

        if (!$this->isValidOrigin($origin) || !isset($server['HTTP_HOST'])) {
            return false;
        }

        $https = isset($server['HTTPS']) && $server['HTTPS'] !== '' && strtolower((string) $server['HTTPS']) !== 'off';
        if ($https && parse_url($origin, PHP_URL_SCHEME) !== 'https') {
            return false;
        }

        $host = parse_url($origin, PHP_URL_HOST);
        $port = parse_url($origin, PHP_URL_PORT);
        $originHost = $port ? $host . ':' . $port : $host;

        return is_string($originHost) && strcasecmp($originHost, (string) $server['HTTP_HOST']) === 0;
    }

    /**
     * Returns the request's Origin header, normalized for comparison
     *
     * @param array $server Server parameters
     * @return string Lowercased origin without a trailing slash, or '' if none
     *
     * @private
     */
    private function requestOrigin(array $server) {
        return isset($server['HTTP_ORIGIN']) ? strtolower(rtrim(trim((string) $server['HTTP_ORIGIN']), '/')) : '';
    }

    /**
     * Checks that a normalized value is a serialized origin: scheme://host[:port]
     *
     * No path, query, credentials or wildcards: browsers send the origin in
     * exactly this form (with IDN hosts in punycode), and entries are
     * compared as plain strings.
     *
     * @param string $origin Lowercased origin without a trailing slash
     * @return bool
     *
     * @private
     */
    private function isValidOrigin($origin) {
        return (bool) preg_match(
            '#^[a-z][a-z0-9+.-]*://(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$#D',
            $origin
        );
    }

    /**
     * Logs a message to the log file with timestamp
     *
     * Only logs if logging is enabled via enableLogging().
     *
     * @param string $message Message to log
     * @return void
     *
     * @private
     */
    private function log($message) {
        if ($this->logFile) {
            $timestamp = date('Y-m-d H:i:s');
            @file_put_contents($this->logFile, "[$timestamp] $message\n", FILE_APPEND | LOCK_EX);
        }
    }

    /**
     * Builds a success response
     *
     * @param string $message Human-readable message
     * @param array  $data    Additional data to include in response
     * @return array Response array
     *
     * @private
     */
    private function successResponse($message, array $data = []) {
        return [
            'status' => 200,
            'headers' => [],
            'body' => ['success' => true, 'message' => $message, 'data' => $data],
        ];
    }

    /**
     * Builds an error response
     *
     * @param int    $status  HTTP status code
     * @param string $message Client-safe message
     * @param array  $data    Additional data to include in response
     * @param array  $headers Response headers
     * @return array Response array
     *
     * @private
     */
    private function errorResponse($status, $message, array $data, array $headers) {
        return [
            'status' => $status,
            'headers' => $headers,
            'body' => ['success' => false, 'message' => $message, 'data' => $data],
        ];
    }

    /**
     * Sends a response array
     *
     * Sets the HTTP status code and headers and outputs the JSON body.
     *
     * @param array $response Response array from processRequest()
     * @return void
     *
     * @private
     */
    private function sendResponse(array $response) {
        // Set HTTP status code
        http_response_code($response['status']);

        if (!headers_sent()) {
            foreach ($response['headers'] as $name => $value) {
                header($name . ': ' . $value);
            }
        }

        // Output JSON response
        if ($response['body'] !== null) {
            echo json_encode($response['body']);
        }
    }
}
