/**
 * MockServer - HTTP Mock Server for Testing
 *
 * Simulates a TurboPush upload endpoint for testing without actual HTTP requests.
 * Supports chunk uploads, finalization, and failure simulation.
 *
 * @example
 * ```typescript
 * const mockServer = new MockServer();
 * mockServer.start();
 *
 * // Simulate 2 failures before success
 * mockServer.simulateIntermittentFailures(2);
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
 * Mock HTTP response object matching the fetch API Response interface
 */
interface MockResponse {
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<any>;
}

/**
 * Request capture object containing URL and options
 */
interface CapturedRequest {
    url: string;
    options?: RequestInit;
}

/**
 * Finalization request data
 */
interface FinalizeData {
    action: string;
    fileName: string;
    fileId: string;
    fileSize: number;
    totalChunks: number;
}

export class MockServer {
    /** Array of all captured HTTP requests made to the mock server */
    private requests: CapturedRequest[] = [];

    /** Current count of failures that have been simulated */
    private failureCount: number = 0;

    /** Maximum number of failures to simulate before allowing success */
    private maxFailures: number = 0;

    /** Mock endpoint URL returned to clients */
    private endpoint: string = '/mock-upload';

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
     * Starts the mock server by replacing global.fetch with the mock implementation
     * All fetch calls will be intercepted and handled by this mock server
     *
     * @public
     * @returns {void}
     */
    public start(): void {
        global.fetch = this.mockFetch.bind(this) as any;
    }

    /**
     * Stops the mock server and restores the original fetch function
     * Clears all captured requests and resets failure counters
     *
     * @public
     * @returns {void}
     */
    public stop(): void {
        global.fetch = this.originalFetch;
        this.requests = [];
        this.failureCount = 0;
    }

    /**
     * Gets the mock endpoint URL that clients should use for uploads
     *
     * @public
     * @returns {string} The mock endpoint URL
     */
    public getEndpoint(): string {
        return this.endpoint;
    }

    /**
     * Retrieves all HTTP requests that have been captured by the mock server
     * Useful for verifying that the correct requests were made during testing
     *
     * @public
     * @returns {CapturedRequest[]} Array of captured requests with URL and options
     */
    public getRequests(): CapturedRequest[] {
        return this.requests;
    }

    /**
     * Configures the mock server to simulate intermittent failures
     * The first 'count' requests will fail with an error, then subsequent requests succeed
     *
     * @public
     * @param {number} count - Number of requests that should fail before allowing success
     * @returns {void}
     *
     * @example
     * ```typescript
     * mockServer.simulateIntermittentFailures(3);
     * // First 3 requests will fail, then succeed
     * ```
     */
    public simulateIntermittentFailures(count: number): void {
        this.maxFailures = count;
        this.failureCount = 0;
    }

    /**
     * Mock fetch implementation that handles all intercepted requests
     * Simulates chunk uploads and finalization requests
     *
     * @private
     * @param {string | URL | Request} url - Request URL
     * @param {RequestInit} [options] - Fetch options including method, body, headers
     * @returns {Promise<MockResponse>} Promise resolving to mock response
     * @throws {Error} When simulating failures
     */
    private async mockFetch(url: string | URL | Request, options?: RequestInit): Promise<MockResponse> {
        // Capture the request for inspection
        this.requests.push({
            url: url.toString(),
            options
        });

        // Simulate failure if within failure threshold
        if (this.failureCount < this.maxFailures) {
            this.failureCount++;
            return Promise.reject(new Error('Simulated failure'));
        }

        // Small delay to simulate network latency
        await new Promise(resolve => setTimeout(resolve, 10));

        // Check if this is a finalization request (JSON body with action: 'finalize')
        if (options?.body && typeof options.body === 'string') {
            try {
                const json = JSON.parse(options.body);
                if (json.action === 'finalize') {
                    return this.handleFinalize(json);
                }
            } catch (error) {
                // Not JSON or parse error, treat as chunk upload
            }
        }

        // Default to handling as chunk upload
        return this.handleChunk();
    }

    /**
     * Handles chunk upload requests
     * Returns a successful response indicating the chunk was received
     *
     * @private
     * @returns {MockResponse} Success response for chunk upload
     */
    private handleChunk(): MockResponse {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ success: true })
        };
    }

    /**
     * Handles finalization requests after all chunks are uploaded
     * Returns success response with the uploaded file information
     *
     * @private
     * @param {FinalizeData} data - Finalization request data containing file metadata
     * @returns {MockResponse} Success response with file information
     */
    private handleFinalize(data: FinalizeData): MockResponse {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
                success: true,
                data: { fileName: data.fileName }
            })
        };
    }
}