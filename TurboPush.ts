/**
 * TurboPush - Chunked File Upload Library
 *
 * Splits files into chunks and uploads them in parallel, with retries and
 * exponential backoff, pause/resume/cancel, progress events and optional
 * resuming across page reloads. Designed for uploading large files
 * efficiently and reliably.
 *
 * @module TurboPush
 * @version 1.1.0
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
}

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
 * @since 1.1.0
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

    /** Starting byte position in the file */
    start: number;

    /** Ending byte position in the file (exclusive) */
    end: number;

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
 * Thrown internally when a chunk request was aborted by pause()
 * @private
 */
class PausedSignal extends Error {}

/** Upload IDs the server accepts */
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

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
    private config: Required<TurboPushConfig>;

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
     * @throws {Error} If endpoint is not provided
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
            resumable: config.resumable || false
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

        // In resumable mode, reuse the ID of an earlier, unfinished upload of this file
        if (this.config.resumable) {
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
     * unfinished files, removes all queued files and resets the statistics.
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
                if (entry.started || entry.restored) {
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
                entry.chunks = this.createChunks(entry.file, entry.chunkSize);
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
            for (const chunk of entry.chunks) {
                // A callback run by startChunk() may have paused or cancelled
                if (session.cancelled || this.isPaused || this.session !== session) {
                    return;
                }
                if (session.activeChunks >= this.config.maxConcurrentUploads) {
                    return;
                }
                if (chunk.state === 'pending') {
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
        // session ended: send again later
        if (this.session !== session || error instanceof PausedSignal || entry.progress.status === 'failed') {
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
            let body: unknown;
            try {
                response = await fetch(this.config.endpoint, {
                    ...init,
                    credentials: this.config.withCredentials ? 'include' : 'omit',
                    signal: controller.signal
                });
                body = await TurboPush.readJson(response);
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
     * Creates chunk metadata including blob slices. An empty file gets
     * one empty chunk.
     *
     * @private
     * @param {File} file - File to split into chunks
     * @param {number} chunkSize - Chunk size in bytes
     * @returns {ChunkInfo[]} Array of chunk metadata
     */
    private createChunks(file: File, chunkSize: number): ChunkInfo[] {
        const chunks: ChunkInfo[] = [];
        const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);

            chunks.push({
                index: i,
                start,
                end,
                blob: file.slice(start, end),
                attempts: 0,
                state: 'pending',
                token: 0
            });
        }
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
        return `turbopush:${this.config.endpoint}:${file.name}:${file.size}:${file.lastModified || 0}`;
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
            if (typeof localStorage !== 'undefined' && localStorage.getItem(key) === entry.progress.fileId) {
                localStorage.removeItem(key);
            }
        } catch (error) {
            // Ignore storage errors
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
            setTimeout(() => { throw error; }, 0);
        }
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
    TurboPushErrorOptions
};
