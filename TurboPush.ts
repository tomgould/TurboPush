/**
 * TurboPush - Chunked File Upload Library
 *
 * Splits files into chunks and uploads them in parallel, with retries and
 * exponential backoff, pause/resume/cancel, progress events and optional
 * resuming across page reloads. Designed for uploading large files
 * efficiently and reliably.
 *
 * Speaks two protocols: TurboPush's own (the default, for the bundled PHP
 * endpoint) and tus 1.0.0 (https://tus.io), for any tus server such as
 * tusd, tus-node-server or tus-php.
 *
 * @module TurboPush
 * @version 2.0.0
 * @license MIT
 * @author TomGould
 *
 * @example
 * ```typescript
 * import { TurboPush } from 'turbopush';
 *
 * const uploader = new TurboPush({
 *     endpoint: '/api/upload',
 *     chunkSize: 1024 * 1024, // 1MB
 *     maxConcurrentUploads: 5
 * });
 *
 * uploader
 *     .addFiles(fileInput.files)
 *     .onProgress((progress) => {
 *         console.log(`Progress: ${progress[0].percentage}%`);
 *     })
 *     .push();
 * ```
 */

/**
 * Configuration options for TurboPush instance
 *
 * @interface TurboPushConfig
 */
interface TurboPushConfig {
    /**
     * Upload endpoint URL (required)
     * The server endpoint that will receive chunked uploads
     */
    endpoint: string;

    /**
     * Size of each chunk in bytes (default: 1MB)
     * Larger chunks = fewer requests but less granular progress
     * Smaller chunks = more requests but better progress tracking
     * Must not exceed the server's chunk size limit
     * @default 1048576 (1MB)
     */
    chunkSize?: number;

    /**
     * Maximum number of chunk requests in flight at once, across all files
     * (default: 3, range: 1-10)
     * Higher values upload faster but use more bandwidth/connections
     * @default 3
     */
    maxConcurrentUploads?: number;

    /**
     * Maximum retry attempts for a failed chunk or finalize request (default: 3)
     * Set to 0 to disable retries
     * @default 3
     */
    maxRetries?: number;

    /**
     * Base delay in milliseconds before the first retry (default: 1000ms, minimum 100ms)
     * The delay doubles with each attempt, with random jitter, up to maxRetryDelay
     * @default 1000
     */
    retryDelay?: number;

    /**
     * Upper limit for the retry delay in milliseconds (default: 30000ms)
     * @default 30000
     */
    maxRetryDelay?: number;

    /**
     * Request timeout in milliseconds (default: 30000ms / 30s, minimum 5s)
     * Requests exceeding this duration will be aborted and retried
     * @default 30000
     */
    timeout?: number;

    /**
     * Custom HTTP headers to include with each request
     * Useful for authentication tokens, CSRF tokens, API keys, etc.
     * @default {}
     */
    headers?: Record<string, string>;

    /**
     * Include cookies/credentials in cross-origin requests (default: false)
     * @default false
     */
    withCredentials?: boolean;

    /**
     * Resume interrupted uploads after a page reload (default: false)
     * Remembers each file's upload ID in localStorage, keyed by endpoint,
     * name, size and last-modified time, and asks the server which chunks
     * it already has before uploading
     * @default false
     */
    resumable?: boolean;

    /**
     * Upload protocol (default: 'turbopush')
     * - 'turbopush': TurboPush's own protocol, spoken by the bundled PHP endpoint
     * - 'tus': the tus 1.0.0 open protocol; `endpoint` is the tus creation URL,
     *   such as https://example.com/files/
     * @default 'turbopush'
     * @since 2.1.0
     */
    protocol?: TurboPushProtocol;

    /**
     * Options for the tus protocol, ignored by the TurboPush protocol
     * @since 2.1.0
     */
    tus?: TusOptions;
}

/**
 * Upload protocol spoken by the client
 * @since 2.1.0
 */
type TurboPushProtocol = 'turbopush' | 'tus';

/**
 * Options for the tus protocol
 *
 * @interface TusOptions
 * @since 2.1.0
 */
interface TusOptions {
    /**
     * Extra Upload-Metadata entries for each upload, or a function that
     * returns them for a file. `filename` and `filetype` are always sent,
     * taken from the File, unless set here. Keys must be non-empty ASCII
     * without spaces or commas. The function is called once per file;
     * exceptions it throws are reported asynchronously (like callback
     * exceptions) and the default metadata is used.
     */
    metadata?: Record<string, string> | ((file: File) => Record<string, string>);

    /**
     * Upload the chunks of a file in parallel when the server supports the
     * concatenation extension (default: true). The file is split into up to
     * maxConcurrentUploads partial uploads that are joined at the end. Set to
     * false for a server whose concatenation support does not follow the spec.
     * Without concatenation, a file's chunks are always sent one after another
     * (several files still upload at once).
     * @default true
     */
    parallel?: boolean;

    /**
     * Send an Upload-Checksum header with every chunk when the server supports
     * the checksum extension with sha1, sha256, sha384 or sha512 and Web
     * Crypto is available (default: true)
     * @default true
     */
    checksum?: boolean;
}

/**
 * tus options with defaults applied
 * @private
 */
interface ResolvedTusOptions {
    metadata: TusOptions['metadata'];
    parallel: boolean;
    checksum: boolean;
}

/**
 * Configuration with defaults applied
 * @private
 */
type ResolvedConfig = Required<Omit<TurboPushConfig, 'tus'>> & { tus: ResolvedTusOptions };

/**
 * Status of a file upload
 */
type UploadStatus = 'pending' | 'uploading' | 'completed' | 'failed' | 'paused';

/**
 * Data returned by the server when a file has been stored
 *
 * The PHP endpoint returns the stored file name (which may differ from the
 * original after sanitisation or to avoid overwriting an existing file),
 * the size, and anything added by its onComplete callback.
 *
 * @interface UploadResult
 */
interface UploadResult {
    /** Name the file was stored under on the server */
    fileName?: string;

    /** Stored file size in bytes */
    fileSize?: number;

    /**
     * tus only: URL of the finished upload on the tus server
     * @since 2.1.0
     */
    uploadUrl?: string;

    /** Any extra fields returned by the server */
    [key: string]: unknown;
}

/**
 * Real-time progress information for a single file upload
 *
 * @interface UploadProgress
 */
interface UploadProgress {
    /** The File object being uploaded */
    file: File;

    /** Name of the file including extension */
    fileName: string;

    /** Unique identifier for this file upload session */
    fileId: string;

    /** Total file size in bytes */
    totalSize: number;

    /** Number of bytes uploaded so far */
    uploadedSize: number;

    /** Upload completion percentage (0-100) */
    percentage: number;

    /** Current upload speed in bytes per second */
    speed: number;

    /** Estimated remaining time in seconds (0 if speed is 0) */
    remainingTime: number;

    /** Current status of the file upload */
    status: UploadStatus;

    /** Error message if status is 'failed' */
    error?: string;

    /** Server response data once status is 'completed' */
    result?: UploadResult;
}

/**
 * Upload session statistics
 *
 * @interface UploadStats
 */
interface UploadStats {
    /** Total number of files queued for upload */
    totalFiles: number;

    /** Number of files successfully uploaded */
    completedFiles: number;

    /** Number of files that failed to upload */
    failedFiles: number;

    /** Total size of all files in bytes */
    totalBytes: number;

    /** Total bytes uploaded across all files */
    uploadedBytes: number;

    /** Timestamp when upload session started */
    startTime: number;

    /** Timestamp when upload session ended (undefined if in progress) */
    endTime?: number;

    /** Total duration of upload session in seconds */
    duration?: number;

    /** Average upload speed in bytes per second */
    averageSpeed?: number;

    /** True if the session ended because cancel() was called */
    cancelled?: boolean;
}

/**
 * Information about a retry, passed to onRetry callbacks
 *
 * @interface RetryInfo
 */
interface RetryInfo {
    /** Name of the file */
    fileName: string;

    /** Unique identifier of the file upload */
    fileId: string;

    /** Index of the chunk being retried, or null for the finalize request */
    chunkIndex: number | null;

    /** Retry attempt number, starting at 1 */
    attempt: number;

    /** Delay before the retry in milliseconds */
    delay: number;

    /** The error that caused the retry */
    error: TurboPushError;
}

/**
 * Kind of failure reported by a TurboPushError
 *
 * - network: the request could not be sent or the connection dropped
 * - timeout: the request took longer than the configured timeout
 * - http: the server answered with an HTTP error status
 * - server: the server answered 200 but reported a failure
 * - invalid_response: the server's answer was not the expected JSON
 * - cancelled: the upload was cancelled
 */
type TurboPushErrorCode = 'network' | 'timeout' | 'http' | 'server' | 'invalid_response' | 'cancelled';

/**
 * Options for creating a TurboPushError
 *
 * @interface TurboPushErrorOptions
 */
interface TurboPushErrorOptions {
    code: TurboPushErrorCode;
    status?: number;
    retryable?: boolean;
    chunkIndex?: number;
    data?: unknown;
    cause?: unknown;
}

/**
 * Error passed to onError callbacks
 *
 * Carries the server's error message when there is one, plus details for
 * deciding what to do next.
 *
 * @class TurboPushError
 * @since 2.0.0
 *
 * @example
 * ```typescript
 * uploader.onError((error) => {
 *     if (error instanceof TurboPushError && error.status === 415) {
 *         alert('That file type is not allowed');
 *     }
 * });
 * ```
 */
export class TurboPushError extends Error {
    /** Kind of failure */
    public readonly code: TurboPushErrorCode;

    /** HTTP status code, if the server answered */
    public readonly status?: number;

    /** Whether TurboPush considers the failure temporary */
    public readonly retryable: boolean;

    /** Index of the chunk that failed, if the failure was a chunk upload */
    public readonly chunkIndex?: number;

    /** The `data` field of the server's error response, if any */
    public readonly data?: unknown;

    /** The underlying error, if any */
    public readonly cause?: unknown;

    constructor(message: string, options: TurboPushErrorOptions) {
        super(message);
        this.name = 'TurboPushError';
        this.code = options.code;
        this.status = options.status;
        this.retryable = options.retryable ?? false;
        this.chunkIndex = options.chunkIndex;
        this.data = options.data;
        this.cause = options.cause;
    }
}

/**
 * Internal chunk metadata and state
 *
 * @interface ChunkInfo
 * @private
 */
interface ChunkInfo {
    /** Zero-based index of this chunk */
    index: number;

    /** Starting byte position of the data still to send */
    start: number;

    /** Ending byte position in the file (exclusive) */
    end: number;

    /**
     * Original starting position. Differs from start once a tus server has
     * stored part of the chunk
     */
    origin: number;

    /** Index of the tus upload (lane) the chunk belongs to; always 0 for TurboPush */
    lane: number;

    /** The actual chunk data as a Blob */
    blob: Blob;

    /** Number of retries made for this chunk */
    attempts: number;

