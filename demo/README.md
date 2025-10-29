# TurboPush Demo

This demo shows TurboPush in action with a functional HTML upload form.

## Files

- `index.html` - The main upload form UI
- `demo.js` - Demo application logic
- `TurboPush.js` - Compiled JavaScript version of TurboPush for browser use

## How to Use

1. Start a web server in the project root directory:
```bash
   # Using PHP
   php -S localhost:8000

   # Using Python
   python -m http.server 8000

   # Using Node.js
   npx http-server -p 8000
```

2. Open your browser to: `http://localhost:8000/demo/`

3. Select one or multiple files

4. Click "Upload Files" to start the upload

5. Use "Pause" to pause uploads, "Resume" to continue

6. Use "Cancel" to abort all uploads

## Features

- ✅ Single and multiple file uploads
- ✅ Real-time progress (percentage, speed, ETA)
- ✅ Pause/Resume functionality
- ✅ Individual file tracking
- ✅ Overall statistics
- ✅ Error handling with visual feedback

## Notes

- The demo uses the compiled JavaScript version (`TurboPush.js`) instead of the TypeScript source
- Uploads are sent to `../examples/upload-endpoint.php`
- Make sure the upload directories have write permissions