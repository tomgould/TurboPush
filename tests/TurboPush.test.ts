/**
 * Unit Tests for TurboPush
 */

import { TurboPush, TurboPushError } from '../TurboPush';
import type { TurboPushConfig, UploadProgress, UploadStats, RetryInfo } from '../TurboPush';

global.fetch = jest.fn();

/**
 * Builds a fetch response with a JSON body
 */
function jsonResponse(status: number, body: any) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        json: async () => body
    };
}

const ok = () => jsonResponse(200, { success: true, message: 'OK', data: { fileName: 'test.txt', fileSize: 33 } });

/**
 * A fetch that only settles when aborted, for timeout tests
 */
function hangingFetch(_url: string, options: RequestInit) {
    return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
        });
    });
}

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

    describe('Configuration Defaults', () => {
        test('maxRetries: 0 disables retries', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(503, { success: false, message: 'Busy' }));
            turbopush = new TurboPush({ endpoint: '/upload', maxRetries: 0 });
            await turbopush.addFile(mockFile).push();

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(turbopush.getStats().failedFiles).toBe(1);
        });

        test('non-positive timeout and retryDelay fall back to defaults', () => {
            turbopush = new TurboPush({ endpoint: '/upload', timeout: 0, retryDelay: -5, chunkSize: 0 });
            const config = (turbopush as any).config;
            expect(config.timeout).toBe(30000);
            expect(config.retryDelay).toBe(1000);
            expect(config.chunkSize).toBe(1024 * 1024);
        });
    });

    describe('Requests', () => {
        test('sends metadata and the chunk in each request', async () => {
            turbopush = new TurboPush({ endpoint: '/upload', chunkSize: 10 });
            await turbopush.addFile(mockFile).push();

            const calls = (global.fetch as jest.Mock).mock.calls;
            const chunkCalls = calls.filter(([, options]) => options.body instanceof FormData);
            expect(chunkCalls).toHaveLength(4);

            const body = chunkCalls[3][1].body as FormData;
            expect(body.get('fileName')).toBe('test.txt');
            expect(body.get('chunkIndex')).toBe('3');
            expect(body.get('totalChunks')).toBe('4');
            expect(body.get('fileSize')).toBe(String(mockFile.size));
            expect((body.get('file') as Blob).size).toBe(mockFile.size - 30);
            expect(body.get('fileId')).toBe(turbopush.getProgress()[0].fileId);

            const finalize = JSON.parse(calls[calls.length - 1][1].body);
            expect(finalize).toEqual({
                action: 'finalize',
                fileName: 'test.txt',
                fileId: turbopush.getProgress()[0].fileId,
                fileSize: mockFile.size,
                totalChunks: 4
            });
        });

        test('sends custom headers, without Content-Type on multipart requests', async () => {
            turbopush = new TurboPush({
                endpoint: '/upload',
                headers: { 'X-CSRF-Token': 'abc', 'Content-Type': 'text/plain' },
                withCredentials: true
            });
            await turbopush.addFile(mockFile).push();

            const [chunkCall, finalizeCall] = (global.fetch as jest.Mock).mock.calls;
            expect(chunkCall[1].headers).toEqual({ 'X-CSRF-Token': 'abc' });
            expect(chunkCall[1].credentials).toBe('include');
            expect(finalizeCall[1].headers['X-CSRF-Token']).toBe('abc');
        });

        test('uploads empty files as a single empty chunk', async () => {
            const empty = new File([], 'empty.txt');
            turbopush = new TurboPush({ endpoint: '/upload' });
            const stats = await turbopush.addFile(empty).push();

            const calls = (global.fetch as jest.Mock).mock.calls;
            expect(calls).toHaveLength(2);
            expect(((calls[0][1].body as FormData).get('file') as Blob).size).toBe(0);
            expect(JSON.parse(calls[1][1].body).totalChunks).toBe(1);
            expect(stats.completedFiles).toBe(1);
            expect(turbopush.getProgress()[0].percentage).toBe(100);
        });

        test('generates file IDs the server accepts, even for long names', () => {
            const long = new File(['x'], 'ä'.repeat(300) + ' .txt');
            turbopush = new TurboPush({ endpoint: '/upload' });
            turbopush.addFile(long);

            const fileId = turbopush.getProgress()[0].fileId;
            expect(fileId).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
        });

        test('passes the server result to onFileComplete and progress', async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(ok())
                .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { fileName: 'test_1.txt', fileSize: 33, id: 7 } }));
            const onFileComplete = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload' });
            await turbopush.addFile(mockFile).onFileComplete(onFileComplete).push();

            const fileId = turbopush.getProgress()[0].fileId;
            expect(onFileComplete).toHaveBeenCalledWith('test.txt', fileId, { fileName: 'test_1.txt', fileSize: 33, id: 7 });
            expect(turbopush.getProgress()[0].result).toEqual({ fileName: 'test_1.txt', fileSize: 33, id: 7 });
        });
    });

    describe('Retries and Errors', () => {
        beforeEach(() => {
            jest.spyOn(Math, 'random').mockReturnValue(1); // no jitter
        });

        test('does not retry client errors and surfaces the server message', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(415, {
                success: false, message: 'File type not allowed: .exe', data: []
            }));
            const onError = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload', maxRetries: 3 });
            await turbopush.addFile(mockFile).onError(onError).push();

            expect(global.fetch).toHaveBeenCalledTimes(1);
            const error = onError.mock.calls[0][0] as TurboPushError;
            expect(error).toBeInstanceOf(TurboPushError);
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toBe('File type not allowed: .exe');
            expect(error.status).toBe(415);
            expect(error.code).toBe('http');
            expect(error.retryable).toBe(false);
            expect(error.chunkIndex).toBe(0);
            expect(turbopush.getProgress()[0].error).toBe('File type not allowed: .exe');
        });

        test('retries server errors and rate limiting', async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(jsonResponse(503, { success: false, message: 'Busy' }))
                .mockResolvedValueOnce(jsonResponse(429, {}))
                .mockResolvedValue(ok());
            const onRetry = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload', retryDelay: 100 });
            const stats = await turbopush.addFile(mockFile).onRetry(onRetry).push();

            expect(stats.completedFiles).toBe(1);
            expect(onRetry).toHaveBeenCalledTimes(2);
            const first = onRetry.mock.calls[0][0] as RetryInfo;
            expect(first).toMatchObject({ fileName: 'test.txt', chunkIndex: 0, attempt: 1, delay: 100 });
            expect(first.error.status).toBe(503);
            expect(first.error.message).toBe('Busy');
        });

        test('backs off exponentially up to maxRetryDelay', async () => {
            (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'));
            const delays: number[] = [];
            turbopush = new TurboPush({ endpoint: '/upload', maxRetries: 4, retryDelay: 100, maxRetryDelay: 500 });
            await turbopush.addFile(mockFile).onRetry(info => delays.push(info.delay)).push();

            expect(delays).toEqual([100, 200, 400, 500]);
            expect(global.fetch).toHaveBeenCalledTimes(5);
        });

        test('adds jitter of up to half the delay', async () => {
            (Math.random as jest.Mock).mockReturnValue(0);
            (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(ok());
            const delays: number[] = [];
            turbopush = new TurboPush({ endpoint: '/upload', retryDelay: 400 });
            await turbopush.addFile(mockFile).onRetry(info => delays.push(info.delay)).push();

            expect(delays).toEqual([200]);
        });

        test('reports network errors with code "network"', async () => {
            (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'));
            const onError = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload', maxRetries: 0 });
            await turbopush.addFile(mockFile).onError(onError).push();

            expect(onError.mock.calls[0][0]).toMatchObject({ code: 'network', retryable: true, message: 'Failed to fetch' });
        });

        test('treats success: false as a non-retryable failure', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { success: false, message: 'Disk full' }));
            const onError = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload' });
            await turbopush.addFile(mockFile).onError(onError).push();

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0]).toMatchObject({ code: 'server', message: 'Disk full' });
        });

        test('retries responses that are not JSON', async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new SyntaxError('bad'); } })
                .mockResolvedValue(ok());
            const onRetry = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload', retryDelay: 100 });
            const stats = await turbopush.addFile(mockFile).onRetry(onRetry).push();

            expect(stats.completedFiles).toBe(1);
            expect(onRetry.mock.calls[0][0].error.code).toBe('invalid_response');
        });

        test('times out slow requests and retries them', async () => {
            jest.useFakeTimers();
            (global.fetch as jest.Mock).mockImplementationOnce(hangingFetch).mockResolvedValue(ok());
            const onRetry = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload', timeout: 5000, retryDelay: 100 });

            const done = turbopush.addFile(mockFile).onRetry(onRetry).push();
            await jest.advanceTimersByTimeAsync(5000);
            expect(onRetry).toHaveBeenCalledTimes(1);
            expect(onRetry.mock.calls[0][0].error).toMatchObject({ code: 'timeout', message: 'Upload timeout' });

            await jest.advanceTimersByTimeAsync(100);
            const stats = await done;
            expect(stats.completedFiles).toBe(1);
        });

        test('retries a failed finalize request', async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(ok())
                .mockResolvedValueOnce(jsonResponse(502, {}))
                .mockResolvedValue(ok());
            const onRetry = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload', retryDelay: 100 });
            const stats = await turbopush.addFile(mockFile).onRetry(onRetry).push();

            expect(stats.completedFiles).toBe(1);
            expect(onRetry.mock.calls[0][0]).toMatchObject({ chunkIndex: null, attempt: 1 });
        });

        test('fails the file when finalize is rejected', async () => {
            (global.fetch as jest.Mock)
                .mockResolvedValueOnce(ok())
                .mockResolvedValueOnce(jsonResponse(409, { success: false, message: 'Missing chunks', data: { missingChunks: [0] } }));
            const onError = jest.fn();
            turbopush = new TurboPush({ endpoint: '/upload' });
            const stats = await turbopush.addFile(mockFile).onError(onError).push();

            expect(stats.failedFiles).toBe(1);
            expect(onError.mock.calls[0][0]).toMatchObject({ message: 'Missing chunks', status: 409, data: { missingChunks: [0] } });
        });

        test('an exception in a callback does not break the upload', async () => {
            // The error is rethrown asynchronously; catch it like a page would
            const errors: Error[] = [];
            const listener = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
            window.addEventListener('error', listener);

            turbopush = new TurboPush({ endpoint: '/upload' });
            const stats = await turbopush.addFile(mockFile).onProgress(() => { throw new Error('UI bug'); }).push();
            await new Promise(resolve => setTimeout(resolve, 10));
            window.removeEventListener('error', listener);

            expect(stats.completedFiles).toBe(1);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0].message).toBe('UI bug');
        });
    });
});
