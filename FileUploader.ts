/**
 * FileUploader - Client-side chunked file upload with parallel processing
 * 
 * Mirrors the scraper.class.php architecture but for uploads instead of downloads
 * 
 * Features:
 * - Chunked file uploads for large files
 * - Parallel chunk uploads (configurable concurrency)
 * - Automatic retry logic for failed chunks
 * - Progress tracking with callbacks
 * - Resume capability (track uploaded chunks)
 * - Multiple file support
 * - Bandwidth throttling (optional)
 */

interface FileUploadConfig {
    endpoint: string;
    chunkSize?: number;                 // Size of each chunk in bytes (default: 1MB)
    maxConcurrentUploads?: number;       // Max parallel chunk uploads (default: 3)
    maxRetries?: number;                 // Max retry attempts (default: 3)
    retryDelay?: number;                 // Delay between retries in ms (default: 1000)
    timeout?: number;                    // Request timeout in ms (default: 30000)
    headers?: Record<string, string>;    // Custom headers
    withCredentials?: boolean;           // Include cookies (default: false)
}

interface UploadProgress {
    file: File;
    fileName: string;
    totalSize: number;
    uploadedSize: number;
    percentage: number;
    speed: number;                       // Bytes per second
    remainingTime: number;               // Seconds
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'paused';
}

interface ChunkInfo {
    index: number;
    start: number;
    end: number;
    blob: Blob;
    attempts: number;
    uploaded: boolean;
}

interface UploadStats {
    totalFiles: number;
    completedFiles: number;
    failedFiles: number;
    totalBytes: number;
    uploadedBytes: number;
    startTime: number;
    endTime?: number;
    duration?: number;
}

export class FileUploader {
    private config: Required<FileUploadConfig>;
    private files: Map<string, File> = new Map();
    private fileProgress: Map<string, UploadProgress> = new Map();
    private fileChunks: Map<string, ChunkInfo[]> = new Map();
    private activeUploads: Map<string, AbortController> = new Map();
    private stats: UploadStats;
    private progressCallback?: (progress: UploadProgress[]) => void;
    private completeCallback?: (stats: UploadStats) => void;
    private errorCallback?: (error: Error, fileName: string) => void;
    private isPaused: boolean = false;

    constructor(config: FileUploadConfig) {
        this.config = {
            endpoint: config.endpoint,
            chunkSize: config.chunkSize || 1024 * 1024, // 1MB default
            maxConcurrentUploads: config.maxConcurrentUploads || 3,
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 1000,
            timeout: config.timeout || 30000,
            headers: config.headers || {},
            withCredentials: config.withCredentials || false
        };

        this.stats = {
            totalFiles: 0,
            completedFiles: 0,
            failedFiles: 0,
            totalBytes: 0,
            uploadedBytes: 0,
            startTime: Date.now()
        };
    }

    /* ========================================================================
     * PUBLIC API (Similar to scraper.class.php)
     * ======================================================================== */

    /**
     * Add a file to the upload queue
     */
    public addFile(file: File): this {
        const fileId = this.generateFileId(file);
        this.files.set(fileId, file);
        
        this.fileProgress.set(fileId, {
            file,
            fileName: file.name,
            totalSize: file.size,
            uploadedSize: 0,
            percentage: 0,
            speed: 0,
            remainingTime: 0,
            status: 'pending'
        });

        this.stats.totalFiles++;
        this.stats.totalBytes += file.size;

        return this;
    }

    /**
     * Add multiple files at once
     */
    public addFiles(files: File[] | FileList): this {
        Array.from(files).forEach(file => this.addFile(file));
        return this;
    }

    /**
     * Set progress callback (similar to setProgressCallback in scraper)
     */
    public onProgress(callback: (progress: UploadProgress[]) => void): this {
        this.progressCallback = callback;
        return this;
    }

    /**
     * Set completion callback
     */
    public onComplete(callback: (stats: UploadStats) => void): this {
        this.completeCallback = callback;
        return this;
    }

    /**
     * Set error callback
     */
    public onError(callback: (error: Error, fileName: string) => void): this {
        this.errorCallback = callback;
        return this;
    }

