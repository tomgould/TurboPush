// Built by `npm run build`
import { TurboPush } from '../dist/esm/TurboPush.js';

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const pauseBtn = document.getElementById('pauseBtn');
const cancelBtn = document.getElementById('cancelBtn');
const simulateFailures = document.getElementById('simulateFailures');
const resumable = document.getElementById('resumable');
const progressList = document.getElementById('progressList');
const eventLog = document.getElementById('eventLog');
const statsContainer = document.getElementById('stats');
const totalFilesEl = document.getElementById('totalFiles');
const completedFilesEl = document.getElementById('completedFiles');
const failedFilesEl = document.getElementById('failedFiles');
const overallProgressEl = document.getElementById('overallProgress');
const avgSpeedEl = document.getElementById('avgSpeed');

// State
let uploader = null;
let isPaused = false;

// Initialize TurboPush instance
function initUploader() {
    uploader = new TurboPush({
        endpoint: 'upload.php' + (simulateFailures.checked ? '?simulateFailures=1' : ''),
        chunkSize: 1024 * 1024,        // 1MB chunks (PHP's default upload limit is 2MB)
        maxConcurrentUploads: 4,       // 4 chunk requests at a time
        maxRetries: 3,                 // Retry failed chunks 3 times
        retryDelay: 1000,              // 1s before the first retry, then 2s, 4s
        resumable: resumable.checked   // Continue after a page reload
    });

    // Register callbacks
    uploader
        .onProgress(handleProgress)
        .onFileComplete(handleFileComplete)
        .onComplete(handleComplete)
        .onError(handleError)
        .onRetry(handleRetry);
}