    /** Upload state: waiting to be sent, in flight, waiting to retry, or done */
    state: 'pending' | 'uploading' | 'waiting' | 'done';

    /** Incremented for every request, so a late answer to an older request is ignored */
    token: number;
}

/**
 * Internal state for one queued file
 *
 * @interface FileEntry
 * @private
 */
interface FileEntry {
    file: File;
    progress: UploadProgress;
    chunks: ChunkInfo[] | null;
    /** Chunk size used to create the chunks */
    chunkSize: number;
    /** True once any chunk has been sent, so the server may hold data */
    started: boolean;
    /** True while the finalize request is running */
    finalizing: boolean;
    /** True if the upload ID was restored from storage (resumable mode) */
    restored: boolean;
    /** tus protocol state, null for the TurboPush protocol or before planning */
    tus: TusState | null;
    /** Timer handles of chunks waiting to be retried */
    retryTimers: Set<ReturnType<typeof setTimeout>>;
    /** Speed calculation state */
    lastSpeedTime: number;
    lastSpeedBytes: number;
}

/**
 * Internal state of one push() call
 *
 * @interface Session
 * @private
 */
interface Session {
    fileIds: string[];
    promise: Promise<UploadStats>;
    finish: () => void;
    cancelled: boolean;
    cancelledStats?: UploadStats;
    startBytes: number;
    activeChunks: number;
    sleepers: Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>;
}

/**
 * An in-flight request, so it can be aborted
 *
 * @interface InFlightRequest
 * @private
 */
interface InFlightRequest {
    fileId: string;
    kind: 'chunk' | 'finalize' | 'status';
    controller: AbortController;
    reason?: 'paused' | 'cancelled' | 'failed' | 'timeout';
}

/**
 * One tus upload. A file is one upload, or with the concatenation extension
 * several partial uploads (lanes) covering consecutive byte ranges
 *
 * @interface TusLane
 * @private
 */
interface TusLane {
    /** Upload URL once the upload has been created */
    url: string | null;
    /** First byte of the file in this upload */
    start: number;
    /** End of the byte range (exclusive) */
    end: number;
    /** False when the server's offset may differ from what the client knows */
    synced: boolean;
    /** Times the server lost the upload or data, to stop endless recovery */
    recoveries: number;
}

/**
 * tus state of one file
 *
 * @interface TusState
 * @private
 */
interface TusState {
    /** True when the lanes are partial uploads joined by concatenation */
    parallel: boolean;
    lanes: TusLane[];
    /** URL of the final upload created by concatenation */
    finalUrl: string | null;
    /** Encoded Upload-Metadata header value */
    metadata: string;
}

/**
 * What a tus server announced in its OPTIONS response
 *
 * @interface TusCapabilities
 * @private
 */
interface TusCapabilities {
    /** Tus-Extension values, lowercased */
    extensions: string[];
    /** Tus-Max-Size, or null if not announced */
    maxSize: number | null;
    /** Tus-Checksum-Algorithm values, lowercased */
    checksumAlgorithms: string[];
}

/**
 * tus upload state kept in localStorage in resumable mode
 *
 * @interface SavedTusUpload
 * @private
 */
interface SavedTusUpload {
    v: 1;
    fileId: string;
    parallel: boolean;
    lanes: { url: string | null; start: number; end: number }[];
}

/**
 * Thrown internally when a chunk request was aborted by pause()
 * @private
 */
class PausedSignal extends Error {}

/**
 * Thrown internally when a tus chunk must wait because an earlier chunk of
 * the same upload has to be sent (again) first
 * @private
 */
class RequeueSignal extends Error {}

/** Upload IDs the server accepts */
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** tus protocol version spoken by the client */
const TUS_VERSION = '1.0.0';

/** tus checksum algorithms Web Crypto can compute, in order of preference */
const TUS_CHECKSUMS: ReadonlyArray<readonly [string, string]> = [
    ['sha256', 'SHA-256'],
    ['sha512', 'SHA-512'],
    ['sha384', 'SHA-384'],
    ['sha1', 'SHA-1']
];

/** How often a tus upload may be lost (or lose data) on the server before the file fails */
const TUS_MAX_RECOVERIES = 3;

/** A valid tus metadata key: printable ASCII without spaces or commas */
const TUS_METADATA_KEY = /^[\x21-\x2B\x2D-\x7E]+$/;

/**
 * TurboPush - Main file upload class
 *
 * Manages chunked file uploads with parallel processing, retry logic,
 * and comprehensive progress tracking.
 *
 * @class TurboPush
 * @since 1.0.0
 */
export class TurboPush {
    /** Validated and normalized configuration with all defaults applied */
    private config: ResolvedConfig;

    /** What the tus server announced, once discovered */
    private tusCapabilities: TusCapabilities | null = null;

    /** Map of fileId -> file state, in the order files were added */
    private entries: Map<string, FileEntry> = new Map();

    /** In-flight requests by key, for pause and cancel */
    private inFlight: Map<string, InFlightRequest> = new Map();

    /** The running push() session, if any */
    private session: Session | null = null;

    /** Aggregate statistics for the entire upload session */
    private stats: UploadStats;

    /** Callback function for progress updates */
    private progressCallback?: (progress: UploadProgress[]) => void;

    /** Callback function when individual file completes */
    private fileCompleteCallback?: (fileName: string, fileId: string, result: UploadResult) => void;

    /** Callback function when all uploads complete */
    private completeCallback?: (stats: UploadStats) => void;

    /** Callback function for error handling */
    private errorCallback?: (error: Error, fileName: string, fileId: string) => void;

    /** Callback function for retries */
    private retryCallback?: (info: RetryInfo) => void;

    /** Whether uploads are currently paused */
    private isPaused: boolean = false;

    /**
     * Creates a new TurboPush instance
     *
     * @param {TurboPushConfig} config - Configuration options
     * @throws {Error} If endpoint is not provided, the protocol is unknown or a tus metadata key is invalid
     *
     * @example
     * ```typescript
     * const uploader = new TurboPush({
     *     endpoint: '/api/upload',
     *     chunkSize: 2 * 1024 * 1024, // 2MB chunks
     *     maxConcurrentUploads: 5,
     *     maxRetries: 3
     * });
     * ```
     */
    constructor(config: TurboPushConfig) {
        // Validate required configuration
        if (!config || !config.endpoint) {
            throw new Error('TurboPush: endpoint is required');
        }

        const protocol = config.protocol === undefined ? 'turbopush' : config.protocol;
        if (protocol !== 'turbopush' && protocol !== 'tus') {
            throw new Error('TurboPush: protocol must be "turbopush" or "tus"');
        }

        const tus = config.tus || {};
        if (tus.metadata && typeof tus.metadata === 'object') {
            for (const key of Object.keys(tus.metadata)) {
                if (!TUS_METADATA_KEY.test(key)) {
                    throw new Error(`TurboPush: invalid tus metadata key "${key}"`);
                }
            }
        }

        const retryDelay = Math.max(100, TurboPush.positive(config.retryDelay, 1000)); // Minimum 100ms

        // Apply defaults and constraints to configuration
        this.config = {
            endpoint: config.endpoint,
            chunkSize: TurboPush.positive(config.chunkSize, 1024 * 1024), // Default 1MB
            maxConcurrentUploads: Math.max(1, Math.min(10, Math.floor(TurboPush.number(config.maxConcurrentUploads, 3)))), // Clamp 1-10
            maxRetries: Math.max(0, Math.floor(TurboPush.number(config.maxRetries, 3))), // Minimum 0
            retryDelay,
            maxRetryDelay: Math.max(retryDelay, TurboPush.number(config.maxRetryDelay, 30000)),
            timeout: Math.max(5000, TurboPush.positive(config.timeout, 30000)), // Minimum 5s
            headers: config.headers || {},
            withCredentials: config.withCredentials || false,
            resumable: config.resumable || false,
            protocol,
            tus: {
                metadata: tus.metadata,
                parallel: tus.parallel !== false,
                checksum: tus.checksum !== false
            }
        };

        // Initialize statistics
        this.stats = TurboPush.emptyStats();
    }

    /**
     * Adds a single file to the upload queue
     * Generates a unique file ID and initializes progress tracking
     *
     * @param {File} file - The file to upload
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.addFile(fileInput.files[0]);
     * ```
     */
    public addFile(file: File): this {
        let fileId: string | null = null;
        let restored = false;
        let tus: TusState | null = null;

        // In resumable mode, reuse the ID of an earlier, unfinished upload of this file
        if (this.config.resumable && this.config.protocol === 'tus') {
            // tus: the saved state holds the upload URLs; it is written once an upload exists
            const saved = TurboPush.parseSavedTus(this.storageGet(this.storageKey(file)), file.size);
            if (saved && !this.entries.has(saved.fileId)) {
                fileId = saved.fileId;
                restored = true;
                tus = {
                    parallel: saved.parallel,
                    lanes: saved.lanes.map(lane => TurboPush.newLane(lane.url, lane.start, lane.end)),
                    finalUrl: null,
                    metadata: ''
                };
            }
        } else if (this.config.resumable) {
            const key = this.storageKey(file);
            const stored = this.storageGet(key);
            const valid = stored !== null && UPLOAD_ID_PATTERN.test(stored);
            if (valid && !this.entries.has(stored!)) {
                fileId = stored!;
                restored = true;
            } else if (!valid) {
                fileId = this.generateFileId(file);
                this.storageSet(key, fileId);
            }
        }

        if (fileId === null) {
            fileId = this.generateFileId(file);
        }

        this.entries.set(fileId, {
            file,
            progress: {
                file,
                fileName: file.name,
                fileId,
                totalSize: file.size,
                uploadedSize: 0,
                percentage: 0,
                speed: 0,
                remainingTime: 0,
                status: 'pending'
            },
            chunks: null,
            chunkSize: this.config.chunkSize,
            started: false,
            finalizing: false,
            restored,
            tus,
            retryTimers: new Set(),
            lastSpeedTime: 0,
            lastSpeedBytes: 0
        });

        // Update session statistics
        this.stats.totalFiles++;
        this.stats.totalBytes += file.size;

        return this;
    }

    /**
     * Adds multiple files to the upload queue
     *
     * @param {File[] | FileList} files - Array or FileList of files to upload
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * // From file input
     * uploader.addFiles(fileInput.files);
     *
     * // From array
     * uploader.addFiles([file1, file2, file3]);
     * ```
     */
    public addFiles(files: File[] | FileList): this {
        Array.from(files).forEach(file => this.addFile(file));
        return this;
    }

    /**
     * Registers a callback for progress updates
     * Called whenever upload progress or a file's status changes
     *
     * @param {Function} callback - Callback receiving array of progress objects
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.onProgress((progress) => {
     *     progress.forEach(p => {
     *         console.log(`${p.fileName}: ${p.percentage}% at ${p.speed} B/s`);
     *     });
     * });
     * ```
     */
    public onProgress(callback: (progress: UploadProgress[]) => void): this {
        this.progressCallback = callback;
        return this;
    }