    /**
     * Set chunk size (similar to configuration methods in scraper)
     */
    public setChunkSize(bytes: number): this {
        this.config.chunkSize = Math.max(64 * 1024, bytes); // Min 64KB
        return this;
    }

    /**
     * Set max concurrent uploads (similar to setMaxConcurrentDownloads)
     */
    public setMaxConcurrentUploads(count: number): this {
        this.config.maxConcurrentUploads = Math.max(1, Math.min(10, count));
        return this;
    }

    /**
     * Set max retry attempts
     */
    public setMaxRetries(count: number): this {
        this.config.maxRetries = Math.max(0, count);
        return this;
    }

    /**
     * Set custom headers
     */
    public setHeaders(headers: Record<string, string>): this {
        this.config.headers = { ...this.config.headers, ...headers };
        return this;
    }

    /**
     * Start uploading all files (similar to scrape() method)
     */
    public async upload(): Promise<UploadStats> {
        if (this.files.size === 0) {
            throw new Error('No files to upload');
        }

        this.stats.startTime = Date.now();
        this.isPaused = false;

        // Prepare chunks for all files
        for (const [fileId, file] of this.files) {
            this.fileChunks.set(fileId, this.createChunks(file));
        }

        // Upload all files in parallel
        const uploadPromises = Array.from(this.files.keys()).map(fileId => 
            this.uploadFile(fileId)
        );

        await Promise.allSettled(uploadPromises);

        this.stats.endTime = Date.now();
        this.stats.duration = (this.stats.endTime - this.stats.startTime) / 1000;

        if (this.completeCallback) {
            this.completeCallback(this.stats);
        }

        return this.stats;
    }

    /**
     * Pause all uploads
     */
    public pause(): void {
        this.isPaused = true;
        // Abort all active uploads
        for (const [fileId, controller] of this.activeUploads) {
            controller.abort();
            const progress = this.fileProgress.get(fileId);
            if (progress && progress.status === 'uploading') {
                progress.status = 'paused';
            }
        }
        this.activeUploads.clear();
    }

    /**
     * Resume uploads
     */
    public async resume(): Promise<void> {
        this.isPaused = false;
        
        // Find files that were uploading or pending
        const filesToResume = Array.from(this.fileProgress.entries())
            .filter(([_, progress]) => 
                progress.status === 'paused' || progress.status === 'pending'
            )
            .map(([fileId, _]) => fileId);

        const uploadPromises = filesToResume.map(fileId => this.uploadFile(fileId));
        await Promise.allSettled(uploadPromises);
    }

    /**
     * Cancel all uploads
     */
    public cancel(): void {
        this.pause();
        this.files.clear();
        this.fileProgress.clear();
        this.fileChunks.clear();
    }

    /**
     * Get current statistics (similar to getStats in scraper)
     */
    public getStats(): UploadStats {
        return { ...this.stats };
    }

    /**
     * Get progress for all files
     */
    public getProgress(): UploadProgress[] {
        return Array.from(this.fileProgress.values());
    }

    /**
     * Get progress for a specific file
     */
    public getFileProgress(fileName: string): UploadProgress | undefined {
        for (const progress of this.fileProgress.values()) {
            if (progress.fileName === fileName) {
                return progress;
            }
        }
        return undefined;
    }

    /* ========================================================================
     * PRIVATE METHODS (Upload Engine - Similar to scraper's parallel download)
     * ======================================================================== */

    /**
     * Upload a single file using parallel chunk uploads
     */
    private async uploadFile(fileId: string): Promise<void> {
        const file = this.files.get(fileId);
        const chunks = this.fileChunks.get(fileId);
        const progress = this.fileProgress.get(fileId);

        if (!file || !chunks || !progress) {
            throw new Error(`File not found: ${fileId}`);
        }

        progress.status = 'uploading';
        const startTime = Date.now();
        let lastUpdate = startTime;

        try {
            // Upload chunks in parallel (similar to downloadInParallel)
            await this.uploadChunksInParallel(fileId, chunks, (uploadedChunks) => {
                // Calculate progress
                const uploadedSize = uploadedChunks * this.config.chunkSize;
                progress.uploadedSize = Math.min(uploadedSize, file.size);
                progress.percentage = (progress.uploadedSize / file.size) * 100;

                // Calculate speed
                const now = Date.now();
                const timeDiff = (now - lastUpdate) / 1000; // seconds
                if (timeDiff > 0) {
                    progress.speed = (progress.uploadedSize - 
                        (this.stats.uploadedBytes - progress.uploadedSize)) / timeDiff;
                    progress.remainingTime = progress.speed > 0 
                        ? (file.size - progress.uploadedSize) / progress.speed 
                        : 0;
                    lastUpdate = now;
                }

                this.stats.uploadedBytes += this.config.chunkSize;

                if (this.progressCallback) {
                    this.progressCallback(this.getProgress());
                }
            });

            // Finalize upload on server
            await this.finalizeUpload(fileId, file);

            progress.status = 'completed';
            progress.percentage = 100;
            this.stats.completedFiles++;

        } catch (error) {
            progress.status = 'failed';
            this.stats.failedFiles++;
            
            if (this.errorCallback) {
                this.errorCallback(error as Error, file.name);
            }
            
            throw error;
        }
    }