// Format bytes to human readable
function formatBytes(bytes, decimals = 2) {
    if (!bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format seconds to human readable time
function formatTime(seconds) {
    if (seconds === 0 || !isFinite(seconds)) return '--';
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

// Add a line to the event log
function logEvent(message) {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    eventLog.appendChild(line);
    eventLog.scrollTop = eventLog.scrollHeight;
}

// Create progress element for a file (textContent only: file names are user input)
function createProgressElement(progress) {
    const div = document.createElement('div');
    div.className = 'file-progress';
    div.id = `file-${progress.fileId}`;

    div.innerHTML = `
        <div class="file-name"></div>
        <div class="progress-bar-container">
            <div class="progress-bar" style="width: 0%">0%</div>
        </div>
        <div class="file-details">
            <span>
                <span class="status status-pending">Pending</span>
                <span class="file-size"></span>
            </span>
            <span class="file-speed">0 B/s | ETA: --</span>
        </div>
    `;
    div.querySelector('.file-name').textContent = progress.fileName;
    div.querySelector('.file-size').textContent = formatBytes(progress.totalSize);

    return div;
}

// Update progress element
function updateProgressElement(progress) {
    const element = document.getElementById(`file-${progress.fileId}`);
    if (!element) return;

    const progressBar = element.querySelector('.progress-bar');
    const status = element.querySelector('.status');
    const speed = element.querySelector('.file-speed');

    // Update progress bar
    const percentage = Math.round(progress.percentage);
    progressBar.style.width = `${percentage}%`;
    progressBar.textContent = `${percentage}%`;

    // Update status class
    progressBar.className = `progress-bar ${progress.status}`;
    status.className = `status status-${progress.status}`;
    status.textContent = progress.status;

    // Update speed and ETA
    if (progress.status === 'uploading') {
        speed.textContent = `${formatBytes(progress.speed)}/s | ETA: ${formatTime(progress.remainingTime)}`;
    } else if (progress.status === 'completed') {
        speed.textContent = 'Upload complete!';
        if (progress.result && progress.result.fileName && !element.querySelector('.stored-name')) {
            const stored = document.createElement('div');
            stored.className = 'stored-name';
            stored.textContent = `Stored as ${progress.result.fileName}`;
            element.appendChild(stored);
        }
    } else if (progress.status === 'failed') {
        speed.textContent = 'Upload failed';
        let errorMsg = element.querySelector('.error-message');
        if (!errorMsg) {
            errorMsg = document.createElement('div');
            errorMsg.className = 'error-message';
            element.appendChild(errorMsg);
        }
        errorMsg.textContent = progress.error || 'Unknown error';
    } else if (progress.status === 'paused') {
        speed.textContent = 'Paused';
    }
}

// Handle progress updates
function handleProgress(progressArray) {
    progressArray.forEach(progress => {
        // Create element if it doesn't exist
        if (!document.getElementById(`file-${progress.fileId}`)) {
            progressList.appendChild(createProgressElement(progress));
        }

        // Update element
        updateProgressElement(progress);
    });

    // Update overall stats
    const stats = uploader.getStats();
    totalFilesEl.textContent = stats.totalFiles;
    completedFilesEl.textContent = stats.completedFiles;
    failedFilesEl.textContent = stats.failedFiles;

    const overallPercentage = stats.totalBytes > 0
        ? Math.round((stats.uploadedBytes / stats.totalBytes) * 100)
        : 0;
    overallProgressEl.textContent = `${overallPercentage}%`;

    // Calculate current speed from active uploads
    const currentSpeed = progressArray
        .filter(p => p.status === 'uploading')
        .reduce((total, p) => total + p.speed, 0);
    avgSpeedEl.textContent = `${formatBytes(currentSpeed)}/s`;
}

// Handle individual file completion
function handleFileComplete(fileName, fileId, result) {
    logEvent(`Completed ${fileName}` + (result.fileName && result.fileName !== fileName ? ` (stored as ${result.fileName})` : ''));
}

// Handle all uploads complete
function handleComplete(stats) {
    logEvent(`All done: ${stats.completedFiles} of ${stats.totalFiles} file(s) uploaded in ${Math.round(stats.duration)}s`);

    // Update final stats
    avgSpeedEl.textContent = stats.averageSpeed
        ? `${formatBytes(stats.averageSpeed)}/s (avg)`
        : '0 B/s';

    // Update button states: failed files can be retried with push()
    uploadBtn.textContent = stats.failedFiles > 0 ? 'Retry Failed' : 'Upload Files';
    uploadBtn.disabled = stats.failedFiles === 0;
    pauseBtn.disabled = true;
    cancelBtn.disabled = stats.failedFiles === 0;
    fileInput.disabled = false;
}

// Handle upload errors
function handleError(error, fileName) {
    logEvent(`Failed ${fileName}: ${error.message}` + (error.status ? ` (HTTP ${error.status})` : ''));
}

// Handle retries
function handleRetry(info) {
    const what = info.chunkIndex === null ? 'finalize' : `chunk ${info.chunkIndex}`;
    logEvent(`${info.fileName}: ${what} failed (${info.error.message}), retry ${info.attempt} in ${info.delay}ms`);
}

// Event Listeners
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        uploader = null;
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload Files';
        progressList.innerHTML = '';
        eventLog.innerHTML = '';
        statsContainer.style.display = 'none';
    }
});

uploadBtn.addEventListener('click', async () => {
    const files = fileInput.files;
    if (!uploader && files.length === 0) {
        alert('Please select files to upload');
        return;
    }

    // Initialize uploader and add files (a second click retries failed files)
    if (!uploader) {
        initUploader();
        uploader.addFiles(files);
    }

    // Update UI
    statsContainer.style.display = 'block';
    uploadBtn.disabled = true;
    pauseBtn.disabled = false;
    cancelBtn.disabled = false;
    fileInput.disabled = true;

    // Start upload
    try {
        await uploader.push();
    } catch (error) {
        logEvent(`Upload error: ${error.message}`);
    }
});

pauseBtn.addEventListener('click', async () => {
    if (!uploader) return;

    if (isPaused) {
        // Resume
        pauseBtn.textContent = 'Pause';
        isPaused = false;
        logEvent('Resumed');
        await uploader.resume();
    } else {
        // Pause
        uploader.pause();
        pauseBtn.textContent = 'Resume';
        isPaused = true;
        logEvent('Paused');
    }
});

cancelBtn.addEventListener('click', () => {
    if (!uploader) return;

    if (confirm('Are you sure you want to cancel all uploads?')) {
        uploader.cancel();
        uploader = null;

        // Reset UI
        progressList.innerHTML = '';
        statsContainer.style.display = 'none';
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Upload Files';
        pauseBtn.disabled = true;
        cancelBtn.disabled = true;
        fileInput.disabled = false;
        fileInput.value = '';
        isPaused = false;
        pauseBtn.textContent = 'Pause';
        logEvent('Cancelled');
    }
});