    /**
     * Registers a callback for individual file completion
     * Called when each file finishes uploading successfully
     *
     * @param {Function} callback - Callback receiving fileName, fileId and the server's response data
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.onFileComplete((fileName, fileId, result) => {
     *     console.log(`Completed: ${fileName}, stored as ${result.fileName}`);
     * });
     * ```
     */
    public onFileComplete(callback: (fileName: string, fileId: string, result: UploadResult) => void): this {
        this.fileCompleteCallback = callback;
        return this;
    }

    /**
     * Registers a callback for upload session completion
     * Called once when all files have finished (successfully or with errors).
     * Not called when the session is cancelled.
     *
     * @param {Function} callback - Callback receiving final statistics
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.onComplete((stats) => {
     *     console.log(`Uploaded ${stats.completedFiles}/${stats.totalFiles} files`);
     *     console.log(`Total time: ${stats.duration}s`);
     * });
     * ```
     */
    public onComplete(callback: (stats: UploadStats) => void): this {
        this.completeCallback = callback;
        return this;
    }

    /**
     * Registers a callback for error handling
     * Called whenever a file fails to upload after all retries.
     * The error is a TurboPushError with the server's message and status.
     *
     * @param {Function} callback - Callback receiving error, fileName, and fileId
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.onError((error, fileName, fileId) => {
     *     console.error(`Failed to upload ${fileName}: ${error.message}`);
     * });
     * ```
     */
    public onError(callback: (error: Error, fileName: string, fileId: string) => void): this {
        this.errorCallback = callback;
        return this;
    }

    /**
     * Registers a callback for retries
     * Called before a failed chunk or finalize request is retried
     *
     * @param {Function} callback - Callback receiving retry information
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.onRetry(({ fileName, chunkIndex, attempt, delay }) => {
     *     console.warn(`Retrying chunk ${chunkIndex} of ${fileName} in ${delay}ms (attempt ${attempt})`);
     * });
     * ```
     */
    public onRetry(callback: (info: RetryInfo) => void): this {
        this.retryCallback = callback;
        return this;
    }

    /**
     * Updates the chunk size for files that have not started uploading
     *
     * @param {number} bytes - New chunk size in bytes (minimum 64KB)
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.setChunkSize(5 * 1024 * 1024); // 5MB chunks
     * ```
     */
    public setChunkSize(bytes: number): this {
        this.config.chunkSize = Math.max(64 * 1024, bytes); // Minimum 64KB
        return this;
    }

    /**
     * Updates the maximum number of concurrent uploads
     *
     * @param {number} count - Number of concurrent uploads (1-10)
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.setMaxConcurrentUploads(8);
     * ```
     */
    public setMaxConcurrentUploads(count: number): this {
        this.config.maxConcurrentUploads = Math.max(1, Math.min(10, Math.floor(count)));
        this.pump();
        return this;
    }

    /**
     * Updates the maximum retry attempts for failed chunks
     *
     * @param {number} count - Number of retry attempts (minimum 0)
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.setMaxRetries(5);
     * ```
     */
    public setMaxRetries(count: number): this {
        this.config.maxRetries = Math.max(0, Math.floor(count));
        return this;
    }

    /**
     * Starts the upload process for all queued files
     *
     * Uploads every file that is not already completed, so calling push()
     * again after some files failed retries just those files, sending only
     * the chunks the server does not have yet. If an upload is already
     * running, returns its promise. The promise resolves once every file has
     * completed or failed (or the session was cancelled); it does not reject
     * when files fail, check the statistics or use onError.
     *
     * @returns {Promise<UploadStats>} Promise resolving to final upload statistics
     * @throws {Error} If no files are queued
     *
     * @example
     * ```typescript
     * const stats = await uploader.push();
     * console.log(`Uploaded ${stats.completedFiles} files in ${stats.duration}s`);
     * ```
     */
    public push(): Promise<UploadStats> {
        if (this.entries.size === 0) {
            return Promise.reject(new Error('TurboPush: No files to upload'));
        }

        if (this.session) {
            if (this.isPaused) {
                this.resume();
            }
            return this.session.promise;
        }

        this.isPaused = false;

        let finish: () => void = () => undefined;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        const session: Session = {
            fileIds: [],
            promise: Promise.resolve(this.stats),
            finish: () => finish(),
            cancelled: false,
            startBytes: this.stats.uploadedBytes,
            activeChunks: 0,
            sleepers: new Set()
        };
        this.session = session;
        session.promise = this.runSession(session, finished);
        return session.promise;
    }

    /**
     * Alias for push() method
     * Starts the upload process
     *
     * @returns {Promise<UploadStats>} Promise resolving to final upload statistics
     */
    public upload(): Promise<UploadStats> {
        return this.push();
    }

    /**
     * Pauses all active uploads
     * Aborts in-progress chunk requests and marks files as paused.
     * Aborted chunks are sent again on resume and do not count as retries.
     * The promise returned by push() stays pending until the uploads finish.
     *
     * @returns {void}
     *
     * @example
     * ```typescript
     * uploader.pause();
     * // Later...
     * await uploader.resume();
     * ```
     */
    public pause(): void {
        this.isPaused = true;

        // Abort all active chunk uploads
        for (const request of this.inFlight.values()) {
            if (request.kind === 'chunk') {
                request.reason = 'paused';
                request.controller.abort();
            }
        }

        // Update file statuses
        let changed = false;
        for (const entry of this.entries.values()) {
            if (entry.progress.status === 'uploading') {
                entry.progress.status = 'paused';
                entry.progress.speed = 0;
                entry.progress.remainingTime = 0;
                changed = true;
            }
        }
        if (changed) {
            this.emitProgress();
        }
    }

    /**
     * Resumes paused uploads
     * Continues the running session, or starts a new one if files are
     * waiting and nothing is running.
     *
     * @returns {Promise<void>} Promise that resolves when the uploads have finished
     *
     * @example
     * ```typescript
     * uploader.pause();
     * // Later...
     * await uploader.resume();
     * ```
     */
    public async resume(): Promise<void> {
        this.isPaused = false;

        if (!this.session) {
            const waiting = Array.from(this.entries.values())
                .some(entry => entry.progress.status === 'paused' || entry.progress.status === 'pending');
            if (waiting) {
                await this.push();
            }
            return;
        }

        const session = this.session;
        let changed = false;
        for (const entry of this.entries.values()) {
            if (entry.progress.status === 'paused') {
                entry.progress.status = 'uploading';
                entry.lastSpeedTime = Date.now();
                entry.lastSpeedBytes = entry.progress.uploadedSize;
                changed = true;
            }
        }
        if (changed) {
            this.emitProgress();
        }

        this.pump();
        await session.promise;
    }

    /**
     * Cancels all uploads and clears the queue
     * Aborts all active requests, asks the server to delete the chunks of
     * unfinished files (with tus: a DELETE request, if the server supports
     * the termination extension), removes all queued files and resets the
     * statistics.
     * A pending push() promise resolves with `cancelled: true`; onComplete
     * is not called. Cannot be resumed after cancellation.
     *
     * @returns {void}
     *
     * @example
     * ```typescript
     * uploader.cancel(); // Completely stop and clear everything
     * ```
     */
    public cancel(): void {
        const session = this.session;

        // Abort all active requests
        for (const request of this.inFlight.values()) {
            request.reason = 'cancelled';
            request.controller.abort();
        }

        // Tell the server to drop chunks of unfinished uploads
        for (const [fileId, entry] of this.entries) {
            for (const timer of entry.retryTimers) {
                clearTimeout(timer);
            }
            if (entry.progress.status !== 'completed') {
                if (entry.tus) {
                    this.tusTerminate(entry);
                } else if (entry.started || entry.restored) {
                    this.sendAbort(fileId);
                }
                this.storageRemove(entry);
            }
        }

        if (session) {
            session.cancelled = true;
            for (const sleeper of session.sleepers) {
                clearTimeout(sleeper.timer);
                sleeper.wake();
            }
            session.sleepers.clear();
            const endTime = Date.now();
            const duration = (endTime - this.stats.startTime) / 1000;
            session.cancelledStats = {
                ...this.stats,
                endTime,
                duration,
                averageSpeed: (this.stats.uploadedBytes - session.startBytes) / (duration || 1),
                cancelled: true
            };
            this.session = null;
            session.finish();
        }

        this.entries.clear();
        this.isPaused = false;
        this.stats = TurboPush.emptyStats();
    }

    /**
     * Gets current upload statistics
     * Returns a copy of the statistics object
     *
     * @returns {UploadStats} Current upload statistics
     *
     * @example
     * ```typescript
     * const stats = uploader.getStats();
     * console.log(`Progress: ${stats.uploadedBytes}/${stats.totalBytes} bytes`);
     * ```
     */
    public getStats(): UploadStats {
        return { ...this.stats };
    }

    /**
     * Gets progress information for all files
     *
     * @returns {UploadProgress[]} Array of progress objects for all files
     *
     * @example
     * ```typescript
     * const progress = uploader.getProgress();
     * progress.forEach(p => {
     *     console.log(`${p.fileName}: ${p.percentage}%`);
     * });
     * ```
     */
    public getProgress(): UploadProgress[] {
        return Array.from(this.entries.values(), entry => entry.progress);
    }

    /**
     * Gets progress information for a specific file by name
     *
     * @param {string} fileName - Name of the file to get progress for
     * @returns {UploadProgress | undefined} Progress object or undefined if not found
     *
     * @example
     * ```typescript
     * const progress = uploader.getFileProgress('document.pdf');
     * if (progress) {
     *     console.log(`${progress.percentage}% complete`);
     * }
     * ```
     */
    public getFileProgress(fileName: string): UploadProgress | undefined {
        for (const entry of this.entries.values()) {
            if (entry.progress.fileName === fileName) {
                return entry.progress;
            }
        }
        return undefined;
    }

    /**
     * Checks if uploads are currently paused
     *
     * @returns {boolean} True if paused, false otherwise
     *
     * @example
     * ```typescript
     * if (uploader.isPausedState()) {
     *     console.log('Uploads are paused');
     * }
     * ```
     */
    public isPausedState(): boolean {
        return this.isPaused;
    }

    /**
     * Gets the number of files currently in the queue
     *
     * @returns {number} Number of queued files
     *
     * @example
     * ```typescript
     * console.log(`${uploader.getQueueSize()} files queued`);
     * ```
     */
    public getQueueSize(): number {
        return this.entries.size;
    }

