/**
 * Test Setup - Mock browser APIs
 */

class MockBlob {
    private content: any[];
    public type: string;

    constructor(content: any[], options?: { type?: string }) {
        this.content = content;
        this.type = options?.type || '';
    }

    slice(start?: number, end?: number): MockBlob {
        return new MockBlob(this.content.slice(start, end), { type: this.type });
    }

    get size(): number {
        return this.content.reduce((acc, item) => {
            if (typeof item === 'string') return acc + item.length;
            if (item instanceof ArrayBuffer) return acc + item.byteLength;
            if (item instanceof MockBlob) return acc + item.size;
            return acc;
        }, 0);
    }
}

class MockFile extends MockBlob {
    public name: string;
    public lastModified: number;

    constructor(content: any[], name: string, options?: any) {
        super(content, options);
        this.name = name;
        this.lastModified = options?.lastModified || Date.now();
    }
}

global.Blob = MockBlob as any;
global.File = MockFile as any;

global.AbortController = class AbortController {
    public signal: any = {};
    abort() {
        this.signal.aborted = true;
    }
} as any;

