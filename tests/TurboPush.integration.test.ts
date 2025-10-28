/**
 * Integration Tests for TurboPush
 */

import { TurboPush } from '../TurboPush';
import { MockServer } from './mocks/MockServer';

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
});