    /**
     * Runs one upload session until every file has completed or failed
     *
     * @private
     * @param {Session} session - The session
     * @param {Promise<void>} finished - Resolves when all files are done or the session is cancelled
     * @returns {Promise<UploadStats>} Final statistics
     */
    private async runSession(session: Session, finished: Promise<void>): Promise<UploadStats> {
        this.stats.startTime = Date.now();
        delete this.stats.endTime;
        delete this.stats.duration;
        delete this.stats.averageSpeed;

        // tus: learn which extensions the server supports before planning uploads
        if (this.config.protocol === 'tus') {
            await this.tusDiscover();
            if (session.cancelled) {
                await finished;
                return session.cancelledStats!;
            }
        }

        // Prepare every file that still needs uploading
        for (const [fileId, entry] of this.entries) {
            if (entry.progress.status === 'completed') {
                continue;
            }
            if (entry.progress.status === 'failed') {
                this.stats.failedFiles--;
                delete entry.progress.error;
            }
            if (!entry.chunks) {
                entry.chunkSize = this.config.chunkSize;
                entry.chunks = this.config.protocol === 'tus'
                    ? this.tusPlan(entry)
                    : this.createChunks(entry.file, entry.chunkSize);
            }
            // Give every unfinished chunk a fresh retry budget
            for (const chunk of entry.chunks) {
                chunk.attempts = 0;
                if (chunk.state !== 'done') {
                    chunk.state = 'pending';
                }
            }
            entry.progress.status = 'pending';
            session.fileIds.push(fileId);
        }

        // Ask the server what it already has for restored uploads
        if (this.config.resumable) {
            await Promise.all(session.fileIds.map(fileId => this.restoreFromServer(session, fileId)));
            session.startBytes = this.stats.uploadedBytes;
        }

        if (!session.cancelled) {
            for (const fileId of session.fileIds) {
                const entry = this.entries.get(fileId);
                if (entry && entry.progress.status === 'pending' && entry.chunks!.every(c => c.state === 'done')) {
                    this.finalizeFile(session, entry);
                }
            }
            this.pump();
            this.checkSessionDone(session);
        }

        await finished;

        if (session.cancelled) {
            return session.cancelledStats!;
        }

        // Calculate final statistics
        this.stats.endTime = Date.now();
        this.stats.duration = (this.stats.endTime - this.stats.startTime) / 1000;
        this.stats.averageSpeed = (this.stats.uploadedBytes - session.startBytes) / (this.stats.duration || 1);

        // Take the result before the callback, which may start another push()
        const result = this.getStats();

        // Notify completion callback
        if (this.completeCallback) {
            const callback = this.completeCallback;
            TurboPush.safeCall(() => callback({ ...result }));
        }

        return result;
    }

    /**
     * Starts chunk uploads until the concurrency limit is reached
     * Files are served in the order they were added
     *
     * @private
     * @returns {void}
     */
    private pump(): void {
        const session = this.session;
        if (!session || session.cancelled || this.isPaused) {
            return;
        }

        for (const fileId of session.fileIds) {
            const entry = this.entries.get(fileId);
            if (!entry || !entry.chunks || entry.finalizing) {
                continue;
            }
            const status = entry.progress.status;
            if (status === 'completed' || status === 'failed') {
                continue;
            }
            // tus: each upload takes its chunks one at a time, in order
            const startable = entry.tus ? TurboPush.tusStartable(entry.chunks) : null;
            for (const chunk of entry.chunks) {
                // A callback run by startChunk() may have paused or cancelled
                if (session.cancelled || this.isPaused || this.session !== session) {
                    return;
                }
                if (session.activeChunks >= this.config.maxConcurrentUploads) {
                    return;
                }
                if (chunk.state === 'pending' && (!startable || startable.has(chunk.index))) {
                    this.startChunk(session, entry, chunk);
                }
            }
        }
    }

    /**
     * Uploads one chunk and handles the outcome
     *
     * @private
     * @param {Session} session - The session
     * @param {FileEntry} entry - The file
     * @param {ChunkInfo} chunk - The chunk
     * @returns {void}
     */
    private startChunk(session: Session, entry: FileEntry, chunk: ChunkInfo): void {
        chunk.state = 'uploading';
        const token = ++chunk.token;
        session.activeChunks++;
        entry.started = true;

        if (entry.progress.status !== 'uploading') {
            entry.progress.status = 'uploading';
            entry.lastSpeedTime = Date.now();
            entry.lastSpeedBytes = entry.progress.uploadedSize;
            this.emitProgress();

            // The progress callback may have paused or cancelled
            if (session.cancelled || this.isPaused || this.session !== session) {
                if (chunk.token === token && chunk.state === 'uploading') {
                    chunk.state = 'pending';
                }
                session.activeChunks--;
                return;
            }
        }

        this.uploadChunk(entry, chunk)
            .then(
                () => this.handleChunkSuccess(session, entry, chunk),
                (error) => this.handleChunkError(session, entry, chunk, token, error)
            )
            .finally(() => {
                session.activeChunks--;
                this.pump();
            });
    }

    /**
     * Records a successful chunk and finalizes the file when it was the last one
     *
     * @private
     */
    private handleChunkSuccess(session: Session, entry: FileEntry, chunk: ChunkInfo): void {
        if (session.cancelled || this.entries.get(entry.progress.fileId) !== entry) {
            return;
        }

        // The server has the chunk, even if the file failed meanwhile or this
        // answers an older request: count it once
        if (chunk.state !== 'done') {
            chunk.state = 'done';
            this.addUploadedBytes(entry, chunk.end - chunk.start);
        }

        const status = entry.progress.status;
        if (this.session === session && status !== 'failed' && status !== 'completed') {
            this.updateSpeed(entry);
            this.emitProgress();
        }

        this.maybeFinalize(entry);
    }

    /**
     * Finalizes a file of the running session once all its chunks are uploaded
     *
     * @private
     */
    private maybeFinalize(entry: FileEntry): void {
        const session = this.session;
        const fileId = entry.progress.fileId;
        if (!session || session.cancelled || entry.finalizing || !entry.chunks) {
            return;
        }
        if (!session.fileIds.includes(fileId) || this.entries.get(fileId) !== entry) {
            return;
        }
        const status = entry.progress.status;
        if (status === 'failed' || status === 'completed') {
            return;
        }
        if (entry.chunks.every(c => c.state === 'done')) {
            this.finalizeFile(session, entry);
        }
    }

    /**
     * Schedules a retry for a failed chunk, or fails the file
     *
     * @private
     */
    private handleChunkError(session: Session, entry: FileEntry, chunk: ChunkInfo, token: number, error: unknown): void {
        // Ignore answers to requests that were superseded or are no longer relevant
        if (session.cancelled || chunk.token !== token || chunk.state === 'done') {
            return;
        }

        // Aborted by pause(), because another chunk failed, or after the
        // session ended, or (tus) an earlier chunk must go first: send again later
        if (this.session !== session
            || error instanceof PausedSignal
            || error instanceof RequeueSignal
            || entry.progress.status === 'failed') {
            chunk.state = 'pending';
            return;
        }

        const failure = TurboPush.toTurboPushError(error, chunk.index);

        if (failure.retryable && chunk.attempts < this.config.maxRetries) {
            chunk.attempts++;
            chunk.state = 'waiting';
            const delay = this.retryDelayFor(chunk.attempts);
            this.emitRetry(entry, chunk.index, chunk.attempts, delay, failure);

            const timer = setTimeout(() => {
                entry.retryTimers.delete(timer);
                if (chunk.state === 'waiting') {
                    chunk.state = 'pending';
                    this.pump();
                }
            }, delay);
            entry.retryTimers.add(timer);
            return;
        }

        chunk.state = 'pending';
        this.failFile(session, entry, failure);
    }

    /**
     * Marks a file as failed and stops its other requests
     *
     * @private
     */
    private failFile(session: Session, entry: FileEntry, error: TurboPushError): void {
        const status = entry.progress.status;
        if (status === 'failed' || status === 'completed') {
            return;
        }

        // Handle upload failure
        entry.progress.status = 'failed';
        entry.progress.error = error.message;
        entry.progress.speed = 0;
        entry.progress.remainingTime = 0;
        this.stats.failedFiles++;

        // Stop the file's other chunks
        for (const request of this.inFlight.values()) {
            if (request.fileId === entry.progress.fileId && request.kind === 'chunk') {
                request.reason = 'failed';
                request.controller.abort();
            }
        }
        for (const timer of entry.retryTimers) {
            clearTimeout(timer);
        }
        entry.retryTimers.clear();
        for (const chunk of entry.chunks || []) {
            if (chunk.state === 'waiting') {
                chunk.state = 'pending';
            }
        }

        this.emitProgress();

        // Notify error callback
        if (this.errorCallback) {
            const callback = this.errorCallback;
            TurboPush.safeCall(() => callback(error, entry.file.name, entry.progress.fileId));
        }

        this.checkSessionDone(session);
    }

    /**
     * Sends the finalize request for a file and records the result
     *
     * @private
     */
    private async finalizeFile(session: Session, entry: FileEntry): Promise<void> {
        entry.finalizing = true;

        try {
            const result = await this.finalizeWithRetries(session, entry);
            if (session.cancelled) {
                return;
            }

            // Update final status
            entry.progress.status = 'completed';
            entry.progress.percentage = 100;
            entry.progress.uploadedSize = entry.file.size;
            entry.progress.speed = 0;
            entry.progress.remainingTime = 0;
            entry.progress.result = result;
            this.stats.completedFiles++;
            this.storageRemove(entry);

            this.emitProgress();

            // Notify file complete callback
            if (this.fileCompleteCallback) {
                const callback = this.fileCompleteCallback;
                TurboPush.safeCall(() => callback(entry.file.name, entry.progress.fileId, result));
            }
        } catch (error) {
            if (!session.cancelled) {
                const failure = TurboPush.toTurboPushError(error);
                this.resetLostChunks(entry, failure);
                this.failFile(session, entry, failure);
            }
        } finally {
            entry.finalizing = false;
            this.checkSessionDone(session);
        }
    }

    /**
     * Marks chunks as not uploaded when finalize shows the server lost them
     * (404: the upload expired; 409: chunks missing), so push() sends them again
     *
     * @private
     */
    private resetLostChunks(entry: FileEntry, error: TurboPushError): void {
        // tus: the partial uploads expired before they were joined, start over
        if (entry.tus) {
            if (error.status === 404 || error.status === 410) {
                this.tusReset(entry);
            }
            return;
        }

        if (!entry.chunks || (error.status !== 404 && error.status !== 409)) {
            return;
        }

        const missing = (error.data as { missingChunks?: unknown } | undefined)?.missingChunks;
        const indexes = Array.isArray(missing) && missing.length > 0
            ? missing.filter(index => Number.isInteger(index) && index >= 0 && index < entry.chunks!.length) as number[]
            : entry.chunks.map(chunk => chunk.index);

        for (const index of indexes) {
            const chunk = entry.chunks[index];
            if (chunk.state === 'done') {
                chunk.state = 'pending';
                this.addUploadedBytes(entry, -(chunk.end - chunk.start));
            }
        }
    }

    /**
     * Sends the finalize request, retrying temporary failures with backoff
     * The server treats repeated finalize requests as one, so retrying is safe
     *
     * @private
     * @returns {Promise<UploadResult>} The server's response data
     */
    private async finalizeWithRetries(session: Session, entry: FileEntry): Promise<UploadResult> {
        for (let attempt = 1; ; attempt++) {
            if (session.cancelled) {
                throw new TurboPushError('Upload cancelled', { code: 'cancelled' });
            }
            try {
                return await this.finalizeUpload(entry);
            } catch (error) {
                const failure = TurboPush.toTurboPushError(error);
                if (session.cancelled || !failure.retryable || attempt > this.config.maxRetries) {
                    throw failure;
                }
                const delay = this.retryDelayFor(attempt);
                this.emitRetry(entry, null, attempt, delay, failure);
                await this.sleep(session, delay);
            }
        }
    }

