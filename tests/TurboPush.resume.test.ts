/**
 * Resumable Upload Tests
 *
 * A "page reload" is simulated by creating a new TurboPush instance for the
 * same file while the mock server keeps the chunks it already received.
 */

import { TurboPush } from '../TurboPush';
import { MockServer } from './mocks/MockServer';

function makeFile(size: number = 5000, name: string = 'video.mp4'): File {
    return new File(['v'.repeat(size)], name, { lastModified: 1700000000000 });
}

describe('TurboPush Resumable Uploads', () => {
    let mockServer: MockServer;

    beforeEach(() => {
        mockServer = new MockServer();
        mockServer.start();
    });

    afterEach(() => {
        mockServer.stop();
    });

    /**
     * Uploads chunks 0-2 of 5, then the "connection drops" for good
     */
    async function interruptedUpload(file: File): Promise<string> {
        let fail = true;
        mockServer.intercept(req =>
            fail && req.kind === 'chunk' && req.chunkIndex! >= 3
                ? MockServer.json(400, { success: false, message: 'Gone' })
                : undefined
        );
        const first = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, maxConcurrentUploads: 1, resumable: true });
        await first.addFile(file).push();
        fail = false;
        expect(first.getStats().failedFiles).toBe(1);
        return first.getProgress()[0].fileId;
    }

    test('is off by default', async () => {
        const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint() });
        await turbopush.addFile(makeFile()).push();

        expect(localStorage.length).toBe(0);
        expect(mockServer.getParsedRequests('status')).toHaveLength(0);
    });

    test('continues after a reload with only the missing chunks', async () => {
        const file = makeFile();
        const fileId = await interruptedUpload(file);
        const chunksBefore = mockServer.getParsedRequests('chunk').length;

        const second = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, resumable: true });
        second.addFile(file);
        expect(second.getProgress()[0].fileId).toBe(fileId);

        const stats = await second.push();

        expect(stats.completedFiles).toBe(1);
        const resent = mockServer.getParsedRequests('chunk').slice(chunksBefore).map(r => r.chunkIndex).sort();
        expect(resent).toEqual([3, 4]);
        expect(second.getProgress()[0].uploadedSize).toBe(5000);
        expect(await mockServer.readAssembled(fileId)).toBe('v'.repeat(5000));
        expect(localStorage.length).toBe(0);
    });

    test('reports a file that finished before the reload as completed', async () => {
        const file = makeFile();
        const first = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, resumable: true });
        first.addFile(file);
        const fileId = first.getProgress()[0].fileId;
        await first.push();
        // Simulate the page closing before the client could forget the upload
        localStorage.setItem(`turbopush:${mockServer.getEndpoint()}:video.mp4:5000:1700000000000`, fileId);

        const onFileComplete = jest.fn();
        const second = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, resumable: true });
        const chunksBefore = mockServer.getParsedRequests('chunk').length;
        const stats = await second.addFile(file).onFileComplete(onFileComplete).push();

        expect(stats.completedFiles).toBe(1);
        expect(mockServer.getParsedRequests('chunk').length).toBe(chunksBefore);
        expect(onFileComplete).toHaveBeenCalledWith('video.mp4', fileId, { fileName: 'video.mp4', fileSize: 5000 });
    });

    test('starts again when the server has chunks of a different size', async () => {
        const file = makeFile();
        const fileId = await interruptedUpload(file);

        const second = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 2000, resumable: true });
        const stats = await second.addFile(file).push();

        expect(stats.completedFiles).toBe(1);
        expect(mockServer.getParsedRequests('abort').map(r => r.fileId)).toEqual([fileId]);
        expect(mockServer.getUpload(fileId)!.totalChunks).toBe(3);
        expect(await mockServer.readAssembled(fileId)).toBe('v'.repeat(5000));
    });

    test('starts again when the server no longer has the upload', async () => {
        const file = makeFile();
        const fileId = await interruptedUpload(file);
        mockServer.getUpload(fileId)!.chunks.clear();
        mockServer.intercept(req => req.kind === 'status' ? MockServer.json(404, { success: false, message: 'Upload not found' }) : undefined);

        const second = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, resumable: true });
        const chunksBefore = mockServer.getParsedRequests('chunk').length;
        const stats = await second.addFile(file).push();

        expect(stats.completedFiles).toBe(1);
        expect(mockServer.getParsedRequests('chunk').length - chunksBefore).toBe(5);
    });

    test('gives the same file added twice different upload IDs', () => {
        const file = makeFile();
        const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), resumable: true });
        turbopush.addFile(file).addFile(file);

        const [a, b] = turbopush.getProgress();
        expect(a.fileId).not.toBe(b.fileId);
    });

    test('cancel forgets the upload', async () => {
        const file = makeFile();
        await interruptedUpload(file);
        expect(localStorage.length).toBe(1);

        const second = new TurboPush({ endpoint: mockServer.getEndpoint(), resumable: true });
        second.addFile(file).cancel();

        expect(localStorage.length).toBe(0);
        expect(mockServer.getParsedRequests('abort')).toHaveLength(1);
    });

    test('works when localStorage is unavailable', async () => {
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });

        const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), resumable: true });
        const stats = await turbopush.addFile(makeFile()).push();

        expect(stats.completedFiles).toBe(1);
    });

    test('ignores invalid chunk indexes in the status response', async () => {
        const file = makeFile(2000);
        localStorage.setItem(`turbopush:${mockServer.getEndpoint()}:video.mp4:2000:1700000000000`, 'stored-id');
        mockServer.intercept(req => req.kind === 'status'
            ? MockServer.json(200, { success: true, data: {
                complete: false, fileSize: 2000, totalChunks: 2, uploadedChunks: ['__proto__', -1, 7, 1.5, 'x']
            } })
            : undefined);

        const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, resumable: true });
        const stats = await turbopush.addFile(file).push();

        expect((Array.prototype as any).state).toBeUndefined();
        expect(stats).toMatchObject({ completedFiles: 1, uploadedBytes: 2000 });
        expect(mockServer.getParsedRequests('chunk')).toHaveLength(2);
    });

    test('drops server data when the status check fails for another reason', async () => {
        const file = makeFile(2000);
        localStorage.setItem(`turbopush:${mockServer.getEndpoint()}:video.mp4:2000:1700000000000`, 'stored-id');
        mockServer.intercept(req => req.kind === 'status' ? MockServer.json(500, { success: false }) : undefined);

        const turbopush = new TurboPush({ endpoint: mockServer.getEndpoint(), chunkSize: 1000, resumable: true });
        const stats = await turbopush.addFile(file).push();

        expect(mockServer.getParsedRequests('abort').map(r => r.fileId)).toEqual(['stored-id']);
        expect(stats.completedFiles).toBe(1);
    });
});

