<?php
/**
 * TurboPush Server Endpoint
 *
 * Handles chunked file uploads from the TurboPush JavaScript/TypeScript client library.
 * Receives file chunks, stores them temporarily, and merges them into final files.
 *
 * Features:
 * - Chunked upload handling
 * - Automatic file merging
 * - Size validation
 * - Extension filtering
 * - CORS support
 * - Optional logging
 *
 * @package    TurboPush
 * @version    1.0.0
 * @license    MIT
 * @author     TomGould
 *
 * @example
 * ```php
 * require_once 'TurboPushEndpoint.php';
 *
 * $turbopush = new TurboPushEndpoint('./uploads/', './uploads/temp/');
 * $turbopush
 *     ->setMaxFileSize(10 * 1024 * 1024 * 1024)  // 10GB
 *     ->setAllowedExtensions(['jpg', 'png', 'pdf'])
 *     ->enableLogging('./uploads/turbopush.log')
 *     ->handle();
 * ```
 */

/**
 * TurboPushEndpoint Class
 *
 * Main server-side handler for TurboPush chunked file uploads.
 * Manages chunk reception, storage, validation, and final file assembly.
 *
 * @class TurboPushEndpoint
 * @since 1.0.0
 */
class TurboPushEndpoint
{
    /**
     * Directory where final merged files are stored
     * @var string
     */
    private $uploadDir = './uploads/';

    /**
     * Directory where temporary chunk files are stored during upload
     * @var string
     */
    private $tempDir = './uploads/temp/';

    /**
     * Maximum allowed file size in bytes (default: 5GB)
     * @var int
     */
    private $maxFileSize = 5368709120; // 5GB

    /**
     * Array of allowed file extensions (empty array = all extensions allowed)
     * @var array
     */
    private $allowedExtensions = [];

    /**
     * Path to log file (null = logging disabled)
     * @var string|null
     */
    private $logFile = null;

    /**
     * Constructs a new TurboPushEndpoint instance
     *
     * Initializes upload and temporary directories, creating them if they don't exist.
     *
     * @param string $uploadDir Directory for final uploaded files (default: './uploads/')
     * @param string $tempDir   Directory for temporary chunk storage (default: './uploads/temp/')
     *
     * @throws Exception If directories cannot be created
     *
     * @example
     * ```php
     * $endpoint = new TurboPushEndpoint('./my-uploads/', './my-uploads/temp/');
     * ```
     */
    public function __construct($uploadDir = './uploads/', $tempDir = './uploads/temp/') {
        // Normalize directory paths with trailing slashes
        $this->uploadDir = rtrim($uploadDir, '/') . '/';
        $this->tempDir = rtrim($tempDir, '/') . '/';

        // Ensure directories exist
        $this->ensureDirectory($this->uploadDir);
        $this->ensureDirectory($this->tempDir);
    }

    /**
     * Sets the maximum allowed file size
     *
     * Files exceeding this size will be rejected during chunk upload.
     *
     * @param int $bytes Maximum file size in bytes
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->setMaxFileSize(10 * 1024 * 1024 * 1024); // 10GB
     * ```
     */
    public function setMaxFileSize($bytes) {
        $this->maxFileSize = $bytes;
        return $this;
    }

    /**
     * Sets allowed file extensions
     *
     * Only files with these extensions will be accepted.
     * Extensions are case-insensitive. Empty array allows all extensions.
     *
     * @param array $extensions Array of allowed extensions without dots (e.g., ['jpg', 'png'])
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->setAllowedExtensions(['jpg', 'png', 'pdf', 'zip']);
     * ```
     */
    public function setAllowedExtensions($extensions) {
        // Convert all extensions to lowercase for case-insensitive comparison
        $this->allowedExtensions = array_map('strtolower', $extensions);
        return $this;
    }

    /**
     * Enables logging to a file
     *
     * All upload activities will be logged with timestamps.
     *
     * @param string $logFile Path to log file
     * @return $this Fluent interface for method chaining
     *
     * @example
     * ```php
     * $endpoint->enableLogging('./logs/turbopush.log');
     * ```
     */
    public function enableLogging($logFile) {
        $this->logFile = $logFile;
        return $this;
    }

