/**
 * TurboPush - High-Performance Chunked File Upload Library
 *
 * @version 1.0.0
 * @license MIT
 */

interface TurboPushConfig {
    endpoint: string;
    chunkSize?: number;
    maxConcurrentUploads?: number;
    maxRetries?: number;
    retryDelay?: number;
    timeout?: number;
    headers?: Record<string, string>;
    withCredentials?: boolean;
}

interface UploadProgress {
    file: File;
    fileName: string;
    fileId: string;
    totalSize: number;
    uploadedSize: number;
    percentage: number;
    speed: number;
    remainingTime: number;
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'paused';
    error?: string;
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
    averageSpeed?: number;
}

export class TurboPush {
    private config: Required<TurboPushConfig>;
    private files: Map<string, File> = new Map();
    private fileProgress: Map<string, UploadProgress> = new Map();
    private fileChunks: Map<string, ChunkInfo[]> = new Map();
    private activeUploads: Map<string, AbortController> = new Map();
    private stats: UploadStats;
    private progressCallback?: (progress: UploadProgress[]) => void;
    private fileCompleteCallback?: (fileName: string, fileId: string) => void;
    private completeCallback?: (stats: UploadStats) => void;
    private errorCallback?: (error: Error, fileName: string, fileId: string) => void;
    private isPaused: boolean = false;

    constructor(config: TurboPushConfig) {
        if (!config.endpoint) {
            throw new Error('TurboPush: endpoint is required');
        }

        this.config = {
            endpoint: config.endpoint,
            chunkSize: config.chunkSize || 1024 * 1024,
            maxConcurrentUploads: Math.max(1, Math.min(10, config.maxConcurrentUploads || 3)),
            maxRetries: Math.max(0, config.maxRetries || 3),
            retryDelay: Math.max(100, config.retryDelay || 1000),
            timeout: Math.max(5000, config.timeout || 30000),
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

    public addFile(file: File): this {
        const fileId = this.generateFileId(file);
        this.files.set(fileId, file);

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

        this.stats.totalFiles++;
        this.stats.totalBytes += file.size;
        return this;
    }

    public addFiles(files: File[] | FileList): this {
        Array.from(files).forEach(file => this.addFile(file));
        return this;
    }

    public onProgress(callback: (progress: UploadProgress[]) => void): this {
        this.progressCallback = callback;
        return this;
    }

    public onFileComplete(callback: (fileName: string, fileId: string) => void): this {
        this.fileCompleteCallback = callback;
        return this;
    }

    public onComplete(callback: (stats: UploadStats) => void): this {
        this.completeCallback = callback;
        return this;
    }

    public onError(callback: (error: Error, fileName: string, fileId: string) => void): this {
        this.errorCallback = callback;
        return this;
    }

    public setChunkSize(bytes: number): this {
        this.config.chunkSize = Math.max(64 * 1024, bytes);
        return this;
    }

    public setMaxConcurrentUploads(count: number): this {
        this.config.maxConcurrentUploads = Math.max(1, Math.min(10, count));
        return this;
    }

    public setMaxRetries(count: number): this {
        this.config.maxRetries = Math.max(0, count);
        return this;
    }

    public async push(): Promise<UploadStats> {
        if (this.files.size === 0) {
            throw new Error('TurboPush: No files to upload');
        }

        this.stats.startTime = Date.now();
        this.isPaused = false;

        for (const [fileId, file] of this.files) {
            this.fileChunks.set(fileId, this.createChunks(file));
        }

        const uploadPromises = Array.from(this.files.keys()).map(fileId =>
            this.uploadFile(fileId)
        );

        await Promise.allSettled(uploadPromises);

        this.stats.endTime = Date.now();
        this.stats.duration = (this.stats.endTime - this.stats.startTime) / 1000;
        this.stats.averageSpeed = this.stats.totalBytes / (this.stats.duration || 1);

        if (this.completeCallback) {
            this.completeCallback(this.stats);
        }

        return this.stats;
    }

    public async upload(): Promise<UploadStats> {
        return this.push();
    }

    public pause(): void {
        this.isPaused = true;
        for (const [key, controller] of this.activeUploads) {
            controller.abort();
        }
        this.activeUploads.clear();
        for (const progress of this.fileProgress.values()) {
            if (progress.status === 'uploading') {
                progress.status = 'paused';
            }
        }
    }

    public async resume(): Promise<void> {
        this.isPaused = false;
        const filesToResume = Array.from(this.fileProgress.entries())
            .filter(([_, progress]) =>
                progress.status === 'paused' || progress.status === 'pending'
            )
            .map(([fileId, _]) => fileId);

        const uploadPromises = filesToResume.map(fileId => this.uploadFile(fileId));
        await Promise.allSettled(uploadPromises);
    }

    public cancel(): void {
        this.pause();
        this.files.clear();
        this.fileProgress.clear();
        this.fileChunks.clear();
    }

    public getStats(): UploadStats {
        return { ...this.stats };
    }

    public getProgress(): UploadProgress[] {
        return Array.from(this.fileProgress.values());
    }

    public getFileProgress(fileName: string): UploadProgress | undefined {
        for (const progress of this.fileProgress.values()) {
            if (progress.fileName === fileName) {
                return progress;
            }
        }
        return undefined;
    }

    public isPausedState(): boolean {
        return this.isPaused;
    }

    public getQueueSize(): number {
        return this.files.size;
    }

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
            await this.uploadChunksInParallel(fileId, chunks, (uploadedChunks) => {
                const uploadedSize = uploadedChunks * this.config.chunkSize;
                progress.uploadedSize = Math.min(uploadedSize, file.size);
                progress.percentage = (progress.uploadedSize / file.size) * 100;

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

                if (this.progressCallback) {
                    this.progressCallback(this.getProgress());
                }
            });

            await this.finalizeUpload(fileId, file);
            progress.status = 'completed';
            progress.percentage = 100;
            progress.uploadedSize = file.size;
            this.stats.completedFiles++;

            if (this.fileCompleteCallback) {
                this.fileCompleteCallback(file.name, fileId);
            }
        } catch (error) {
            progress.status = 'failed';
            progress.error = (error as Error).message;
            this.stats.failedFiles++;
            if (this.errorCallback) {
                this.errorCallback(error as Error, file.name, fileId);
            }
            throw error;
        }
    }

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
                // Check for completion FIRST, before checking hasError or isPaused
                // This ensures the promise resolves/rejects even when errors occur
                if (currentIndex >= pendingChunks.length && activeCount === 0) {
                    if (completedCount === chunks.length) {
                        resolve();
                    } else {
                        reject(new Error(errorMessage || 'Some chunks failed'));
                    }
                    return;
                }

