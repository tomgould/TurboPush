/**
 * Mock Server for Testing
 */

export class MockServer {
    private requests: any[] = [];
    private failureCount: number = 0;
    private maxFailures: number = 0;
    private endpoint: string = '/mock-upload';
    private originalFetch: any;

    constructor() {
        this.originalFetch = global.fetch;
    }

    public start(): void {
        global.fetch = this.mockFetch.bind(this) as any;
    }

    public stop(): void {
        global.fetch = this.originalFetch;
        this.requests = [];
        this.failureCount = 0;
    }

    public getEndpoint(): string {
        return this.endpoint;
    }

    public getRequests(): any[] {
        return this.requests;
    }

    public simulateIntermittentFailures(count: number): void {
        this.maxFailures = count;
        this.failureCount = 0;
    }

    private async mockFetch(url: any, options?: any): Promise<any> {
        this.requests.push({ url, options });

        if (this.failureCount < this.maxFailures) {
            this.failureCount++;
            return Promise.reject(new Error('Simulated failure'));
        }

        await new Promise(resolve => setTimeout(resolve, 10));

        if (options?.body && typeof options.body === 'string') {
            const json = JSON.parse(options.body);
            if (json.action === 'finalize') {
                return this.handleFinalize(json);
            }
        }

        return this.handleChunk();
    }

    private handleChunk(): any {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ success: true })
        };
    }

    private handleFinalize(data: any): any {
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