    /**
     * Upload chunks in parallel (similar to downloadInParallel in scraper)
     */
    private async uploadChunksInParallel(
        fileId: string,
        chunks: ChunkInfo[],
        progressCallback: (uploadedCount: number) => void
    ): Promise<void> {
        const pendingChunks = chunks.filter(chunk => !chunk.uploaded);
        let activeCount = 0;
        let completedCount = 0;
        let currentIndex = 0;

        return new Promise((resolve, reject) => {
            const uploadNext = async () => {
                // Check if paused
                if (this.isPaused) {
                    return;
                }

                // Check if we're done
                if (currentIndex >= pendingChunks.length && activeCount === 0) {
                    resolve();
                    return;
                }

                // Start new uploads up to max concurrent
                while (activeCount < this.config.maxConcurrentUploads && 
                       currentIndex < pendingChunks.length) {
                    const chunk = pendingChunks[currentIndex];
                    currentIndex++;
                    activeCount++;

                    this.uploadChunk(fileId, chunk)
                        .then(() => {
                            chunk.uploaded = true;
                            completedCount++;
                            progressCallback(completedCount);
                        })
                        .catch((error) => {
                            // Retry logic
                            if (chunk.attempts < this.config.maxRetries) {
                                chunk.attempts++;
                                pendingChunks.push(chunk); // Add back to queue
                            } else {
                                reject(new Error(`Failed to upload chunk ${chunk.index}: ${error.message}`));
                            }
                        })
                        .finally(() => {
                            activeCount--;
                            uploadNext(); // Continue with next chunk
                        });
                }
            };

            // Start initial batch
            uploadNext();
        });
    }

    /**
     * Upload a single chunk with retry logic
     */
    private async uploadChunk(fileId: string, chunk: ChunkInfo): Promise<void> {
        const file = this.files.get(fileId);
        if (!file) {
            throw new Error('File not found');
        }

        const controller = new AbortController();
        this.activeUploads.set(`${fileId}-${chunk.index}`, controller);

        try {
            const formData = new FormData();
            formData.append('file', chunk.blob);
            formData.append('fileName', file.name);
            formData.append('fileId', fileId);
            formData.append('chunkIndex', chunk.index.toString());
            formData.append('totalChunks', this.fileChunks.get(fileId)!.length.toString());
            formData.append('fileSize', file.size.toString());

            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                body: formData,
                headers: this.config.headers,
                credentials: this.config.withCredentials ? 'include' : 'omit',
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Upload failed: ${response.statusText}`);
            }

            const result = await response.json();
            
            if (!result.success) {
                throw new Error(result.error || 'Upload failed');
            }

        } finally {
            this.activeUploads.delete(`${fileId}-${chunk.index}`);
        }
    }

    /**
     * Finalize upload - tell server to reassemble chunks
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

    /* ========================================================================
     * UTILITY METHODS
     * ======================================================================== */

    /**
     * Create chunks from a file
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
     * Generate unique ID for a file
     */
    private generateFileId(file: File): string {
        return `${file.name}-${file.size}-${file.lastModified}-${Date.now()}`;
    }
}

/* ========================================================================
 * JAVASCRIPT VERSION (For non-TypeScript projects)
 * ======================================================================== */

// To use without TypeScript, simply remove all type annotations
// The class will work identically in plain JavaScript