                // Now check if we should stop starting new uploads
                if (this.isPaused || hasError) return;

                while (activeCount < this.config.maxConcurrentUploads &&
                       currentIndex < pendingChunks.length &&
                       !this.isPaused && !hasError) {

                    const chunk = pendingChunks[currentIndex];
                    currentIndex++;
                    activeCount++;

                    this.uploadChunk(fileId, chunk)
                        .then(() => {
                            chunk.uploaded = true;
                            completedCount++;
                            this.stats.uploadedBytes += (chunk.end - chunk.start);
                            progressCallback(completedCount);
                        })
                        .catch((error) => {
                            if (chunk.attempts < this.config.maxRetries) {
                                chunk.attempts++;
                                pendingChunks.push(chunk);
                            } else {
                                hasError = true;
                                errorMessage = `Failed chunk ${chunk.index}: ${error.message}`;
                            }
                        })
                        .finally(() => {
                            activeCount--;
                            uploadNext();
                        });
                }
            };
            uploadNext();
        });
    }

    private async uploadChunk(fileId: string, chunk: ChunkInfo): Promise<void> {
        const file = this.files.get(fileId);
        if (!file) throw new Error('TurboPush: File not found');

        if (chunk.attempts > 0) {
            await this.sleep(this.config.retryDelay * chunk.attempts);
        }

        const controller = new AbortController();
        const uploadKey = `${fileId}-${chunk.index}`;
        this.activeUploads.set(uploadKey, controller);

        try {
            const formData = new FormData();
            formData.append('file', chunk.blob);
            formData.append('fileName', file.name);
            formData.append('fileId', fileId);
            formData.append('chunkIndex', chunk.index.toString());
            formData.append('totalChunks', this.fileChunks.get(fileId)!.length.toString());
            formData.append('fileSize', file.size.toString());

            const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                body: formData,
                headers: this.config.headers,
                credentials: this.config.withCredentials ? 'include' : 'omit',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                throw new Error('Upload timeout');
            }
            throw error;
        } finally {
            this.activeUploads.delete(uploadKey);
        }
    }

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

    private generateFileId(file: File): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        return `${file.name.replace(/[^a-zA-Z0-9]/g, '_')}-${file.size}-${timestamp}-${random}`;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export type { TurboPushConfig, UploadProgress, UploadStats };