    /**
     * Main request handler
     *
     * Processes incoming requests and routes them to chunk upload or finalization.
     * Handles CORS preflight requests and error responses.
     *
     * This method should be called to handle incoming upload requests.
     *
     * @return void Outputs JSON response and exits
     *
     * @example
     * ```php
     * $endpoint = new TurboPushEndpoint();
     * $endpoint->handle(); // Process the current request
     * ```
     */
    public function handle() {
        try {
            // Set CORS headers for cross-origin requests
            $this->setCorsHeaders();

            // Handle CORS preflight requests
            if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
                http_response_code(200);
                exit;
            }

            // Read raw input for JSON finalization requests
            $input = file_get_contents('php://input');
            $json = json_decode($input, true);

            // Route request to appropriate handler
            if ($json && isset($json['action']) && $json['action'] === 'finalize') {
                // JSON request with action=finalize -> merge chunks
                $this->finalizeUpload($json);
            } else {
                // FormData request -> save chunk
                $this->handleChunk();
            }
        } catch (Exception $e) {
            // Log and return error response
            $this->log('ERROR: ' . $e->getMessage());
            $this->jsonResponse(false, $e->getMessage(), [], 400);
        }
    }

    /**
     * Handles individual chunk upload
     *
     * Validates the request, checks file size and extension, saves the chunk
     * to temporary storage with zero-padded naming for proper ordering.
     *
     * @return void Outputs JSON response and exits
     * @throws Exception If validation fails or chunk cannot be saved
     *
     * @private
     */
    private function handleChunk() {
        // Validate required fields and file upload
        $this->validateChunkRequest();

        // Extract and sanitize metadata from POST
        $fileName = $this->sanitizeFileName($_POST['fileName']);
        $fileId = $_POST['fileId'];
        $chunkIndex = (int)$_POST['chunkIndex'];
        $totalChunks = (int)$_POST['totalChunks'];
        $fileSize = (int)$_POST['fileSize'];

        $this->log("Receiving chunk $chunkIndex/$totalChunks for: $fileName");

        // Validate file size doesn't exceed limit
        if ($fileSize > $this->maxFileSize) {
            throw new Exception("File size exceeds limit");
        }

        // Validate file extension if restrictions are set
        $this->validateFileExtension($fileName);

        // Create temporary directory for this file's chunks
        $fileTempDir = $this->tempDir . $this->sanitizeFileName($fileId) . '/';
        $this->ensureDirectory($fileTempDir);

        // Generate chunk filename with zero-padding for proper sorting
        // Example: chunk_0000000003 for chunk index 3
        $chunkPath = $fileTempDir . 'chunk_' . str_pad($chunkIndex, 10, '0', STR_PAD_LEFT);

        // Move uploaded chunk from temp location to final chunk path
        if (!move_uploaded_file($_FILES['file']['tmp_name'], $chunkPath)) {
            throw new Exception('Failed to save chunk');
        }

        $this->log("Chunk $chunkIndex saved");

        // Return success response
        $this->jsonResponse(true, 'Chunk uploaded', [
            'chunkIndex' => $chunkIndex,
            'totalChunks' => $totalChunks
        ]);
    }

    /**
     * Finalizes upload by merging all chunks into final file
     *
     * Verifies all chunks are present, merges them in order, validates
     * final file size, and cleans up temporary files.
     *
     * @param array $data Finalization request data containing:
     *                    - fileName: Name of the final file
     *                    - fileId: Unique upload identifier
     *                    - fileSize: Expected final file size
     *                    - totalChunks: Total number of chunks
     *
     * @return void Outputs JSON response and exits
     * @throws Exception If chunks are missing, merge fails, or size mismatch
     *
     * @private
     */
    private function finalizeUpload($data) {
        // Extract finalization data
        $fileName = $this->sanitizeFileName($data['fileName']);
        $fileId = $data['fileId'];
        $fileSize = $data['fileSize'];
        $totalChunks = $data['totalChunks'];

        $this->log("Finalizing: $fileName");

        // Locate temporary directory containing chunks
        $fileTempDir = $this->tempDir . $this->sanitizeFileName($fileId) . '/';

        if (!is_dir($fileTempDir)) {
            throw new Exception("Temp directory not found");
        }

        // Verify all chunks are present before merging
        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $fileTempDir . 'chunk_' . str_pad($i, 10, '0', STR_PAD_LEFT);
            if (!file_exists($chunkPath)) {
                throw new Exception("Missing chunk: $i");
            }
        }

        // Determine final file path (add timestamp if file exists)
        $finalPath = $this->uploadDir . $fileName;

        if (file_exists($finalPath)) {
            // File already exists - append timestamp to make unique
            $info = pathinfo($fileName);
            $finalPath = $this->uploadDir . $info['filename'] . '_' . time() .
                        (isset($info['extension']) ? '.' . $info['extension'] : '');
        }

        // Open final file for writing
        $finalFile = fopen($finalPath, 'wb');

        // Merge all chunks in order
        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $fileTempDir . 'chunk_' . str_pad($i, 10, '0', STR_PAD_LEFT);
            $chunk = fopen($chunkPath, 'rb');

            // Stream chunk data to final file (8KB buffer)
            while (!feof($chunk)) {
                fwrite($finalFile, fread($chunk, 8192));
            }

            // Close and delete the chunk file
            fclose($chunk);
            unlink($chunkPath);
        }

        // Close final file
        fclose($finalFile);

        // Clean up temporary directory
        @rmdir($fileTempDir);

        // Verify final file size matches expected size
        $actualSize = filesize($finalPath);
        if ($actualSize !== $fileSize) {
            // Size mismatch - delete corrupted file
            unlink($finalPath);
            throw new Exception("File size mismatch");
        }

        $this->log("Complete: $fileName");

        // Return success response with file information
        $this->jsonResponse(true, 'Upload complete', [
            'fileName' => basename($finalPath),
            'fileSize' => $actualSize
        ]);
    }

    /**
     * Validates chunk upload request
     *
     * Ensures the request contains a file upload and all required POST fields.
     *
     * @return void
     * @throws Exception If validation fails
     *
     * @private
     */
    private function validateChunkRequest() {
        // Check for uploaded file
        if (!isset($_FILES['file'])) {
            throw new Exception('No file uploaded');
        }

        // Check for required POST fields
        $required = ['fileName', 'fileId', 'chunkIndex', 'totalChunks', 'fileSize'];
        foreach ($required as $field) {
            if (!isset($_POST[$field])) {
                throw new Exception("Missing: $field");
            }
        }
    }

    /**
     * Validates file extension against allowed list
     *
     * Only checks if allowedExtensions is not empty.
     * Extensions are compared case-insensitively.
     *
     * @param string $fileName Name of file to validate
     * @return void
     * @throws Exception If file extension is not allowed
     *
     * @private
     */
    private function validateFileExtension($fileName) {
        // Skip validation if no restrictions set
        if (empty($this->allowedExtensions)) return;

        // Extract and check extension
        $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
        if (!in_array($ext, $this->allowedExtensions)) {
            throw new Exception("File type not allowed: .$ext");
        }
    }

    /**
     * Sanitizes filename for safe filesystem storage
     *
     * Removes directory traversal attempts, special characters, and
     * truncates long filenames while preserving extension.
     *
     * @param string $fileName Original filename
     * @return string Sanitized filename safe for storage
     *
     * @private
     */
    private function sanitizeFileName($fileName) {
        // Remove directory components (prevent traversal attacks)
        $fileName = basename($fileName);

        // Replace special characters with underscores (keep alphanumeric, dot, dash)
        $fileName = preg_replace('/[^a-zA-Z0-9._-]/', '_', $fileName);

        // Truncate long filenames to 255 characters (filesystem limit)
        if (strlen($fileName) > 255) {
            $ext = pathinfo($fileName, PATHINFO_EXTENSION);
            $name = substr($fileName, 0, 250 - strlen($ext));
            $fileName = $name . '.' . $ext;
        }

        return $fileName;
    }

    /**
     * Ensures a directory exists, creating it if necessary
     *
     * Creates directory with proper permissions (0755) and parent directories.
     *
     * @param string $dir Directory path to ensure exists
     * @return void
     * @throws Exception If directory cannot be created
     *
     * @private
     */
    private function ensureDirectory($dir) {
        if (!is_dir($dir)) {
            // Create directory with parents, 0755 permissions
            if (!mkdir($dir, 0755, true)) {
                throw new Exception("Failed to create dir: $dir");
            }
        }
    }

    /**
     * Sets CORS headers for cross-origin requests
     *
     * Allows requests from any origin (adjust for production security).
     *
     * @return void
     *
     * @private
     */
    private function setCorsHeaders() {
        // WARNING: Allow-Origin: * is permissive. Restrict in production.
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
    }

    /**
     * Logs a message to the log file with timestamp
     *
     * Only logs if logging is enabled via enableLogging().
     *
     * @param string $message Message to log
     * @return void
     *
     * @private
     */
    private function log($message) {
        if ($this->logFile) {
            $timestamp = date('Y-m-d H:i:s');
            file_put_contents($this->logFile, "[$timestamp] $message\n", FILE_APPEND);
        }
    }

    /**
     * Sends a JSON response and exits
     *
     * Sets appropriate headers, HTTP status code, and outputs JSON.
     *
     * @param bool   $success  Whether the operation was successful
     * @param string $message  Human-readable message
     * @param array  $data     Additional data to include in response
     * @param int    $httpCode HTTP status code (default: 200)
     * @return void Outputs JSON and exits script
     *
     * @private
     */
    private function jsonResponse($success, $message, $data = [], $httpCode = 200) {
        // Set HTTP status code
        http_response_code($httpCode);

        // Set JSON content type
        header('Content-Type: application/json');

        // Output JSON response
        echo json_encode([
            'success' => $success,
            'message' => $message,
            'data' => $data
        ]);

        // Exit to prevent further output
        exit;
    }
}