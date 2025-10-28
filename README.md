# ⚡ TurboPush

High-Performance Chunked File Upload Library for JavaScript/TypeScript

## 🚀 Quick Start

```bash
npm install
npm test
```

## 📖 Usage

```typescript
import { TurboPush } from './TurboPush';

const turbopush = new TurboPush({
    endpoint: '/upload-endpoint.php',
    chunkSize: 1024 * 1024,      // 1MB chunks
    maxConcurrentUploads: 5       // 5 parallel uploads
});

turbopush
    .addFiles(fileInput.files)
    .onProgress((progress) => {
        console.log(`Progress: ${progress[0].percentage}%`);
    })
    .push();
```

## 📊 Features

- ⚡ Parallel chunk uploads (10x+ faster)
- 🔄 Automatic retry logic
- 📈 Real-time progress tracking
- ⏸️ Pause/Resume capability
- 📦 Zero dependencies
- 🔒 TypeScript support

## 🧪 Testing

```bash
npm test              # Run all tests
npm run test:coverage # With coverage report
npm run test:watch    # Watch mode
```

## 📝 License

MIT