/**
 * Integration Tests for TurboPush
 */

import { TurboPush } from '../TurboPush';
import type { UploadProgress } from '../TurboPush';
import { MockServer } from './mocks/MockServer';

/** Resolves after the given number of milliseconds */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Builds a file whose content shows where each byte belongs */
function patternFile(size: number, name: string = 'pattern.txt'): { file: File; content: string } {
    let content = '';
    for (let i = 0; content.length < size; i++) {
        content += `${i},`;
    }
    content = content.substring(0, size);
    return { file: new File([content], name), content };
}

describe('TurboPush Integration Tests', () => {
    let mockServer: MockServer;

    beforeEach(() => {
        mockServer = new MockServer();
        mockServer.start();
    });

    afterEach(() => {
        mockServer.stop();
    });

    describe('Single File Upload', () => {
        test('should upload small file successfully', async () => {
            const content = 'a'.repeat(1000);
            const file = new File([new Blob([content])], 'small.txt');

            const turbopush = new TurboPush({
                endpoint: mockServer.getEndpoint(),
                chunkSize: 500
            });

            const completeCallback = jest.fn();
            turbopush.addFile(file).onComplete(completeCallback);
            await turbopush.push();

            expect(completeCallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    completedFiles: 1,
                    failedFiles: 0
                })
            );
        });

        test('should upload large file in chunks', async () => {
            const content = 'x'.repeat(10000);
            const file = new File([new Blob([content])], 'large.txt');

            const turbopush = new TurboPush({
                endpoint: mockServer.getEndpoint(),
                chunkSize: 1000
            });

            const progressUpdates: number[] = [];
            turbopush
                .addFile(file)
                .onProgress((progress) => {
                    progressUpdates.push(progress[0].percentage);
                });

            await turbopush.push();

            expect(progressUpdates.length).toBeGreaterThan(0);
            expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
        });
    });

    describe('Multiple File Upload', () => {
        test('should upload multiple files concurrently', async () => {
            const files = [
                new File([new Blob(['file1'])], 'file1.txt'),
                new File([new Blob(['file2'])], 'file2.txt'),
                new File([new Blob(['file3'])], 'file3.txt')
            ];

            const turbopush = new TurboPush({
                endpoint: mockServer.getEndpoint(),
                maxConcurrentUploads: 2
            });

            const completeCallback = jest.fn();
            turbopush.addFiles(files).onComplete(completeCallback);
            await turbopush.push();

            expect(completeCallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    completedFiles: 3,
                    totalFiles: 3
                })
            );
        });
    });

    describe('Error Recovery', () => {
        test('should retry on temporary failures', async () => {
            mockServer.simulateIntermittentFailures(2);

            const file = new File([new Blob(['test'])], 'test.txt');
            const turbopush = new TurboPush({
                endpoint: mockServer.getEndpoint(),
                maxRetries: 3
            });

            turbopush.addFile(file);
            await turbopush.push();

            const stats = turbopush.getStats();
            expect(stats.completedFiles).toBe(1);
        });
    });

    describe('Progress Tracking', () => {
        test('should report accurate progress', async () => {
            const content = 'a'.repeat(1000);
            const file = new File([new Blob([content])], 'progress.txt');

            const turbopush = new TurboPush({
                endpoint: mockServer.getEndpoint(),
                chunkSize: 200
            });

            const progressSnapshots: number[] = [];
            turbopush
                .addFile(file)
                .onProgress((progress) => {
                    progressSnapshots.push(progress[0].percentage);
                });

            await turbopush.push();

            expect(progressSnapshots.length).toBeGreaterThan(1);
            expect(progressSnapshots[progressSnapshots.length - 1]).toBe(100);
        });
    });

    describe('Data Integrity', () => {
        test('server receives every byte in the right order', async () => {
            const { file, content } = patternFile(10000);
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 999, maxConcurrentUploads: 4 });
            turbopush.addFile(file);

            await turbopush.push();

            const fileId = turbopush.getProgress()[0].fileId;
            expect(mockServer.getUpload(fileId)!.totalChunks).toBe(11);
            expect(await mockServer.readAssembled(fileId)).toBe(content);
        });

        test('progress counts the bytes actually uploaded', async () => {
            const { file } = patternFile(2500);
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, maxConcurrentUploads: 1 });
            const sizes: number[] = [];
            const statuses = new Set<string>();
            turbopush.addFile(file).onProgress(progress => {
                sizes.push(progress[0].uploadedSize);
                statuses.add(progress[0].status);
            });

            const stats = await turbopush.push();

            expect(sizes.filter((size, i) => size !== sizes[i - 1])).toEqual([0, 1000, 2000, 2500]);
            expect(statuses).toEqual(new Set(['uploading', 'completed']));
            expect(stats.uploadedBytes).toBe(2500);
            expect(stats.averageSpeed).toBeGreaterThan(0);
        });
    });

    describe('Concurrency', () => {
        test('maxConcurrentUploads limits chunk requests across all files', async () => {
            const files = [1, 2, 3].map(n => patternFile(5000, `file${n}.txt`).file);
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, maxConcurrentUploads: 2 });

            const stats = await turbopush.addFiles(files).push();

            expect(stats.completedFiles).toBe(3);
            expect(mockServer.getMaxConcurrentChunks()).toBe(2);
        });

        test('push() while uploading returns the same promise', async () => {
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint() });
            turbopush.addFile(patternFile(100).file);

            const first = turbopush.push();
            const second = turbopush.push();

            expect(second).toBe(first);
            await first;
        });
    });

    describe('Pause, Resume and Cancel', () => {
        test('pause stops uploads and resume finishes the same push() call', async () => {
            mockServer.setLatency(30);
            const { file, content } = patternFile(5000);
            const completeCallback = jest.fn();
            // maxRetries 0: chunks aborted by pause must not count as failures
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 500, maxRetries: 0 });
            turbopush.addFile(file).onComplete(completeCallback);

            let settled = false;
            const pushed = turbopush.push().then(stats => { settled = true; return stats; });
            await delay(50);

            turbopush.pause();
            expect(turbopush.isPausedState()).toBe(true);
            expect(turbopush.getProgress()[0].status).toBe('paused');

            const requestsWhenPaused = mockServer.getParsedRequests('chunk').length;
            await delay(150);
            expect(mockServer.getParsedRequests('chunk').length).toBe(requestsWhenPaused);
            expect(settled).toBe(false);

            await turbopush.resume();
            const stats = await pushed;

            expect(stats.completedFiles).toBe(1);
            expect(stats.failedFiles).toBe(0);
            expect(completeCallback).toHaveBeenCalledTimes(1);
            expect(await mockServer.readAssembled(turbopush.getProgress()[0].fileId)).toBe(content);
        });

        test('resume() without a running upload starts one', async () => {
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint() });
            turbopush.addFile(patternFile(100).file);

            turbopush.pause();
            await turbopush.resume();

            expect(turbopush.getStats().completedFiles).toBe(1);
        });

        test('cancel ends push(), clears the queue and tells the server', async () => {
            mockServer.setLatency(30);
            const completeCallback = jest.fn();
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 500 });
            turbopush.addFile(patternFile(5000).file).onComplete(completeCallback);

            const pushed = turbopush.push();
            await delay(50);
            const fileId = turbopush.getProgress()[0].fileId;
            turbopush.cancel();

            const stats = await pushed;
            expect(stats.cancelled).toBe(true);
            expect(stats.completedFiles).toBe(0);
            expect(turbopush.getQueueSize()).toBe(0);
            expect(turbopush.getStats().totalFiles).toBe(0);

            const chunksAtCancel = mockServer.getParsedRequests('chunk').length;
            await delay(100);
            expect(mockServer.getParsedRequests('chunk').length).toBe(chunksAtCancel);
            expect(mockServer.getParsedRequests('abort').map(r => r.fileId)).toEqual([fileId]);
            expect(completeCallback).not.toHaveBeenCalled();
        });

        test('the instance can be reused after cancel', async () => {
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint() });
            turbopush.addFile(patternFile(100, 'first.txt').file);
            const first = turbopush.push();
            turbopush.cancel();
            await first;

            const stats = await turbopush.addFile(patternFile(100, 'second.txt').file).push();
            expect(stats).toMatchObject({ totalFiles: 1, completedFiles: 1, failedFiles: 0 });
        });
    });

    describe('Retrying Failed Files', () => {
        test('push() again uploads only the chunks the server is missing', async () => {
            const { file, content } = patternFile(5000);
            let rejectChunks = true;
            mockServer.intercept(req =>
                rejectChunks && req.kind === 'chunk' && req.chunkIndex! >= 3
                    ? MockServer.json(400, { success: false, message: 'Rejected' })
                    : undefined
            );

            const onError = jest.fn();
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, maxConcurrentUploads: 1 });
            turbopush.addFile(file).onError(onError);

            const first = await turbopush.push();
            expect(first.failedFiles).toBe(1);
            expect(onError).toHaveBeenCalledTimes(1);

            rejectChunks = false;
            const chunkRequestsBefore = mockServer.getParsedRequests('chunk').length;
            const second = await turbopush.push();

            expect(second).toMatchObject({ completedFiles: 1, failedFiles: 0 });
            const resent = mockServer.getParsedRequests('chunk').slice(chunkRequestsBefore).map(r => r.chunkIndex);
            expect(resent).toEqual([3, 4]);
            expect(await mockServer.readAssembled(turbopush.getProgress()[0].fileId)).toBe(content);
        });

        test('completed files are not uploaded again', async () => {
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint() });
            turbopush.addFile(patternFile(100).file);
            await turbopush.push();
            const requests = mockServer.getRequests().length;

            const stats = await turbopush.push();

            expect(mockServer.getRequests().length).toBe(requests);
            expect(stats.completedFiles).toBe(1);
        });

        test('one failing file does not stop the others', async () => {
            mockServer.intercept(req =>
                req.kind === 'chunk' && String(req.fields!.fileName) === 'bad.exe'
                    ? MockServer.json(415, { success: false, message: 'File type not allowed: .exe' })
                    : undefined
            );
            const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint() });
            const progress: UploadProgress[][] = [];
            turbopush
                .addFiles([patternFile(100, 'good.txt').file, patternFile(100, 'bad.exe').file])
                .onProgress(p => progress.push(p.map(x => ({ ...x }))));

            const stats = await turbopush.push();

            expect(stats).toMatchObject({ completedFiles: 1, failedFiles: 1 });
            expect(turbopush.getFileProgress('bad.exe')!.error).toBe('File type not allowed: .exe');
            expect(turbopush.getFileProgress('good.txt')!.status).toBe('completed');
        });
    });
});
