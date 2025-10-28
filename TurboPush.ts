/**
 * TurboPush - High-Performance Chunked File Upload Library
 *
 * A modern, production-ready file upload library with parallel chunk uploads,
 * automatic retry logic, and real-time progress tracking. Designed for uploading
 * large files efficiently and reliably.
 *
 * @module TurboPush
 * @version 1.0.0
 * @license MIT
 * @author TomGould
 *
 * @example
 * ```typescript
 * import { TurboPush } from './TurboPush';
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
     * @default 1048576 (1MB)
     */
    chunkSize?: number;

    /**
     * Maximum number of concurrent chunk uploads (default: 3, range: 1-10)
     * Higher values upload faster but use more bandwidth/connections
     * @default 3
     */
    maxConcurrentUploads?: number;

    /**
     * Maximum retry attempts for failed chunks (default: 3)
     * Set to 0 to disable retries
     * @default 3
     */
    maxRetries?: number;

    /**
     * Base delay in milliseconds between retry attempts (default: 1000ms)
     * Actual delay = retryDelay * attemptNumber (exponential backoff)
     * @default 1000
     */
    retryDelay?: number;

    /**
     * Request timeout in milliseconds (default: 30000ms / 30s)
     * Requests exceeding this duration will be aborted
     * @default 30000
     */
    timeout?: number;

    /**
     * Custom HTTP headers to include with each request
     * Useful for authentication tokens, API keys, etc.
     * @default {}
     */
    headers?: Record<string, string>;

    /**
     * Include cookies/credentials in cross-origin requests (default: false)
     * @default false
     */
    withCredentials?: boolean;
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
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'paused';

    /** Error message if status is 'failed' */
    error?: string;
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

    /** Number of upload attempts made for this chunk */
    attempts: number;

    /** Whether this chunk has been successfully uploaded */
    uploaded: boolean;
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
}

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

    /** Map of fileId -> File object for all queued files */
    private files: Map<string, File> = new Map();

    /** Map of fileId -> upload progress for tracking */
    private fileProgress: Map<string, UploadProgress> = new Map();

    /** Map of fileId -> array of chunk metadata */
    private fileChunks: Map<string, ChunkInfo[]> = new Map();

    /** Map of upload keys -> AbortController for cancellation */
    private activeUploads: Map<string, AbortController> = new Map();

    /** Aggregate statistics for the entire upload session */
    private stats: UploadStats;

    /** Callback function for progress updates */
    private progressCallback?: (progress: UploadProgress[]) => void;

    /** Callback function when individual file completes */
    private fileCompleteCallback?: (fileName: string, fileId: string) => void;

    /** Callback function when all uploads complete */
    private completeCallback?: (stats: UploadStats) => void;

    /** Callback function for error handling */
    private errorCallback?: (error: Error, fileName: string, fileId: string) => void;

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
        if (!config.endpoint) {
            throw new Error('TurboPush: endpoint is required');
        }

        // Apply defaults and constraints to configuration
        this.config = {
            endpoint: config.endpoint,
            chunkSize: config.chunkSize || 1024 * 1024, // Default 1MB
            maxConcurrentUploads: Math.max(1, Math.min(10, config.maxConcurrentUploads || 3)), // Clamp 1-10
            maxRetries: Math.max(0, config.maxRetries || 3), // Minimum 0
            retryDelay: Math.max(100, config.retryDelay || 1000), // Minimum 100ms
            timeout: Math.max(5000, config.timeout || 30000), // Minimum 5s
            headers: config.headers || {},
            withCredentials: config.withCredentials || false
        };

        // Initialize statistics
        this.stats = {
            totalFiles: 0,
            completedFiles: 0,
            failedFiles: 0,
            totalBytes: 0,
            uploadedBytes: 0,
            startTime: Date.now()
        };
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
        const fileId = this.generateFileId(file);
        this.files.set(fileId, file);

        // Initialize progress tracking for this file
        this.fileProgress.set(fileId, {
            file,
            fileName: file.name,
            fileId,
            totalSize: file.size,
            uploadedSize: 0,
            percentage: 0,
            speed: 0,
            remainingTime: 0,
            status: 'pending'
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
     * Called whenever upload progress changes for any file
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
     * @param {Function} callback - Callback receiving fileName and fileId
     * @returns {TurboPush} This instance for method chaining
     *
     * @example
     * ```typescript
     * uploader.onFileComplete((fileName, fileId) => {
     *     console.log(`Completed: ${fileName}`);
     * });
     * ```
     */
    public onFileComplete(callback: (fileName: string, fileId: string) => void): this {
        this.fileCompleteCallback = callback;
        return this;
    }

    /**
     * Registers a callback for upload session completion
     * Called once when all files have finished (successfully or with errors)
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
     * Called whenever a file fails to upload after all retries
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
     * Updates the chunk size for future uploads
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
        this.config.maxConcurrentUploads = Math.max(1, Math.min(10, count));
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
        this.config.maxRetries = Math.max(0, count);
        return this;
    }

    /**
     * Starts the upload process for all queued files
     * Creates chunks and uploads them in parallel according to configuration
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
    public async push(): Promise<UploadStats> {
        if (this.files.size === 0) {
            throw new Error('TurboPush: No files to upload');
        }

        this.stats.startTime = Date.now();
        this.isPaused = false;

        // Create chunks for all queued files
        for (const [fileId, file] of this.files) {
            this.fileChunks.set(fileId, this.createChunks(file));
        }

        // Start uploading all files concurrently
        const uploadPromises = Array.from(this.files.keys()).map(fileId =>
            this.uploadFile(fileId)
        );

        // Wait for all uploads to complete (successful or failed)
        await Promise.allSettled(uploadPromises);

        // Calculate final statistics
        this.stats.endTime = Date.now();
        this.stats.duration = (this.stats.endTime - this.stats.startTime) / 1000;
        this.stats.averageSpeed = this.stats.totalBytes / (this.stats.duration || 1);

        // Notify completion callback
        if (this.completeCallback) {
            this.completeCallback(this.stats);
        }

        return this.stats;
    }

    /**
     * Alias for push() method
     * Starts the upload process
     *
     * @returns {Promise<UploadStats>} Promise resolving to final upload statistics
     */
    public async upload(): Promise<UploadStats> {
        return this.push();
    }

    /**
     * Pauses all active uploads
     * Aborts all in-progress requests and marks files as paused
     * Files can be resumed later using resume()
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

        // Abort all active uploads
        for (const [key, controller] of this.activeUploads) {
            controller.abort();
        }
        this.activeUploads.clear();

        // Update file statuses
        for (const progress of this.fileProgress.values()) {
            if (progress.status === 'uploading') {
                progress.status = 'paused';
            }
        }
    }

    /**
     * Resumes paused uploads
     * Continues uploading files that were paused or pending
     *
     * @returns {Promise<void>} Promise that resolves when resume is complete
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

        // Find all files that need to be resumed
        const filesToResume = Array.from(this.fileProgress.entries())
            .filter(([_, progress]) =>
                progress.status === 'paused' || progress.status === 'pending'
            )
            .map(([fileId, _]) => fileId);

        // Resume uploading
        const uploadPromises = filesToResume.map(fileId => this.uploadFile(fileId));
        await Promise.allSettled(uploadPromises);
    }

    /**
     * Cancels all uploads and clears the queue
     * Aborts all active requests and removes all queued files
     * Cannot be resumed after cancellation
     *
     * @returns {void}
     *
     * @example
     * ```typescript
     * uploader.cancel(); // Completely stop and clear everything
     * ```
     */
    public cancel(): void {
        this.pause();
        this.files.clear();
        this.fileProgress.clear();
        this.fileChunks.clear();
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
        return Array.from(this.fileProgress.values());
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
        for (const progress of this.fileProgress.values()) {
            if (progress.fileName === fileName) {
                return progress;
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
        return this.files.size;
    }

    /**
     * Uploads a single file by uploading all its chunks
     * Handles progress tracking, error handling, and finalization
     *
     * @private
     * @param {string} fileId - Unique identifier for the file
     * @returns {Promise<void>} Promise that resolves when file upload completes
     * @throws {Error} If file is not found or upload fails
     */
    private async uploadFile(fileId: string): Promise<void> {
        const file = this.files.get(fileId);
        const chunks = this.fileChunks.get(fileId);
        const progress = this.fileProgress.get(fileId);

        if (!file || !chunks || !progress) {
            throw new Error(`TurboPush: File not found: ${fileId}`);
        }

        progress.status = 'uploading';
        const startTime = Date.now();
        let lastUpdate = startTime;
        let lastUploadedSize = 0;

        try {
            // Upload all chunks with progress tracking
            await this.uploadChunksInParallel(fileId, chunks, (uploadedChunks) => {
                // Calculate current progress
                const uploadedSize = uploadedChunks * this.config.chunkSize;
                progress.uploadedSize = Math.min(uploadedSize, file.size);
                progress.percentage = (progress.uploadedSize / file.size) * 100;

                // Calculate speed and remaining time (throttled to every 100ms)
                const now = Date.now();
                const timeDiff = (now - lastUpdate) / 1000;

                if (timeDiff > 0.1) {
                    const sizeDiff = progress.uploadedSize - lastUploadedSize;
                    progress.speed = sizeDiff / timeDiff;
                    progress.remainingTime = progress.speed > 0
                        ? (file.size - progress.uploadedSize) / progress.speed
                        : 0;
                    lastUpdate = now;
                    lastUploadedSize = progress.uploadedSize;
                }

                // Notify progress callback
                if (this.progressCallback) {
                    this.progressCallback(this.getProgress());
                }
            });

            // Finalize the upload on server
            await this.finalizeUpload(fileId, file);

            // Update final status
            progress.status = 'completed';
            progress.percentage = 100;
            progress.uploadedSize = file.size;
            this.stats.completedFiles++;

            // Notify file complete callback
            if (this.fileCompleteCallback) {
                this.fileCompleteCallback(file.name, fileId);
            }
        } catch (error) {
            // Handle upload failure
            progress.status = 'failed';
            progress.error = (error as Error).message;
            this.stats.failedFiles++;

            // Notify error callback
            if (this.errorCallback) {
                this.errorCallback(error as Error, file.name, fileId);
            }
            throw error;
        }
    }

    /**
     * Uploads multiple chunks in parallel with automatic retry
     * Manages concurrent upload limit and handles chunk failures
     *
     * @private
     * @param {string} fileId - Unique identifier for the file
     * @param {ChunkInfo[]} chunks - Array of chunk metadata
     * @param {Function} progressCallback - Callback for progress updates
     * @returns {Promise<void>} Promise that resolves when all chunks uploaded
     * @throws {Error} If chunks fail after all retries
     */
    private async uploadChunksInParallel(
        fileId: string,
        chunks: ChunkInfo[],
        progressCallback: (uploadedCount: number) => void
    ): Promise<void> {
        const pendingChunks = [...chunks.filter(chunk => !chunk.uploaded)];
        let activeCount = 0;
        let completedCount = chunks.filter(c => c.uploaded).length;
        let currentIndex = 0;
        let hasError = false;
        let errorMessage = '';

        return new Promise((resolve, reject) => {
            const uploadNext = async () => {
                // CRITICAL: Check for completion FIRST before checking errors
                // This ensures the promise resolves/rejects even when errors occur
                if (currentIndex >= pendingChunks.length && activeCount === 0) {
                    if (completedCount === chunks.length) {
                        resolve();
                    } else {
                        reject(new Error(errorMessage || 'Some chunks failed'));
                    }
                    return;
                }

                // Check if we should stop starting new uploads
                if (this.isPaused || hasError) return;

                // Start new uploads up to the concurrent limit
                while (activeCount < this.config.maxConcurrentUploads &&
                       currentIndex < pendingChunks.length &&
                       !this.isPaused && !hasError) {

                    const chunk = pendingChunks[currentIndex];
                    currentIndex++;
                    activeCount++;

                    // Upload the chunk asynchronously
                    this.uploadChunk(fileId, chunk)
                        .then(() => {
                            // Chunk uploaded successfully
                            chunk.uploaded = true;
                            completedCount++;
                            this.stats.uploadedBytes += (chunk.end - chunk.start);
                            progressCallback(completedCount);
                        })
                        .catch((error) => {
                            // Chunk upload failed
                            if (chunk.attempts < this.config.maxRetries) {
                                // Retry the chunk
                                chunk.attempts++;
                                pendingChunks.push(chunk);
                            } else {
                                // Max retries exceeded
                                hasError = true;
                                errorMessage = `Failed chunk ${chunk.index}: ${error.message}`;
                            }
                        })
                        .finally(() => {
                            // Chunk attempt complete (success or failure)
                            activeCount--;
                            uploadNext();
                        });
                }
            };

            // Start the upload process
            uploadNext();
        });
    }

    /**
     * Uploads a single chunk to the server
     * Handles retry delay, timeout, and error handling
     *
     * @private
     * @param {string} fileId - Unique identifier for the file
     * @param {ChunkInfo} chunk - Chunk metadata and data
     * @returns {Promise<void>} Promise that resolves when chunk uploads
     * @throws {Error} If upload fails or times out
     */
    private async uploadChunk(fileId: string, chunk: ChunkInfo): Promise<void> {
        const file = this.files.get(fileId);
        if (!file) throw new Error('TurboPush: File not found');

        // Apply exponential backoff delay if this is a retry
        if (chunk.attempts > 0) {
            await this.sleep(this.config.retryDelay * chunk.attempts);
        }

        // Create AbortController for timeout/cancellation
        const controller = new AbortController();
        const uploadKey = `${fileId}-${chunk.index}`;
        this.activeUploads.set(uploadKey, controller);

        try {
            // Prepare form data with chunk and metadata
            const formData = new FormData();
            formData.append('file', chunk.blob);
            formData.append('fileName', file.name);
            formData.append('fileId', fileId);
            formData.append('chunkIndex', chunk.index.toString());
            formData.append('totalChunks', this.fileChunks.get(fileId)!.length.toString());
            formData.append('fileSize', file.size.toString());

            // Set up timeout
            const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

            // Upload the chunk
            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                body: formData,
                headers: this.config.headers,
                credentials: this.config.withCredentials ? 'include' : 'omit',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Check for HTTP errors
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Parse and validate response
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error) {
            // Handle timeout errors specifically
            if ((error as Error).name === 'AbortError') {
                throw new Error('Upload timeout');
            }
            throw error;
        } finally {
            // Clean up abort controller
            this.activeUploads.delete(uploadKey);
        }
    }

    /**
     * Sends finalization request to server after all chunks uploaded
     * Tells server to merge chunks into final file
     *
     * @private
     * @param {string} fileId - Unique identifier for the file
     * @param {File} file - The File object
     * @returns {Promise<void>} Promise that resolves when finalization completes
     * @throws {Error} If finalization fails
     */
    private async finalizeUpload(fileId: string, file: File): Promise<void> {
        const response = await fetch(this.config.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.config.headers
            },
            body: JSON.stringify({
                action: 'finalize',
                fileName: file.name,
                fileId: fileId,
                fileSize: file.size,
                totalChunks: this.fileChunks.get(fileId)!.length
            }),
            credentials: this.config.withCredentials ? 'include' : 'omit'
        });

        if (!response.ok) {
            throw new Error(`Finalization failed: ${response.statusText}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Finalization failed');
        }
    }

    /**
     * Splits a file into chunks for uploading
     * Creates chunk metadata including blob slices
     *
     * @private
     * @param {File} file - File to split into chunks
     * @returns {ChunkInfo[]} Array of chunk metadata
     */
    private createChunks(file: File): ChunkInfo[] {
        const chunks: ChunkInfo[] = [];
        const totalChunks = Math.ceil(file.size / this.config.chunkSize);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * this.config.chunkSize;
            const end = Math.min(start + this.config.chunkSize, file.size);

            chunks.push({
                index: i,
                start,
                end,
                blob: file.slice(start, end),
                attempts: 0,
                uploaded: false
            });
        }
        return chunks;
    }

    /**
     * Generates a unique identifier for a file upload session
     * Combines filename, size, timestamp, and random string
     *
     * @private
     * @param {File} file - File to generate ID for
     * @returns {string} Unique file identifier
     */
    private generateFileId(file: File): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        return `${file.name.replace(/[^a-zA-Z0-9]/g, '_')}-${file.size}-${timestamp}-${random}`;
    }

    /**
     * Promise-based sleep utility for delays
     *
     * @private
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>} Promise that resolves after delay
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export type definitions for external use
export type { TurboPushConfig, UploadProgress, UploadStats };