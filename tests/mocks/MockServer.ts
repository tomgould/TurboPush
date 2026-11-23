/**
 * MockServer - HTTP Mock Server for Testing
 *
 * Simulates a TurboPush upload endpoint by replacing global fetch. It stores
 * chunks, reassembles them on finalize, implements the status and abort
 * actions, honours abort signals and records how many chunk requests were
 * in flight at once.
 *
 * @example
 * ```typescript
 * const mockServer = new MockServer();
 * mockServer.start();
 *
 * // Simulate 2 failures before success
 * mockServer.simulateIntermittentFailures(2);
 *
 * // Answer chunk 3 with a 503 once
 * mockServer.intercept(req => req.chunkIndex === 3 ? MockServer.json(503, { success: false }) : undefined, 1);
 *
 * // Run tests...
 *
 * mockServer.stop();
 * ```
 *
 * @class MockServer
 * @since 1.0.0
 */

/**
 * Mock HTTP response object matching the parts of the fetch Response the client uses
 */
export interface MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<any>;
}

/**
 * Request capture object containing URL and options
 */
export interface CapturedRequest {
    url: string;
    options?: RequestInit;
}

/**
 * Parsed view of a request, passed to interceptors
 */
export interface MockRequest {
    kind: 'chunk' | 'finalize' | 'status' | 'abort' | 'unknown';
    url: string;
    options?: RequestInit;
    fileId?: string;
    chunkIndex?: number;
    fields?: Record<string, FormDataEntryValue>;
    json?: any;
}

/**
 * An upload as stored by the mock server
 */
export interface StoredUpload {
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunks: Map<number, Blob>;
    result?: { fileName: string; fileSize: number };
}

type Interceptor = (request: MockRequest) => MockResponse | Promise<MockResponse> | undefined;

export class MockServer {
    /** Array of all captured HTTP requests made to the mock server */
    private requests: CapturedRequest[] = [];

    /** Parsed requests, in order */
    private parsed: MockRequest[] = [];

    /** Current count of failures that have been simulated */
    private failureCount: number = 0;

    /** Maximum number of failures to simulate before allowing success */
    private maxFailures: number = 0;

    /** Mock endpoint URL returned to clients */
    private endpoint: string = '/mock-upload';

    /** Simulated network latency in milliseconds */
    private latency: number = 10;

    /** Interceptors with their remaining use count (Infinity = permanent) */
    private interceptors: { handler: Interceptor; remaining: number }[] = [];

    /** Uploads by fileId */
    private uploads: Map<string, StoredUpload> = new Map();

    /** Chunk requests currently being handled */
    private inFlight: number = 0;

    /** Highest number of chunk requests handled at once */
    private maxInFlight: number = 0;

    /** Reference to the original global fetch function */
    private originalFetch: typeof global.fetch;

    /**
     * Creates a new MockServer instance
     * Saves the original global fetch function for later restoration
     */
    constructor() {
        this.originalFetch = global.fetch;
    }

