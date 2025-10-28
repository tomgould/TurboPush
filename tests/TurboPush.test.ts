/**
 * Unit Tests for TurboPush
 */

import { TurboPush } from '../TurboPush';
import type { TurboPushConfig, UploadProgress, UploadStats } from '../TurboPush';

global.fetch = jest.fn();

describe('TurboPush', () => {
    let turbopush: TurboPush;
    let mockFile: File;

    beforeEach(() => {
        jest.clearAllMocks();
        const content = 'test content that has some length';
        const blob = new Blob([content], { type: 'text/plain' });
        mockFile = new File([blob], 'test.txt', { type: 'text/plain' });

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({ success: true })
        });
    });

    describe('Constructor', () => {
        test('should create instance with valid config', () => {
            turbopush = new TurboPush({ endpoint: '/upload' });
            expect(turbopush).toBeInstanceOf(TurboPush);
        });

        test('should throw error without endpoint', () => {
            expect(() => {
                new TurboPush({} as TurboPushConfig);
            }).toThrow('TurboPush: endpoint is required');
        });

        test('should apply default configuration', () => {
            turbopush = new TurboPush({ endpoint: '/upload' });
            const stats = turbopush.getStats();
            expect(stats.totalFiles).toBe(0);
        });
    });

    describe('File Management', () => {
        beforeEach(() => {
            turbopush = new TurboPush({ endpoint: '/upload' });
        });

        test('should add single file', () => {
            turbopush.addFile(mockFile);
            const stats = turbopush.getStats();
            expect(stats.totalFiles).toBe(1);
            expect(stats.totalBytes).toBe(mockFile.size);
        });

        test('should add multiple files', () => {
            const file2 = new File([new Blob(['content2'])], 'test2.txt');
            const file3 = new File([new Blob(['content3'])], 'test3.txt');

            turbopush.addFiles([mockFile, file2, file3]);
            expect(turbopush.getStats().totalFiles).toBe(3);
        });

        test('should track progress for added files', () => {
            turbopush.addFile(mockFile);
            const progress = turbopush.getProgress();
            expect(progress).toHaveLength(1);
            expect(progress[0].fileName).toBe('test.txt');
            expect(progress[0].status).toBe('pending');
        });

        test('should generate unique file IDs', () => {
            turbopush.addFile(mockFile);
            turbopush.addFile(mockFile);
            const progress = turbopush.getProgress();
            expect(progress[0].fileId).not.toBe(progress[1].fileId);
        });

        test('should chain method calls', () => {
            const result = turbopush
                .addFile(mockFile)
                .setChunkSize(512 * 1024)
                .setMaxRetries(5);
            expect(result).toBe(turbopush);
        });
    });

    describe('Callbacks', () => {
        beforeEach(() => {
            turbopush = new TurboPush({ endpoint: '/upload' });
        });

        test('should register progress callback', () => {
            const callback = jest.fn();
            turbopush.onProgress(callback);
            expect(callback).not.toHaveBeenCalled();
        });

        test('should register complete callback', () => {
            const callback = jest.fn();
            turbopush.onComplete(callback);
            expect(callback).not.toHaveBeenCalled();
        });

        test('should chain callback registrations', () => {
            const result = turbopush
                .onProgress(jest.fn())
                .onComplete(jest.fn())
                .onError(jest.fn());
            expect(result).toBe(turbopush);
        });
    });

    describe('Upload Process', () => {
        beforeEach(() => {
            turbopush = new TurboPush({
                endpoint: '/upload',
                chunkSize: 100
            });
        });

        test('should throw error when pushing without files', async () => {
            await expect(turbopush.push()).rejects.toThrow('No files to upload');
        });

        test('should call complete callback after upload', async () => {
            const completeCallback = jest.fn();
            turbopush.addFile(mockFile).onComplete(completeCallback);
            await turbopush.push();
            expect(completeCallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    totalFiles: 1,
                    completedFiles: 1
                })
            );
        });

        test('should update statistics after upload', async () => {
            turbopush.addFile(mockFile);
            await turbopush.push();
            const stats = turbopush.getStats();
            expect(stats.completedFiles).toBe(1);
            expect(stats.duration).toBeDefined();
        });
    });

    describe('Error Handling', () => {
        beforeEach(() => {
            turbopush = new TurboPush({
                endpoint: '/upload',
                chunkSize: 100,
                maxRetries: 1,  // Reduced retries for faster tests
                retryDelay: 10   // Shorter delay
            });
        });

        test('should handle network errors', async () => {
            (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));
            const errorCallback = jest.fn();
            turbopush.addFile(mockFile).onError(errorCallback);

            await turbopush.push();

            expect(errorCallback).toHaveBeenCalled();
            const stats = turbopush.getStats();
            expect(stats.failedFiles).toBe(1);
        }, 10000); // 10 second timeout for this test

        test('should handle HTTP errors', async () => {
            (global.fetch as jest.Mock).mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error'
            });
            const errorCallback = jest.fn();
            turbopush.addFile(mockFile).onError(errorCallback);

            await turbopush.push();

            expect(errorCallback).toHaveBeenCalled();
            const stats = turbopush.getStats();
            expect(stats.failedFiles).toBe(1);
        }, 10000); // 10 second timeout for this test
    });

    describe('Pause and Resume', () => {
        beforeEach(() => {
            turbopush = new TurboPush({
                endpoint: '/upload',
                chunkSize: 100
            });
        });

        test('should pause uploads', () => {
            turbopush.addFile(mockFile);
            turbopush.pause();
            expect(turbopush.isPausedState()).toBe(true);
        });

        test('should cancel all uploads', () => {
            turbopush.addFile(mockFile);
            turbopush.cancel();
            expect(turbopush.getQueueSize()).toBe(0);
        });
    });

    describe('Progress Tracking', () => {
        beforeEach(() => {
            turbopush = new TurboPush({ endpoint: '/upload' });
        });

        test('should get progress for all files', () => {
            turbopush.addFile(mockFile);
            const file2 = new File([new Blob(['content2'])], 'test2.txt');
            turbopush.addFile(file2);
            const progress = turbopush.getProgress();
            expect(progress).toHaveLength(2);
        });

        test('should get progress by filename', () => {
            turbopush.addFile(mockFile);
            const progress = turbopush.getFileProgress('test.txt');
            expect(progress).toBeDefined();
            expect(progress?.fileName).toBe('test.txt');
        });
    });

    describe('Statistics', () => {
        beforeEach(() => {
            turbopush = new TurboPush({ endpoint: '/upload' });
        });

        test('should initialize with zero stats', () => {
            const stats = turbopush.getStats();
            expect(stats.totalFiles).toBe(0);
            expect(stats.completedFiles).toBe(0);
            expect(stats.failedFiles).toBe(0);
        });

        test('should calculate stats after upload', async () => {
            turbopush.addFile(mockFile);
            await turbopush.push();
            const stats = turbopush.getStats();
            expect(stats.completedFiles).toBe(1);
        });
    });
});