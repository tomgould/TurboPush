import { TurboPush } from './TurboPush.js';

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const pauseBtn = document.getElementById('pauseBtn');
const cancelBtn = document.getElementById('cancelBtn');
const progressList = document.getElementById('progressList');
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
        endpoint: '../examples/upload-endpoint.php',
        chunkSize: 1024 * 1024,        // 1MB chunks
        maxConcurrentUploads: 5,       // 5 parallel uploads
        maxRetries: 3,                 // Retry failed chunks 3 times
        retryDelay: 1000               // 1s between retries
    });

    // Register callbacks
    uploader
        .onProgress(handleProgress)
        .onFileComplete(handleFileComplete)
        .onComplete(handleComplete)
        .onError(handleError);
}

// Format bytes to human readable
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
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

// Create progress element for a file
function createProgressElement(progress) {
    const div = document.createElement('div');
    div.className = 'file-progress';
    div.id = `file-${progress.fileId}`;

    div.innerHTML = `
        <div class="file-name">${progress.fileName}</div>
        <div class="progress-bar-container">
            <div class="progress-bar" style="width: 0%">0%</div>
        </div>
        <div class="file-details">
            <span>
                <span class="status status-pending">Pending</span>
                <span class="file-size">${formatBytes(progress.totalSize)}</span>
            </span>
            <span class="file-speed">0 B/s | ETA: --</span>
        </div>
    `;

    return div;
}

// Update progress element
function updateProgressElement(progress) {
    const element = document.getElementById(`file-${progress.fileId}`);
    if (!element) return;

    const progressBar = element.querySelector('.progress-bar');
    const status = element.querySelector('.status');
    const speed = element.querySelector('.file-speed');
    const errorMsg = element.querySelector('.error-message');

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
    } else if (progress.status === 'failed') {
        speed.textContent = 'Upload failed';
        if (progress.error && !errorMsg) {
            const error = document.createElement('div');
            error.className = 'error-message';
            error.textContent = progress.error;
            element.querySelector('.file-details').appendChild(error);
        }
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

    // Calculate current average speed from active uploads
    let totalSpeed = 0;
    let activeCount = 0;
    progressArray.forEach(p => {
        if (p.status === 'uploading' && p.speed > 0) {
            totalSpeed += p.speed;
            activeCount++;
        }
    });
    const currentSpeed = activeCount > 0 ? totalSpeed : 0;
    avgSpeedEl.textContent = `${formatBytes(currentSpeed)}/s`;
}

// Handle individual file completion
function handleFileComplete(fileName, fileId) {
    console.log(`✓ Completed: ${fileName}`);
}

// Handle all uploads complete
function handleComplete(stats) {
    console.log('All uploads complete!', stats);

    // Update final stats
    avgSpeedEl.textContent = stats.averageSpeed
        ? `${formatBytes(stats.averageSpeed)}/s (avg)`
        : '0 B/s';

    // Update button states
    uploadBtn.disabled = true;
    pauseBtn.disabled = true;
    cancelBtn.disabled = true;

    // Alert user
    alert(`Upload complete!\n${stats.completedFiles} of ${stats.totalFiles} files uploaded successfully.\nTotal time: ${Math.round(stats.duration)}s`);
}

// Handle upload errors
function handleError(error, fileName, fileId) {
    console.error(`✗ Failed: ${fileName}`, error);
}

// Event Listeners
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        uploadBtn.disabled = false;
        progressList.innerHTML = '';
        statsContainer.style.display = 'none';
    }
});

uploadBtn.addEventListener('click', async () => {
    const files = fileInput.files;
    if (files.length === 0) {
        alert('Please select files to upload');
        return;
    }

    // Initialize uploader and add files
    initUploader();
    uploader.addFiles(files);

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
        console.error('Upload error:', error);
    }
});

pauseBtn.addEventListener('click', async () => {
    if (!uploader) return;

    if (isPaused) {
        // Resume
        pauseBtn.textContent = 'Pause';
        pauseBtn.disabled = true; // Disable during resume
        await uploader.resume();
        pauseBtn.disabled = false;
        isPaused = false;
    } else {
        // Pause
        uploader.pause();
        pauseBtn.textContent = 'Resume';
        isPaused = true;
    }
});

cancelBtn.addEventListener('click', () => {
    if (!uploader) return;

    if (confirm('Are you sure you want to cancel all uploads?')) {
        uploader.cancel();

        // Reset UI
        progressList.innerHTML = '';
        statsContainer.style.display = 'none';
        uploadBtn.disabled = true;
        pauseBtn.disabled = true;
        cancelBtn.disabled = true;
        fileInput.disabled = false;
        fileInput.value = '';
        isPaused = false;
        pauseBtn.textContent = 'Pause';
    }
});