    /**
     * Builds a JSON response
     */
    public static json(status: number, body: any): MockResponse {
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: status === 200 ? 'OK' : 'Error',
            json: async () => body
        };
    }

    /**
     * Starts the mock server by replacing global.fetch with the mock implementation
     */
    public start(): void {
        global.fetch = this.mockFetch.bind(this) as any;
    }

    /**
     * Stops the mock server and restores the original fetch function
     */
    public stop(): void {
        global.fetch = this.originalFetch;
        this.requests = [];
        this.parsed = [];
        this.failureCount = 0;
        this.interceptors = [];
        this.uploads.clear();
    }

    /**
     * Gets the mock endpoint URL that clients should use for uploads
     */
    public getEndpoint(): string {
        return this.endpoint;
    }

    /**
     * Retrieves all HTTP requests that have been captured by the mock server
     */
    public getRequests(): CapturedRequest[] {
        return this.requests;
    }

    /**
     * Retrieves parsed requests, optionally only of one kind
     */
    public getParsedRequests(kind?: MockRequest['kind']): MockRequest[] {
        return kind ? this.parsed.filter(request => request.kind === kind) : this.parsed;
    }

    /**
     * Configures the mock server to simulate intermittent failures
     * The first 'count' requests will fail with a network error, then subsequent requests succeed
     */
    public simulateIntermittentFailures(count: number): void {
        this.maxFailures = count;
        this.failureCount = 0;
    }

    /**
     * Sets the simulated latency of every request
     */
    public setLatency(ms: number): void {
        this.latency = ms;
    }

    /**
     * Adds an interceptor. Return a response to answer the request yourself,
     * or undefined to let the server handle it. Throwing simulates a network error.
     *
     * @param handler - The interceptor
     * @param times - How many requests it may answer (default: unlimited)
     */
    public intercept(handler: Interceptor, times: number = Infinity): void {
        this.interceptors.push({ handler, remaining: times });
    }

    /**
     * Gets a stored upload
     */
    public getUpload(fileId: string): StoredUpload | undefined {
        return this.uploads.get(fileId);
    }

    /**
     * Stores chunks directly, as if an earlier session had uploaded them
     */
    public seedUpload(fileId: string, upload: StoredUpload): void {
        this.uploads.set(fileId, upload);
    }

    /**
     * Highest number of chunk requests that were in flight at once
     */
    public getMaxConcurrentChunks(): number {
        return this.maxInFlight;
    }

    /**
     * Reads the stored chunks of an upload, in order, as one string
     */
    public async readAssembled(fileId: string): Promise<string> {
        const upload = this.uploads.get(fileId);
        if (!upload) {
            throw new Error(`No upload ${fileId}`);
        }
        let text = '';
        for (let i = 0; i < upload.totalChunks; i++) {
            const chunk = upload.chunks.get(i);
            if (!chunk) {
                throw new Error(`Missing chunk ${i}`);
            }
            text += await MockServer.readBlob(chunk);
        }
        return text;
    }

    /**
     * Mock fetch implementation that handles all intercepted requests
     */
    private async mockFetch(url: string | URL | Request, options?: RequestInit): Promise<MockResponse> {
        // Capture the request for inspection
        this.requests.push({ url: url.toString(), options });
        const request = this.parse(url.toString(), options);
        this.parsed.push(request);

        // Simulate failure if within failure threshold
        if (this.failureCount < this.maxFailures) {
            this.failureCount++;
            return Promise.reject(new Error('Simulated failure'));
        }

        const isChunk = request.kind === 'chunk';
        if (isChunk) {
            this.inFlight++;
            this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        }

        try {
            // Delay to simulate network latency
            await this.wait(this.latency, options?.signal);

            for (const interceptor of this.interceptors) {
                if (interceptor.remaining <= 0) {
                    continue;
                }
                const response = await interceptor.handler(request);
                if (response) {
                    interceptor.remaining--;
                    return response;
                }
            }

            switch (request.kind) {
                case 'chunk':
                    return this.handleChunk(request);
                case 'finalize':
                    return this.handleFinalize(request);
                case 'status':
                    return this.handleStatus(request);
                case 'abort':
                    this.uploads.delete(request.fileId!);
                    return MockServer.json(200, { success: true, message: 'Upload aborted', data: [] });
                default:
                    return MockServer.json(400, { success: false, message: 'Unknown request', data: [] });
            }
        } finally {
            if (isChunk) {
                this.inFlight--;
            }
        }
    }

    /**
     * Works out what kind of request this is
     */
    private parse(url: string, options?: RequestInit): MockRequest {
        const body = options?.body;

        if (body instanceof FormData) {
            const fields: Record<string, FormDataEntryValue> = {};
            body.forEach((value, key) => { fields[key] = value; });
            return {
                kind: 'chunk',
                url,
                options,
                fields,
                fileId: String(fields.fileId),
                chunkIndex: Number(fields.chunkIndex)
            };
        }

        if (typeof body === 'string') {
            try {
                const json = JSON.parse(body);
                if (['finalize', 'status', 'abort'].includes(json.action)) {
                    return { kind: json.action, url, options, json, fileId: json.fileId };
                }
            } catch (error) {
                // Not JSON
            }
        }

        return { kind: 'unknown', url, options };
    }

    /**
     * Stores a chunk
     */
    private handleChunk(request: MockRequest): MockResponse {
        const fields = request.fields!;
        const fileId = request.fileId!;
        let upload = this.uploads.get(fileId);
        if (!upload) {
            upload = {
                fileName: String(fields.fileName),
                fileSize: Number(fields.fileSize),
                totalChunks: Number(fields.totalChunks),
                chunks: new Map()
            };
            this.uploads.set(fileId, upload);
        }
        if (upload.totalChunks !== Number(fields.totalChunks) || upload.fileSize !== Number(fields.fileSize)) {
            return MockServer.json(409, { success: false, message: 'Upload metadata does not match', data: [] });
        }
        upload.chunks.set(request.chunkIndex!, fields.file as Blob);
        return MockServer.json(200, {
            success: true,
            message: 'Chunk uploaded',
            data: { chunkIndex: request.chunkIndex, totalChunks: upload.totalChunks }
        });
    }

    /**
     * Checks that every chunk arrived and the sizes add up
     */
    private handleFinalize(request: MockRequest): MockResponse {
        const data = request.json;
        const upload = this.uploads.get(data.fileId);
        if (!upload) {
            return MockServer.json(404, { success: false, message: 'Upload not found', data: [] });
        }
        if (upload.result) {
            return MockServer.json(200, { success: true, message: 'Upload complete', data: upload.result });
        }

        const missing: number[] = [];
        let size = 0;
        for (let i = 0; i < data.totalChunks; i++) {
            const chunk = upload.chunks.get(i);
            if (!chunk) {
                missing.push(i);
            } else {
                size += chunk.size;
            }
        }
        if (missing.length > 0) {
            return MockServer.json(409, { success: false, message: 'Missing chunks', data: { missingChunks: missing } });
        }
        if (size !== data.fileSize) {
            return MockServer.json(409, { success: false, message: 'File size mismatch', data: [] });
        }

        upload.result = { fileName: data.fileName, fileSize: size };
        return MockServer.json(200, { success: true, message: 'Upload complete', data: upload.result });
    }

    /**
     * Reports which chunks are stored
     */
    private handleStatus(request: MockRequest): MockResponse {
        const upload = this.uploads.get(request.fileId!);
        if (!upload) {
            return MockServer.json(404, { success: false, message: 'Upload not found', data: [] });
        }
        if (upload.result) {
            return MockServer.json(200, { success: true, message: 'Upload complete', data: { complete: true, ...upload.result } });
        }
        return MockServer.json(200, {
            success: true,
            message: 'Upload in progress',
            data: {
                complete: false,
                fileName: upload.fileName,
                fileSize: upload.fileSize,
                totalChunks: upload.totalChunks,
                uploadedChunks: Array.from(upload.chunks.keys()).sort((a, b) => a - b)
            }
        });
    }

    /**
     * Waits, rejecting with an AbortError if the signal fires first
     */
    private wait(ms: number, signal?: AbortSignal | null): Promise<void> {
        return new Promise((resolve, reject) => {
            const abortError = () => {
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                return error;
            };
            if (signal?.aborted) {
                reject(abortError());
                return;
            }
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(abortError());
            }, { once: true });
        });
    }

    /**
     * Reads a Blob as text (jsdom's Blob has no text() method)
     */
    private static readBlob(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(blob);
        });
    }
}
