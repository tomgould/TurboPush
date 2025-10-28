# ⚡ TurboPush

High-performance chunked file upload library for JavaScript/TypeScript with parallel uploads, automatic retries, and real-time progress tracking.

## ✨ Features

- ⚡ **Blazing Fast** - Parallel chunk uploads (10x+ faster than sequential)
- 🔄 **Auto Retry** - Configurable retry logic with exponential backoff
- 📈 **Real-time Progress** - Track speed, percentage, and remaining time
- ⏸️ **Pause/Resume** - Full control over upload state
- 🎯 **TypeScript** - Complete type definitions included
- 📦 **Zero Dependencies** - No external dependencies required
- 🔒 **Production Ready** - Thoroughly tested with 60+ unit & integration tests
- 🌐 **Universal** - Works in browser and Node.js environments

## 📦 Installation

```bash
npm install
```

## 🚀 Quick Start

### Client-Side

```typescript
import { TurboPush } from './TurboPush';

const turbopush = new TurboPush({
    endpoint: '/api/upload',
    chunkSize: 1024 * 1024,           // 1MB chunks
    maxConcurrentUploads: 5,          // 5 parallel uploads
    maxRetries: 3,                    // Retry failed chunks 3 times
    retryDelay: 1000                  // Wait 1s between retries
});

turbopush
    .addFiles(fileInput.files)
    .onProgress((progress) => {
        progress.forEach(p => {
            console.log(`${p.fileName}: ${p.percentage}% at ${p.speed} bytes/s`);
        });
    })
    .onComplete((stats) => {
        console.log(`Uploaded ${stats.completedFiles} files in ${stats.duration}s`);
    })
    .onError((error, fileName) => {
        console.error(`Failed to upload ${fileName}:`, error);
    })
    .push();
```

### Server-Side (PHP)

```php
<?php
require_once 'TurboPushEndpoint.php';

$turbopush = new TurboPushEndpoint('./uploads/', './uploads/temp/');
$turbopush
    ->setMaxFileSize(10 * 1024 * 1024 * 1024)  // 10GB max
    ->setAllowedExtensions(['jpg', 'png', 'pdf', 'zip', 'mp4'])
    ->enableLogging('./uploads/turbopush.log')
    ->handle();
```

See `examples/upload-endpoint.php` for a complete example.

## 📖 API Reference

### Constructor

```typescript
new TurboPush(config: TurboPushConfig)
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | *required* | Upload endpoint URL |
| `chunkSize` | number | 1048576 | Chunk size in bytes (1MB) |
| `maxConcurrentUploads` | number | 3 | Max parallel uploads (1-10) |
| `maxRetries` | number | 3 | Max retry attempts per chunk |
| `retryDelay` | number | 1000 | Delay between retries (ms) |
| `timeout` | number | 30000 | Request timeout (ms) |
| `headers` | object | {} | Custom HTTP headers |
| `withCredentials` | boolean | false | Include credentials in requests |

### Methods

#### File Management

```typescript
addFile(file: File): TurboPush
addFiles(files: File[] | FileList): TurboPush
```

Add file(s) to the upload queue.

#### Upload Control

```typescript
push(): Promise<UploadStats>
upload(): Promise<UploadStats>  // Alias for push()
pause(): void
resume(): Promise<void>
cancel(): void
```

Control the upload process.

#### Event Callbacks

```typescript
onProgress(callback: (progress: UploadProgress[]) => void): TurboPush
onFileComplete(callback: (fileName: string, fileId: string) => void): TurboPush
onComplete(callback: (stats: UploadStats) => void): TurboPush
onError(callback: (error: Error, fileName: string, fileId: string) => void): TurboPush
```

Register event handlers.

#### Configuration

```typescript
setChunkSize(bytes: number): TurboPush
setMaxConcurrentUploads(count: number): TurboPush
setMaxRetries(count: number): TurboPush
```

Update configuration after instantiation.

#### Information

```typescript
getStats(): UploadStats
getProgress(): UploadProgress[]
getFileProgress(fileName: string): UploadProgress | undefined
isPausedState(): boolean
getQueueSize(): number
```

Get current upload state and statistics.

### Types

```typescript
interface UploadProgress {
    file: File;
    fileName: string;
    fileId: string;
    totalSize: number;
    uploadedSize: number;
    percentage: number;
    speed: number;              // bytes/second
    remainingTime: number;      // seconds
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'paused';
    error?: string;
}

interface UploadStats {
    totalFiles: number;
    completedFiles: number;
    failedFiles: number;
    totalBytes: number;
    uploadedBytes: number;
    startTime: number;
    endTime?: number;
    duration?: number;          // seconds
    averageSpeed?: number;      // bytes/second
}
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

**Test Coverage:**
- ✅ 60+ unit tests
- ✅ 10+ integration tests
- ✅ 80%+ code coverage
- ✅ Zero dependencies mock server

## 📁 Project Structure

```
TurboPush/
├── TurboPush.ts                      # Main client library
├── TurboPushEndpoint.php             # PHP server endpoint
├── examples/
│   └── upload-endpoint.php           # Example implementation
├── tests/
│   ├── TurboPush.test.ts            # Unit tests
│   ├── TurboPush.integration.test.ts # Integration tests
│   ├── mocks/
│   │   └── MockServer.ts            # Test mock server
│   ├── setup.ts                     # Test environment setup
│   └── README.md                    # Testing documentation
├── jest.config.js                   # Jest configuration
├── tsconfig.json                    # TypeScript configuration
└── package.json                     # Project metadata
```

## 🎯 Use Cases

- **Large File Uploads** - Handle multi-GB files with ease
- **Multiple File Uploads** - Upload dozens of files concurrently
- **Unreliable Networks** - Automatic retry for failed chunks
- **User Experience** - Show accurate progress and time estimates
- **Resume Functionality** - Pause and resume long uploads
- **Production Apps** - Battle-tested with comprehensive test suite

## 🔧 Server Requirements

- **PHP 7.0+** for the server endpoint
- Modern browser with `fetch` API support
- Or Node.js 18+ for server-side usage

## 🤝 Contributing

Contributions are welcome! Please ensure:

1. All tests pass (`npm test`)
2. Code follows existing style
3. Add tests for new features
4. Update documentation

## 📝 License

MIT License - see LICENSE file for details

## 🙋 Support

- 📖 Check the [test documentation](tests/README.md) for more examples
- 🐛 Report issues on GitHub
- 💡 Feature requests welcome

---

**Made with ⚡ by developers, for developers**