    /**
     * Resolves the session once every file has completed or failed
     *
     * @private
     */
    private checkSessionDone(session: Session): void {
        if (session.cancelled || this.session !== session) {
            return;
        }
        const busy = session.fileIds.some(fileId => {
            const entry = this.entries.get(fileId);
            if (!entry) {
                return false;
            }
            const status = entry.progress.status;
            return entry.finalizing || (status !== 'completed' && status !== 'failed');
        });
        if (!busy) {
            this.session = null;
            session.finish();
        }
    }

    /**
     * Asks the server which chunks of a restored upload it already has
     * Starts the upload from scratch if the server has nothing usable
     *
     * @private
     */
    private async restoreFromServer(session: Session, fileId: string): Promise<void> {
        const entry = this.entries.get(fileId);
        if (entry && entry.tus) {
            return this.tusRestore(session, entry);
        }
        if (!entry || !entry.restored || entry.started || !entry.chunks) {
            return;
        }

        let data: Record<string, unknown>;
        try {
            const body = await this.request(fileId, `${fileId}:status`, 'status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.config.headers },
                body: JSON.stringify({ action: 'status', fileId })
            });
            data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
        } catch (error) {
            // Unknown upload: start fresh. For any other failure the server may
            // hold chunks of a different size under this ID, so drop them first
            if (!(error instanceof TurboPushError && error.status === 404) && !session.cancelled) {
                await this.sendAbort(fileId);
            }
            return;
        }

        if (session.cancelled || this.entries.get(fileId) !== entry) {
            return;
        }

        if (data.complete === true && data.fileSize === entry.file.size) {
            // Uploaded completely before the page was reloaded
            for (const chunk of entry.chunks) {
                if (chunk.state !== 'done') {
                    chunk.state = 'done';
                    this.addUploadedBytes(entry, chunk.end - chunk.start);
                }
            }
            const { complete, ...result } = data;
            entry.progress.status = 'completed';
            entry.progress.percentage = 100;
            entry.progress.result = result as UploadResult;
            this.stats.completedFiles++;
            this.storageRemove(entry);
            this.emitProgress();
            if (this.fileCompleteCallback) {
                const callback = this.fileCompleteCallback;
                TurboPush.safeCall(() => callback(entry.file.name, fileId, result as UploadResult));
            }
            return;
        }

        const uploaded = data.uploadedChunks;
        if (data.complete === false
            && data.fileSize === entry.file.size
            && data.totalChunks === entry.chunks.length
            && Array.isArray(uploaded)) {
            for (const index of uploaded) {
                if (!Number.isInteger(index) || index < 0 || index >= entry.chunks.length) {
                    continue;
                }
                const chunk = entry.chunks[index];
                if (chunk.state !== 'done') {
                    chunk.state = 'done';
                    this.addUploadedBytes(entry, chunk.end - chunk.start);
                }
            }
            entry.started = true;
            this.emitProgress();
            return;
        }

