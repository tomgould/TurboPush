/**
 * TurboPush - High-Performance Chunked File Upload Library
 * Compiled from TypeScript for browser compatibility
 */
export class TurboPush {
    constructor(config) {
        this.files = new Map();
        this.fileProgress = new Map();
        this.fileChunks = new Map();
        this.activeUploads = new Map();
        this.isPaused = false;

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

    addFile(file) {
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

    addFiles(files) {
        Array.from(files).forEach(file => this.addFile(file));
        return this;
    }

    onProgress(callback) {
        this.progressCallback = callback;
        return this;
    }

    onFileComplete(callback) {
        this.fileCompleteCallback = callback;
        return this;
    }

    onComplete(callback) {
        this.completeCallback = callback;
        return this;
    }

    onError(callback) {
        this.errorCallback = callback;
        return this;
    }

    setChunkSize(bytes) {
        this.config.chunkSize = Math.max(64 * 1024, bytes);
        return this;
    }

    setMaxConcurrentUploads(count) {
        this.config.maxConcurrentUploads = Math.max(1, Math.min(10, count));
        return this;
    }

    setMaxRetries(count) {
        this.config.maxRetries = Math.max(0, count);
        return this;
    }

    async push() {
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

    async upload() {
        return this.push();
    }

    pause() {
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

    async resume() {
        this.isPaused = false;

        const filesToResume = Array.from(this.fileProgress.entries())
            .filter(([_, progress]) =>
                progress.status === 'paused' || progress.status === 'pending'
            )
            .map(([fileId, _]) => fileId);

        const uploadPromises = filesToResume.map(fileId => this.uploadFile(fileId));
        await Promise.allSettled(uploadPromises);
    }

    cancel() {
        this.pause();
        this.files.clear();
        this.fileProgress.clear();
        this.fileChunks.clear();
    }

    getStats() {
        return { ...this.stats };
    }

    getProgress() {
        return Array.from(this.fileProgress.values());
    }

    getFileProgress(fileName) {
        for (const progress of this.fileProgress.values()) {
            if (progress.fileName === fileName) {
                return progress;
            }
        }
        return undefined;
    }

    isPausedState() {
        return this.isPaused;
    }

    getQueueSize() {
        return this.files.size;
    }

    async uploadFile(fileId) {
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
            progress.error = error.message;
            this.stats.failedFiles++;

            if (this.errorCallback) {
                this.errorCallback(error, file.name, fileId);
            }
            throw error;
        }
    }

    async uploadChunksInParallel(fileId, chunks, progressCallback) {
        const pendingChunks = [...chunks.filter(chunk => !chunk.uploaded)];
        let activeCount = 0;
        let completedCount = chunks.filter(c => c.uploaded).length;
        let currentIndex = 0;
        let hasError = false;
        let errorMessage = '';

        return new Promise((resolve, reject) => {
            const uploadNext = async () => {
                if (currentIndex >= pendingChunks.length && activeCount === 0) {
                    if (completedCount === chunks.length) {
                        resolve();
                    } else {
                        reject(new Error(errorMessage || 'Some chunks failed'));
                    }
                    return;
                }

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

    async uploadChunk(fileId, chunk) {
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
            formData.append('totalChunks', this.fileChunks.get(fileId).length.toString());
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
            if (error.name === 'AbortError') {
                throw new Error('Upload timeout');
            }
            throw error;
        } finally {
            this.activeUploads.delete(uploadKey);
        }
    }

    async finalizeUpload(fileId, file) {
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
                totalChunks: this.fileChunks.get(fileId).length
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

    createChunks(file) {
        const chunks = [];
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

    generateFileId(file) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        return `${file.name.replace(/[^a-zA-Z0-9]/g, '_')}-${file.size}-${timestamp}-${random}`;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