        // The server holds something incompatible (for example a different
        // chunk size): drop it and start again
        await this.sendAbort(fileId);
    }

    /**
     * Uploads a single chunk to the server
     *
     * @private
     * @param {FileEntry} entry - The file
     * @param {ChunkInfo} chunk - Chunk metadata and data
     * @returns {Promise<void>} Promise that resolves when chunk uploads
     * @throws {TurboPushError|PausedSignal} If upload fails, times out or is paused
     */
    private async uploadChunk(entry: FileEntry, chunk: ChunkInfo): Promise<void> {
        if (entry.tus) {
            return this.tusUploadChunk(entry, chunk);
        }

        const fileId = entry.progress.fileId;

        // Prepare form data with metadata first, then the chunk
        const formData = new FormData();
        formData.append('fileName', entry.file.name);
        formData.append('fileId', fileId);
        formData.append('chunkIndex', chunk.index.toString());
        formData.append('totalChunks', entry.chunks!.length.toString());
        formData.append('fileSize', entry.file.size.toString());
        formData.append('file', chunk.blob);

        // The browser sets the multipart Content-Type with its boundary
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(this.config.headers)) {
            if (name.toLowerCase() !== 'content-type') {
                headers[name] = value;
            }
        }

        await this.request(fileId, `${fileId}:${chunk.index}`, 'chunk', {
            method: 'POST',
            body: formData,
            headers
        }, chunk.index);
    }

    /**
     * Sends finalization request to server after all chunks uploaded
     * Tells server to merge chunks into final file
     *
     * @private
     * @param {FileEntry} entry - The file
     * @returns {Promise<UploadResult>} The server's response data
     * @throws {TurboPushError} If finalization fails
     */
    private async finalizeUpload(entry: FileEntry): Promise<UploadResult> {
        if (entry.tus) {
            return this.tusFinalize(entry);
        }

        const fileId = entry.progress.fileId;
        const body = await this.request(fileId, `${fileId}:finalize`, 'finalize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.config.headers
            },
            body: JSON.stringify({
                action: 'finalize',
                fileName: entry.file.name,
                fileId,
                fileSize: entry.file.size,
                totalChunks: entry.chunks!.length
            })
        }, undefined, 'Finalization failed');

        return (body.data && typeof body.data === 'object' && !Array.isArray(body.data)
            ? body.data
            : {}) as UploadResult;
    }

    /**
     * Asks the server to delete an upload's chunks (best effort)
     *
     * @private
     * @param {string} fileId - Upload ID
     * @returns {Promise<void>} Resolves when the request has finished, successful or not
     */
    private async sendAbort(fileId: string): Promise<void> {
        try {
            await fetch(this.config.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.config.headers },
                body: JSON.stringify({ action: 'abort', fileId }),
                credentials: this.config.withCredentials ? 'include' : 'omit',
                keepalive: true
            });
        } catch (error) {
            // Abandoned chunks are also removed by the server's cleanup
        }
    }

    /**
     * Sends a request with a timeout and turns every failure into a TurboPushError
     *
     * @private
     * @param {string} fileId - Upload ID the request belongs to
     * @param {string} key - Unique key for the in-flight request
     * @param {string} kind - Request kind
     * @param {RequestInit} init - Fetch options
     * @param {number} [chunkIndex] - Chunk index, for error details
     * @param {string} [failureMessage] - Message when the server reports failure without one
     * @returns {Promise<Record<string, any>>} The parsed JSON response
     */
    private async request(
        fileId: string,
        key: string,
        kind: InFlightRequest['kind'],
        init: RequestInit,
        chunkIndex?: number,
        failureMessage: string = 'Upload failed'
    ): Promise<Record<string, any>> {
        const { response, body } = await this.send(
            fileId, key, kind, this.config.endpoint, init, chunkIndex, TurboPush.readJson
        );

        const result = (body && typeof body === 'object' ? body : null) as Record<string, any> | null;
        const serverMessage = result && typeof (result.message ?? result.error) === 'string'
            ? (result.message ?? result.error) as string
            : null;

        // Check for HTTP errors
        if (!response.ok) {
            const status = response.status;
            throw new TurboPushError(
                serverMessage || `HTTP ${status}${response.statusText ? ': ' + response.statusText : ''}`,
                {
                    code: 'http',
                    status,
                    retryable: status === 408 || status === 429 || status >= 500,
                    chunkIndex,
                    data: result ? result.data : undefined
                }
            );
        }

        // Parse and validate response
        if (!result) {
            throw new TurboPushError('Invalid response from server', {
                code: 'invalid_response', status: response.status, retryable: true, chunkIndex
            });
        }
        if (!result.success) {
            throw new TurboPushError(serverMessage || failureMessage, {
                code: 'server', status: response.status, retryable: false, chunkIndex, data: result.data
            });
        }

        return result;
    }

    /**
     * Sends one HTTP request with a timeout, registered so pause() and
     * cancel() can abort it, and reads the response body
     *
     * Network failures, timeouts and deliberate aborts become a
     * TurboPushError (or a PausedSignal); HTTP error statuses do not, the
     * caller checks the response.
     *
     * @private
     * @param {string} fileId - Upload ID the request belongs to
     * @param {string} key - Unique key for the in-flight request
     * @param {string} kind - Request kind
     * @param {string} url - Request URL
     * @param {RequestInit} init - Fetch options
     * @param {number | undefined} chunkIndex - Chunk index, for error details
     * @param {Function} read - Reads the response body
     * @returns {Promise<{ response: Response, body: T }>} The response and its body
     */
    private async send<T>(
        fileId: string,
        key: string,
        kind: InFlightRequest['kind'],
        url: string,
        init: RequestInit,
        chunkIndex: number | undefined,
        read: (response: Response) => Promise<T>
    ): Promise<{ response: Response; body: T }> {
        // Create AbortController for timeout/cancellation
        const controller = new AbortController();
        const record: InFlightRequest = { fileId, kind, controller };
        this.inFlight.set(key, record);

        // Set up timeout
        const timeoutId = setTimeout(() => {
            record.reason = 'timeout';
            controller.abort();
        }, this.config.timeout);

        try {
            let response: Response;
            let body: T;
            try {
                response = await fetch(url, {
                    ...init,
                    credentials: this.config.withCredentials ? 'include' : 'omit',
                    signal: controller.signal
                });
                body = await read(response);
            } catch (error) {
                throw this.abortError(record, chunkIndex) || new TurboPushError(
                    (error as Error)?.message || 'Network error',
                    { code: 'network', retryable: true, chunkIndex, cause: error }
                );
            }

            const aborted = this.abortError(record, chunkIndex);
            if (aborted) {
                throw aborted;
            }

            return { response, body };
        } finally {
            // Clean up timeout and abort controller
            clearTimeout(timeoutId);
            if (this.inFlight.get(key) === record) {
                this.inFlight.delete(key);
            }
        }
    }

    /**
     * Gets the error for a request that was aborted on purpose
     *
     * @private
     * @returns {Error | null} The error to throw, or null if the request was not aborted
     */
    private abortError(record: InFlightRequest, chunkIndex?: number): Error | null {
        switch (record.reason) {
            case 'paused':
                return new PausedSignal('Paused');
            case 'timeout':
                return new TurboPushError('Upload timeout', { code: 'timeout', retryable: true, chunkIndex });
            case 'cancelled':
            case 'failed':
                return new TurboPushError('Upload cancelled', { code: 'cancelled', retryable: false, chunkIndex });
            default:
                return null;
        }
    }

    // ------------------------------------------------------------------
    // tus transport (https://tus.io/protocols/resumable-upload)
    // ------------------------------------------------------------------

    /**
     * Asks the tus server which extensions it supports (OPTIONS request)
     *
     * The answer is kept for the lifetime of the instance. If the request
     * fails, the client uses only the core protocol and creation, which every
     * tus server that accepts uploads from browsers supports, and asks again
     * on the next push().
     *
     * @private
     * @returns {Promise<void>} Resolves when discovery has finished, successful or not
     */
    private async tusDiscover(): Promise<void> {
        if (this.tusCapabilities) {
            return;
        }
        try {
            const { response } = await this.send('', 'tus:options', 'status', this.config.endpoint, {
                method: 'OPTIONS',
                headers: this.tusHeaders({}, false)
            }, undefined, TurboPush.readText);
            if (response.ok) {
                this.tusCapabilities = {
                    extensions: TurboPush.headerList(response, 'Tus-Extension'),
                    maxSize: TurboPush.headerInteger(response, 'Tus-Max-Size'),
                    checksumAlgorithms: TurboPush.headerList(response, 'Tus-Checksum-Algorithm')
                };
            }
        } catch (error) {
            // Discovery is only a hint, see above
        }
    }

    /**
     * Gets the server's capabilities, or the core-only defaults
     *
     * @private
     */
    private tusCaps(): TusCapabilities {
        return this.tusCapabilities || { extensions: [], maxSize: null, checksumAlgorithms: [] };
    }

    /**
     * Plans the tus uploads of a file and creates its chunks
     *
     * With the concatenation extension (and tus.parallel), the file is split
     * into up to maxConcurrentUploads partial uploads of consecutive chunks,
     * uploaded side by side and joined at the end. Otherwise the file is one
     * upload whose chunks are sent in order. A restored file keeps its saved
     * plan.
     *
     * @private
     * @param {FileEntry} entry - The file
     * @returns {ChunkInfo[]} The chunks, aligned to the uploads
     */
    private tusPlan(entry: FileEntry): ChunkInfo[] {
        const size = entry.file.size;
        if (!entry.tus) {
            const chunkCount = Math.max(1, Math.ceil(size / entry.chunkSize));
            const parallel = this.config.tus.parallel
                && this.tusCaps().extensions.includes('concatenation')
                && chunkCount > 1
                && this.config.maxConcurrentUploads > 1;
            const laneCount = parallel ? Math.min(this.config.maxConcurrentUploads, chunkCount) : 1;
            const lanes: TusLane[] = [];
            for (let lane = 0; lane < laneCount; lane++) {
                const first = Math.floor(lane * chunkCount / laneCount);
                const last = Math.floor((lane + 1) * chunkCount / laneCount);
                lanes.push(TurboPush.newLane(null, first * entry.chunkSize, Math.min(last * entry.chunkSize, size)));
            }
            entry.tus = { parallel, lanes, finalUrl: null, metadata: '' };
        }
        entry.tus.metadata = this.tusMetadata(entry.file);
        return this.createChunks(entry.file, entry.chunkSize, entry.tus.lanes);
    }

    /**
     * Uploads one chunk of a tus upload
     *
     * Creates the upload first if needed, and asks the server for its offset
     * (HEAD) after anything that may have left it unsure, such as a failed or
     * aborted PATCH. If the server stored only part of a PATCH body, the rest
     * is sent from the offset it reports.
     *
     * @private
     * @param {FileEntry} entry - The file
     * @param {ChunkInfo} chunk - The chunk
     * @returns {Promise<void>} Resolves once the server has every byte of the chunk
     * @throws {TurboPushError|PausedSignal|RequeueSignal} If the upload fails, is paused or must wait
     */
    private async tusUploadChunk(entry: FileEntry, chunk: ChunkInfo): Promise<void> {
        const lane = entry.tus!.lanes[chunk.lane];
        const key = `${entry.progress.fileId}:${chunk.index}`;

        while (chunk.state !== 'done') {
            this.tusCheckActive(entry, chunk);
            if (lane.url === null) {
                await this.tusCreate(entry, chunk, key);
            } else if (!lane.synced) {
                await this.tusSync(entry, chunk, key);
            } else {
                await this.tusPatch(entry, chunk, key);
            }
        }
    }

    /**
     * Stops a tus chunk between requests if it was paused, cancelled or its file failed
     *
     * @private
     */
    private tusCheckActive(entry: FileEntry, chunk: ChunkInfo): void {
        if (this.entries.get(entry.progress.fileId) !== entry || entry.progress.status === 'failed') {
            throw new TurboPushError('Upload cancelled', { code: 'cancelled', retryable: false, chunkIndex: chunk.index });
        }
        if (this.isPaused) {
            throw new PausedSignal('Paused');
        }
    }

    /**
     * Creates the tus upload for a chunk's lane (POST)
     *
     * @private
     */
    private async tusCreate(entry: FileEntry, chunk: ChunkInfo, key: string): Promise<void> {
        const tus = entry.tus!;
        const lane = tus.lanes[chunk.lane];

        const maxSize = this.tusCaps().maxSize;
        if (maxSize !== null && entry.file.size > maxSize) {
            throw new TurboPushError(`File exceeds the server's maximum upload size of ${maxSize} bytes`, {
                code: 'http', status: 413, retryable: false, chunkIndex: chunk.index
            });
        }

        const headers: Record<string, string> = { 'Upload-Length': String(lane.end - lane.start) };
        if (tus.metadata) {
            headers['Upload-Metadata'] = tus.metadata;
        }
        if (tus.parallel) {
            headers['Upload-Concat'] = 'partial';
        }

        const { response, body } = await this.send(entry.progress.fileId, key, 'chunk', this.config.endpoint, {
            method: 'POST',
            headers: this.tusHeaders(headers)
        }, chunk.index, TurboPush.readText);

        if (!response.ok) {
            throw TurboPush.tusError(response, body, chunk.index, TurboPush.tusRetryable(response.status, false));
        }
        lane.url = this.tusLocation(response, chunk.index);
        lane.synced = true;
        this.tusSave(entry);
        this.tusRealign(entry, chunk, lane.start);
    }

    /**
     * Asks the server for a lane's offset (HEAD) and continues from there
     * If the upload is gone, the lane starts again with a new upload
     *
     * @private
     */
    private async tusSync(entry: FileEntry, chunk: ChunkInfo, key: string): Promise<void> {
        const lane = entry.tus!.lanes[chunk.lane];
        const position = await this.tusHead(entry, lane, key, 'chunk', chunk.index);

        // The server lost the upload, or data the client counted as stored
        if (position === null || position < chunk.start) {
            lane.recoveries++;
            if (lane.recoveries > TUS_MAX_RECOVERIES) {
                throw new TurboPushError('The server keeps losing the upload', {
                    code: 'server', retryable: false, chunkIndex: chunk.index
                });
            }
        }

        if (position === null) {
            lane.url = null;
            this.tusSave(entry);
            this.tusRealign(entry, chunk, lane.start);
            return;
        }

        lane.synced = true;
        this.tusRealign(entry, chunk, position);
    }

    /**
     * Sends a chunk's remaining bytes (PATCH)
     *
     * @private
     */
    private async tusPatch(entry: FileEntry, chunk: ChunkInfo, key: string): Promise<void> {
        const lane = entry.tus!.lanes[chunk.lane];
        const start = chunk.start;
        const headers: Record<string, string> = {
            'Upload-Offset': String(start - lane.start),
            'Content-Type': 'application/offset+octet-stream'
        };
        const checksum = await this.tusChecksum(chunk.blob);
        if (checksum) {
            headers['Upload-Checksum'] = checksum;
        }
        this.tusCheckActive(entry, chunk);

        try {
            const { response, body } = await this.send(entry.progress.fileId, key, 'chunk', lane.url!, {
                method: 'PATCH',
                headers: this.tusHeaders(headers),
                body: chunk.blob
            }, chunk.index, TurboPush.readText);

            if (!response.ok) {
                throw TurboPush.tusError(response, body, chunk.index, TurboPush.tusRetryable(response.status, true));
            }

            const offset = TurboPush.headerInteger(response, 'Upload-Offset');
            const position = offset === null ? -1 : lane.start + offset;
            if (position <= start || position > chunk.end) {
                throw new TurboPushError('Invalid response from tus server: unexpected Upload-Offset', {
                    code: 'invalid_response', status: response.status, retryable: true, chunkIndex: chunk.index
                });
            }
            this.tusApplyOffset(entry, chunk.lane, position, chunk);
        } catch (error) {
            // The server may hold part of the body: ask for its offset before sending more
            lane.synced = false;
            throw error;
        }
    }

    /**
     * Gets a lane's position from the server (HEAD)
     *
     * @private
     * @returns {Promise<number | null>} Position in the file up to which the
     *   server has the lane's bytes, or null if the upload no longer exists
     */
    private async tusHead(
        entry: FileEntry,
        lane: TusLane,
        key: string,
        kind: InFlightRequest['kind'],
        chunkIndex: number | undefined
    ): Promise<number | null> {
        const { response, body } = await this.send(entry.progress.fileId, key, kind, lane.url!, {
            method: 'HEAD',
            headers: this.tusHeaders({})
        }, chunkIndex, TurboPush.readText);

        const status = response.status;
        if (status === 403 || status === 404 || status === 410) {
            return null;
        }
        if (!response.ok) {
            throw TurboPush.tusError(response, body, chunkIndex, TurboPush.tusRetryable(status, false));
        }

        const length = TurboPush.headerInteger(response, 'Upload-Length');
        if (length !== null && length !== lane.end - lane.start) {
            return null; // Not the upload the client created for this range
        }
        const offset = TurboPush.headerInteger(response, 'Upload-Offset');
        if (offset === null || offset > lane.end - lane.start) {
            throw new TurboPushError('Invalid response from tus server: missing or invalid Upload-Offset', {
                code: 'invalid_response', status, retryable: true, chunkIndex
            });
        }
        return lane.start + offset;
    }

    /**
     * Applies a lane's position and makes the chunk wait if an earlier
     * chunk of the lane has to be sent again first
     *
     * @private
     */
    private tusRealign(entry: FileEntry, chunk: ChunkInfo, position: number): void {
        this.tusApplyOffset(entry, chunk.lane, position, chunk);
        if (position < chunk.origin) {
            throw new RequeueSignal('Requeue');
        }
    }

    /**
     * Brings a lane's chunks and the progress in line with the server's offset
     *
     * Chunks before the position are done, the chunk containing it continues
     * from there, and later ones are sent in full. Works in both directions,
     * so it also handles a server that lost data.
     *
     * @private
     * @param {FileEntry} entry - The file
     * @param {number} laneIndex - The lane
     * @param {number} position - Position in the file up to which the server has the lane's bytes
     * @param {ChunkInfo | null} current - The chunk whose request is running; it stays 'uploading' unless done
     */
    private tusApplyOffset(entry: FileEntry, laneIndex: number, position: number, current: ChunkInfo | null): void {
        for (const chunk of entry.chunks!) {
            if (chunk.lane !== laneIndex) {
                continue;
            }
            // Bytes of the chunk counted in the progress so far
            const counted = chunk.state === 'done' ? chunk.end - chunk.origin : chunk.start - chunk.origin;
            const done = chunk.end <= position;
            const start = done ? chunk.start : Math.max(chunk.origin, position);
            const stored = done ? chunk.end - chunk.origin : start - chunk.origin;
            if (stored !== counted) {
                this.addUploadedBytes(entry, stored - counted);
            }

            if (done) {
                chunk.state = 'done';
                continue;
            }
            if (chunk.start !== start) {
                chunk.start = start;
                chunk.blob = entry.file.slice(start, chunk.end);
            }
            if (chunk.state === 'done' || (chunk.state === 'uploading' && chunk !== current)) {
                chunk.state = 'pending';
            }
        }
    }

    /**
     * Completes a tus file: joins the partial uploads (concatenation) or,
     * for a single upload, simply reports its URL
     *
     * @private
     * @returns {Promise<UploadResult>} The upload URL, file name and size
     */
    private async tusFinalize(entry: FileEntry): Promise<UploadResult> {
        const tus = entry.tus!;
        const fileId = entry.progress.fileId;

        if (tus.parallel && tus.finalUrl === null) {
            const headers: Record<string, string> = {
                'Upload-Concat': 'final;' + tus.lanes.map(lane => lane.url).join(' ')
            };
            if (tus.metadata) {
                headers['Upload-Metadata'] = tus.metadata;
            }
            const { response, body } = await this.send(fileId, `${fileId}:finalize`, 'finalize', this.config.endpoint, {
                method: 'POST',
                headers: this.tusHeaders(headers)
            }, undefined, TurboPush.readText);

            if (!response.ok) {
                throw TurboPush.tusError(response, body, undefined, TurboPush.tusRetryable(response.status, false));
            }
            tus.finalUrl = this.tusLocation(response, undefined);
        }

        return {
            uploadUrl: (tus.parallel ? tus.finalUrl : tus.lanes[0].url) || undefined,
            fileName: entry.file.name,
            fileSize: entry.file.size
        };
    }

    /**
     * Asks the server for its offsets of a file restored from storage
     *
     * Lanes the server still has continue from their offset; lanes it no
     * longer has start again. If a request fails, the lane is checked again
     * before its next chunk.
     *
     * @private
     */
    private async tusRestore(session: Session, entry: FileEntry): Promise<void> {
        const tus = entry.tus!;
        if (!entry.restored || entry.started) {
            return;
        }
        const fileId = entry.progress.fileId;

        await Promise.all(tus.lanes.map(async (lane, laneIndex) => {
            if (lane.url === null) {
                return;
            }
            let position: number | null;
            try {
                position = await this.tusHead(entry, lane, `${fileId}:status:${laneIndex}`, 'status', undefined);
            } catch (error) {
                return;
            }
            if (session.cancelled || this.entries.get(fileId) !== entry) {
                return;
            }
            if (position === null) {
                lane.url = null;
                return;
            }
            lane.synced = true;
            this.tusApplyOffset(entry, laneIndex, position, null);
        }));

        if (session.cancelled || this.entries.get(fileId) !== entry) {
            return;
        }
        entry.started = tus.lanes.some(lane => lane.url !== null);
        this.tusSave(entry);
        this.emitProgress();
    }

    /**
     * Forgets a file's tus uploads so the next push() starts it from scratch
     *
     * @private
     */
    private tusReset(entry: FileEntry): void {
        this.addUploadedBytes(entry, -entry.progress.uploadedSize);
        this.storageRemove(entry);
        entry.tus = null;
        entry.chunks = null;
        entry.started = false;
        entry.restored = false;
    }

    /**
     * Deletes a file's tus uploads (best effort), if the server supports termination
     *
     * @private
     */
    private tusTerminate(entry: FileEntry): void {
        if (!this.tusCaps().extensions.includes('termination')) {
            return;
        }
        const tus = entry.tus!;
        const urls = tus.lanes.map(lane => lane.url).concat(tus.finalUrl);
        for (const url of urls) {
            if (url === null) {
                continue;
            }
            try {
                fetch(url, {
                    method: 'DELETE',
                    headers: this.tusHeaders({}),
                    credentials: this.config.withCredentials ? 'include' : 'omit',
                    keepalive: true
                }).catch(() => undefined);
            } catch (error) {
                // Unfinished uploads also expire on the server
            }
        }
    }

    /**
     * Saves a file's tus upload URLs in resumable mode
     * Leaves the slot alone if another upload of the same file owns it
     *
     * @private
     */
    private tusSave(entry: FileEntry): void {
        if (!this.config.resumable || !entry.tus) {
            return;
        }
        const key = this.storageKey(entry.file);
        const fileId = entry.progress.fileId;
        const owner = this.storageOwner(this.storageGet(key));
        if (owner !== null && owner !== fileId) {
            return;
        }
        if (entry.tus.lanes.every(lane => lane.url === null)) {
            this.storageRemove(entry);
            return;
        }
        const saved: SavedTusUpload = {
            v: 1,
            fileId,
            parallel: entry.tus.parallel,
            lanes: entry.tus.lanes.map(lane => ({ url: lane.url, start: lane.start, end: lane.end }))
        };
        this.storageSet(key, JSON.stringify(saved));
    }

    /**
     * Builds the Upload-Metadata header value for a file
     *
     * @private
     */
    private tusMetadata(file: File): string {
        const fields: Record<string, string> = { filename: file.name };
        if (file.type) {
            fields.filetype = file.type;
        }

        const option = this.config.tus.metadata;
        let custom: unknown = option;
        if (typeof option === 'function') {
            try {
                custom = option(file);
            } catch (error) {
                TurboPush.rethrowLater(error);
                custom = undefined;
            }
        }
        if (custom && typeof custom === 'object') {
            for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
                if (TUS_METADATA_KEY.test(key)) {
                    fields[key] = String(value);
                } else {
                    TurboPush.rethrowLater(new Error(`TurboPush: invalid tus metadata key "${key}"`));
                }
            }
        }

        return Object.entries(fields)
            .map(([key, value]) => value === '' ? key : `${key} ${TurboPush.base64Utf8(value)}`)
            .join(',');
    }

    /**
     * Computes the Upload-Checksum header for a chunk, if the server and the
     * browser both support a common algorithm
     *
     * @private
     * @returns {Promise<string | null>} The header value, or null to send no checksum
     */
    private async tusChecksum(blob: Blob): Promise<string | null> {
        const caps = this.tusCaps();
        const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
        if (!this.config.tus.checksum || !caps.extensions.includes('checksum') || !subtle) {
            return null;
        }
        const algorithm = TUS_CHECKSUMS.find(([name]) => caps.checksumAlgorithms.includes(name));
        if (!algorithm) {
            return null;
        }
        try {
            const digest = await subtle.digest(algorithm[1], await TurboPush.readBlob(blob));
            return `${algorithm[0]} ${TurboPush.base64(new Uint8Array(digest))}`;
        } catch (error) {
            return null; // Checksums are optional: send the chunk without one
        }
    }

    /**
     * Builds the headers of a tus request: the configured headers (without
     * Content-Type), Tus-Resumable and the given ones
     *
     * @private
     */
    private tusHeaders(extra: Record<string, string>, version: boolean = true): Record<string, string> {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(this.config.headers)) {
            if (name.toLowerCase() !== 'content-type') {
                headers[name] = value;
            }
        }
        if (version) {
            headers['Tus-Resumable'] = TUS_VERSION;
        }
        return Object.assign(headers, extra);
    }

    /**
     * Reads the upload URL from a creation response, resolved against the endpoint
     *
     * @private
     */
    private tusLocation(response: Response, chunkIndex: number | undefined): string {
        const location = TurboPush.header(response, 'Location');
        if (!location) {
            throw new TurboPushError(
                'The tus server did not return an upload URL (Location header). '
                + 'A server on another origin must list Location in Access-Control-Expose-Headers',
                { code: 'invalid_response', status: response.status, retryable: false, chunkIndex }
            );
        }
        try {
            const page = (globalThis as { location?: { href?: string } }).location?.href;
            const base = page ? new URL(this.config.endpoint, page).href : this.config.endpoint;
            return new URL(location, base).href;
        } catch (error) {
            return location;
        }
    }

    /**
     * Gets the chunks that may start now: per lane, the first unfinished
     * chunk, if no chunk of that lane is in flight
     *
     * @private
     */
    private static tusStartable(chunks: ChunkInfo[]): Set<number> {
        const busy = new Set<number>();
        for (const chunk of chunks) {
            if (chunk.state === 'uploading') {
                busy.add(chunk.lane);
            }
        }
        const startable = new Set<number>();
        const seen = new Set<number>();
        for (const chunk of chunks) {
            if (chunk.state === 'done' || seen.has(chunk.lane)) {
                continue;
            }
            seen.add(chunk.lane);
            if (chunk.state === 'pending' && !busy.has(chunk.lane)) {
                startable.add(chunk.index);
            }
        }
        return startable;
    }

    /**
     * Whether a tus error status is worth retrying
     * PATCH failures are also retried on 404/410 (the next attempt checks the
     * upload and recreates it if it is gone), 409 (offset mismatch, the next
     * attempt asks for the offset) and 460 (checksum mismatch)
     *
     * @private
     */
    private static tusRetryable(status: number, patch: boolean): boolean {
        if (status === 408 || status === 423 || status === 429 || status >= 500) {
            return true;
        }
        return patch && (status === 404 || status === 409 || status === 410 || status === 460);
    }

    /**
     * Builds the error for a tus error response
     * tus servers answer errors with a short text (tusd) or JSON body
     *
     * @private
     */
    private static tusError(response: Response, text: string, chunkIndex: number | undefined, retryable: boolean): TurboPushError {
        const status = response.status;
        let message = text.trim();
        if (message.charAt(0) === '{') {
            try {
                const json = JSON.parse(message);
                const value = json && (json.message ?? json.error);
                message = typeof value === 'string' ? value : '';
            } catch (error) {
                message = '';
            }
        } else if (message.charAt(0) === '<' || message.length > 300) {
            message = '';
        }
        return new TurboPushError(
            message || `HTTP ${status}${response.statusText ? ': ' + response.statusText : ''}`,
            { code: 'http', status, retryable, chunkIndex }
        );
    }

    /**
     * Creates a tus lane
     *
     * @private
     */
    private static newLane(url: string | null, start: number, end: number): TusLane {
        return { url, start, end, synced: false, recoveries: 0 };
    }

    /**
     * Parses and checks a saved tus upload
     * Returns null unless it is well formed and its lanes cover the whole file
     *
     * @private
     */
    private static parseSavedTus(value: string | null, size: number): SavedTusUpload | null {
        if (value === null) {
            return null;
        }
        let saved: any;
        try {
            saved = JSON.parse(value);
        } catch (error) {
            return null;
        }
        if (!saved || saved.v !== 1 || typeof saved.fileId !== 'string' || !UPLOAD_ID_PATTERN.test(saved.fileId)
            || typeof saved.parallel !== 'boolean' || !Array.isArray(saved.lanes)
            || saved.lanes.length < 1 || saved.lanes.length > 10 || (!saved.parallel && saved.lanes.length !== 1)) {
            return null;
        }
        let expected = 0;
        for (const lane of saved.lanes) {
            const urlValid = lane && (lane.url === null || (typeof lane.url === 'string' && /^https?:\/\//i.test(lane.url)
                && lane.url.length <= 2048));
            if (!urlValid || !Number.isSafeInteger(lane.start) || !Number.isSafeInteger(lane.end)
                || lane.start !== expected || lane.end < lane.start || (lane.end === lane.start && size > 0)) {
                return null;
            }
            expected = lane.end;
        }
        return expected === size ? saved as SavedTusUpload : null;
    }

    /**
     * Gets a response header, tolerating responses without headers
     *
     * @private
     */
    private static header(response: Response, name: string): string | null {
        const headers = response && response.headers;
        return headers && typeof headers.get === 'function' ? headers.get(name) : null;
    }

    /**
     * Gets a response header as a non-negative safe integer, or null
     *
     * @private
     */
    private static headerInteger(response: Response, name: string): number | null {
        const value = TurboPush.header(response, name);
        if (value === null || !/^\s*[0-9]{1,16}\s*$/.test(value)) {
            return null;
        }
        const number = Number(value.trim());
        return Number.isSafeInteger(number) ? number : null;
    }

    /**
     * Gets a comma-separated response header as a lowercased list
     *
     * @private
     */
    private static headerList(response: Response, name: string): string[] {
        const value = TurboPush.header(response, name);
        return value ? value.split(',').map(part => part.trim().toLowerCase()).filter(part => part !== '') : [];
    }

    /**
     * Base64-encodes a string's UTF-8 bytes
     *
     * @private
     */
    private static base64Utf8(value: string): string {
        // Replace lone surrogates, which encodeURIComponent rejects
        const wellFormed = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
        const binary = encodeURIComponent(wellFormed)
            .replace(/%([0-9A-F]{2})/g, (match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        return btoa(binary);
    }

    /**
     * Base64-encodes bytes
     *
     * @private
     */
    private static base64(bytes: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Reads a Blob into an ArrayBuffer
     *
     * @private
     */
    private static readBlob(blob: Blob): Promise<ArrayBuffer> {
        if (typeof blob.arrayBuffer === 'function') {
            return blob.arrayBuffer();
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }

    /**
     * Reads a response body as text, returning '' if it cannot be read
     *
     * @private
     */
    private static async readText(response: Response): Promise<string> {
        if (!response || typeof response.text !== 'function') {
            return '';
        }
        try {
            return await response.text();
        } catch (error) {
            return '';
        }
    }

    /**
     * Adds uploaded bytes to a file's progress and the session statistics
     *
     * @private
     */
    private addUploadedBytes(entry: FileEntry, bytes: number): void {
        const progress = entry.progress;
        progress.uploadedSize = Math.max(0, Math.min(progress.uploadedSize + bytes, entry.file.size));
        progress.percentage = entry.file.size > 0 ? (progress.uploadedSize / entry.file.size) * 100 : 0;
        this.stats.uploadedBytes += bytes;
    }

    /**
     * Updates a file's speed and remaining time (throttled to every 100ms)
     *
     * @private
     */
    private updateSpeed(entry: FileEntry): void {
        const progress = entry.progress;
        const now = Date.now();
        const timeDiff = (now - entry.lastSpeedTime) / 1000;

        if (timeDiff > 0.1) {
            const sizeDiff = progress.uploadedSize - entry.lastSpeedBytes;
            progress.speed = sizeDiff / timeDiff;
            progress.remainingTime = progress.speed > 0
                ? (entry.file.size - progress.uploadedSize) / progress.speed
                : 0;
            entry.lastSpeedTime = now;
            entry.lastSpeedBytes = progress.uploadedSize;
        }
    }

    /**
     * Notifies the progress callback
     *
     * @private
     */
    private emitProgress(): void {
        if (this.progressCallback) {
            const callback = this.progressCallback;
            TurboPush.safeCall(() => callback(this.getProgress()));
        }
    }

    /**
     * Notifies the retry callback
     *
     * @private
     */
    private emitRetry(entry: FileEntry, chunkIndex: number | null, attempt: number, delay: number, error: TurboPushError): void {
        if (this.retryCallback) {
            const callback = this.retryCallback;
            TurboPush.safeCall(() => callback({
                fileName: entry.file.name,
                fileId: entry.progress.fileId,
                chunkIndex,
                attempt,
                delay,
                error
            }));
        }
    }

    /**
     * Calculates the delay before a retry: exponential backoff with jitter
     * The delay doubles with each attempt, up to maxRetryDelay, and a random
     * part (50-100% of it) spreads out retries from many clients
     *
     * @private
     * @param {number} attempt - Retry attempt, starting at 1
     * @returns {number} Delay in milliseconds
     */
    private retryDelayFor(attempt: number): number {
        const base = Math.min(this.config.maxRetryDelay, this.config.retryDelay * Math.pow(2, attempt - 1));
        return Math.round(base / 2 + Math.random() * (base / 2));
    }

    /**
     * Splits a file into chunks for uploading
     * Creates chunk metadata including blob slices. Each range (a tus
     * upload, or the whole file) is cut into chunks of chunkSize bytes; an
     * empty range gets one empty chunk.
     *
     * @private
     * @param {File} file - File to split into chunks
     * @param {number} chunkSize - Chunk size in bytes
     * @param {Array} [ranges] - Byte ranges to split, one per lane (default: the whole file)
     * @returns {ChunkInfo[]} Array of chunk metadata
     */
    private createChunks(
        file: File,
        chunkSize: number,
        ranges: { start: number; end: number }[] = [{ start: 0, end: file.size }]
    ): ChunkInfo[] {
        const chunks: ChunkInfo[] = [];

        ranges.forEach((range, lane) => {
            let start = range.start;
            do {
                const end = Math.min(start + chunkSize, range.end);
                chunks.push({
                    index: chunks.length,
                    start,
                    end,
                    origin: start,
                    lane,
                    blob: file.slice(start, end),
                    attempts: 0,
                    state: 'pending',
                    token: 0
                });
                start = end;
            } while (start < range.end);
        });

        return chunks;
    }

    /**
     * Generates a unique identifier for a file upload session
     * Combines a shortened filename, size, timestamp and a random string,
     * using only characters the server accepts
     *
     * @private
     * @param {File} file - File to generate ID for
     * @returns {string} Unique file identifier
     */
    private generateFileId(file: File): string {
        const name = file.name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 64);
        let random = '';
        const cryptoApi = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
        if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
            const bytes = cryptoApi.getRandomValues(new Uint8Array(8)) as Uint8Array;
            random = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        } else {
            random = Math.random().toString(36).substring(2, 15);
        }
        return `${name}-${file.size}-${Date.now()}-${random}`;
    }

    /**
     * Promise-based sleep that ends early when the session is cancelled
     *
     * @private
     * @param {Session} session - The session
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>} Promise that resolves after delay
     */
    private sleep(session: Session, ms: number): Promise<void> {
        return new Promise(resolve => {
            if (session.cancelled) {
                resolve();
                return;
            }
            const sleeper = {
                timer: setTimeout(() => {
                    session.sleepers.delete(sleeper);
                    resolve();
                }, ms),
                wake: () => resolve()
            };
            session.sleepers.add(sleeper);
        });
    }

    /**
     * Gets the storage key for a file in resumable mode
     *
     * @private
     */
    private storageKey(file: File): string {
        const prefix = this.config.protocol === 'tus' ? 'turbopush:tus:' : 'turbopush:';
        return `${prefix}${this.config.endpoint}:${file.name}:${file.size}:${file.lastModified || 0}`;
    }

    /**
     * Reads a value from localStorage, if available
     *
     * @private
     */
    private storageGet(key: string): string | null {
        try {
            return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Writes a value to localStorage, if available
     *
     * @private
     */
    private storageSet(key: string, value: string): void {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(key, value);
            }
        } catch (error) {
            // Storage full or disabled: resuming after reload just won't work
        }
    }

    /**
     * Forgets a file's upload ID in resumable mode
     *
     * @private
     */
    private storageRemove(entry: FileEntry): void {
        if (!this.config.resumable) {
            return;
        }
        const key = this.storageKey(entry.file);
        try {
            if (typeof localStorage !== 'undefined' && this.storageOwner(localStorage.getItem(key)) === entry.progress.fileId) {
                localStorage.removeItem(key);
            }
        } catch (error) {
            // Ignore storage errors
        }
    }

    /**
     * Gets the upload ID a stored value belongs to
     * The TurboPush protocol stores the ID itself, tus a JSON object with it
     *
     * @private
     */
    private storageOwner(value: string | null): string | null {
        if (value === null || this.config.protocol !== 'tus') {
            return value;
        }
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed.fileId === 'string' ? parsed.fileId : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Calls a user callback without letting its exceptions break the upload
     * The exception is rethrown asynchronously so it still shows up in the console
     *
     * @private
     */
    private static safeCall(callback: () => void): void {
        try {
            callback();
        } catch (error) {
            TurboPush.rethrowLater(error);
        }
    }

    /**
     * Rethrows an error asynchronously, so it shows up in the console
     * without breaking the upload
     *
     * @private
     */
    private static rethrowLater(error: unknown): void {
        setTimeout(() => { throw error; }, 0);
    }

    /**
     * Reads a JSON response body, returning undefined if it is not JSON
     *
     * @private
     */
    private static async readJson(response: Response): Promise<unknown> {
        if (!response || typeof response.json !== 'function') {
            return undefined;
        }
        try {
            return await response.json();
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Wraps any error in a TurboPushError
     *
     * @private
     */
    private static toTurboPushError(error: unknown, chunkIndex?: number): TurboPushError {
        if (error instanceof TurboPushError) {
            return error;
        }
        return new TurboPushError((error as Error)?.message || String(error), {
            code: 'network', retryable: true, chunkIndex, cause: error
        });
    }

    /**
     * Returns a finite number, or the fallback
     *
     * @private
     */
    private static number(value: unknown, fallback: number): number {
        return typeof value === 'number' && isFinite(value) ? value : fallback;
    }

    /**
     * Returns a positive finite number, or the fallback
     *
     * @private
     */
    private static positive(value: unknown, fallback: number): number {
        const result = TurboPush.number(value, fallback);
        return result > 0 ? result : fallback;
    }

    /**
     * Creates zeroed statistics
     *
     * @private
     */
    private static emptyStats(): UploadStats {
        return {
            totalFiles: 0,
            completedFiles: 0,
            failedFiles: 0,
            totalBytes: 0,
            uploadedBytes: 0,
            startTime: Date.now()
        };
    }
}

// Export type definitions for external use
export type {
    TurboPushConfig,
    UploadProgress,
    UploadStats,
    UploadStatus,
    UploadResult,
    RetryInfo,
    TurboPushErrorCode,
    TurboPushErrorOptions,
    TurboPushProtocol,
    TusOptions
};
