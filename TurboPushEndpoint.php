<?php
/**
 * TurboPush Server Endpoint
 *
 * Handles chunked file uploads from TurboPush client library
 *
 * @version 1.0.0
 * @license MIT
 */

class TurboPushEndpoint
{
    private $uploadDir = './uploads/';
    private $tempDir = './uploads/temp/';
    private $maxFileSize = 5368709120; // 5GB
    private $allowedExtensions = [];
    private $logFile = null;

    public function __construct($uploadDir = './uploads/', $tempDir = './uploads/temp/') {
        $this->uploadDir = rtrim($uploadDir, '/') . '/';
        $this->tempDir = rtrim($tempDir, '/') . '/';
        $this->ensureDirectory($this->uploadDir);
        $this->ensureDirectory($this->tempDir);
    }

    public function setMaxFileSize($bytes) {
        $this->maxFileSize = $bytes;
        return $this;
    }

    public function setAllowedExtensions($extensions) {
        $this->allowedExtensions = array_map('strtolower', $extensions);
        return $this;
    }

    public function enableLogging($logFile) {
        $this->logFile = $logFile;
        return $this;
    }

    public function handle() {
        try {
            $this->setCorsHeaders();

            if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
                http_response_code(200);
                exit;
            }

            $input = file_get_contents('php://input');
            $json = json_decode($input, true);

            if ($json && isset($json['action']) && $json['action'] === 'finalize') {
                $this->finalizeUpload($json);
            } else {
                $this->handleChunk();
            }
        } catch (Exception $e) {
            $this->log('ERROR: ' . $e->getMessage());
            $this->jsonResponse(false, $e->getMessage(), [], 400);
        }
    }

    private function handleChunk() {
        $this->validateChunkRequest();

        $fileName = $this->sanitizeFileName($_POST['fileName']);
        $fileId = $_POST['fileId'];
        $chunkIndex = (int)$_POST['chunkIndex'];
        $totalChunks = (int)$_POST['totalChunks'];
        $fileSize = (int)$_POST['fileSize'];

        $this->log("Receiving chunk $chunkIndex/$totalChunks for: $fileName");

        if ($fileSize > $this->maxFileSize) {
            throw new Exception("File size exceeds limit");
        }

        $this->validateFileExtension($fileName);

        $fileTempDir = $this->tempDir . $this->sanitizeFileName($fileId) . '/';
        $this->ensureDirectory($fileTempDir);

        $chunkPath = $fileTempDir . 'chunk_' . str_pad($chunkIndex, 10, '0', STR_PAD_LEFT);

        if (!move_uploaded_file($_FILES['file']['tmp_name'], $chunkPath)) {
            throw new Exception('Failed to save chunk');
        }

        $this->log("Chunk $chunkIndex saved");

        $this->jsonResponse(true, 'Chunk uploaded', [
            'chunkIndex' => $chunkIndex,
            'totalChunks' => $totalChunks
        ]);
    }

    private function finalizeUpload($data) {
        $fileName = $this->sanitizeFileName($data['fileName']);
        $fileId = $data['fileId'];
        $fileSize = $data['fileSize'];
        $totalChunks = $data['totalChunks'];

        $this->log("Finalizing: $fileName");

        $fileTempDir = $this->tempDir . $this->sanitizeFileName($fileId) . '/';

        if (!is_dir($fileTempDir)) {
            throw new Exception("Temp directory not found");
        }

        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $fileTempDir . 'chunk_' . str_pad($i, 10, '0', STR_PAD_LEFT);
            if (!file_exists($chunkPath)) {
                throw new Exception("Missing chunk: $i");
            }
        }

        $finalPath = $this->uploadDir . $fileName;

        if (file_exists($finalPath)) {
            $info = pathinfo($fileName);
            $finalPath = $this->uploadDir . $info['filename'] . '_' . time() .
                        (isset($info['extension']) ? '.' . $info['extension'] : '');
        }

        $finalFile = fopen($finalPath, 'wb');

        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $fileTempDir . 'chunk_' . str_pad($i, 10, '0', STR_PAD_LEFT);
            $chunk = fopen($chunkPath, 'rb');

            while (!feof($chunk)) {
                fwrite($finalFile, fread($chunk, 8192));
            }

            fclose($chunk);
            unlink($chunkPath);
        }

        fclose($finalFile);
        @rmdir($fileTempDir);

        $actualSize = filesize($finalPath);
        if ($actualSize !== $fileSize) {
            unlink($finalPath);
            throw new Exception("File size mismatch");
        }

        $this->log("Complete: $fileName");

        $this->jsonResponse(true, 'Upload complete', [
            'fileName' => basename($finalPath),
            'fileSize' => $actualSize
        ]);
    }

    private function validateChunkRequest() {
        if (!isset($_FILES['file'])) {
            throw new Exception('No file uploaded');
        }

        $required = ['fileName', 'fileId', 'chunkIndex', 'totalChunks', 'fileSize'];
        foreach ($required as $field) {
            if (!isset($_POST[$field])) {
                throw new Exception("Missing: $field");
            }
        }
    }

    private function validateFileExtension($fileName) {
        if (empty($this->allowedExtensions)) return;

        $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
        if (!in_array($ext, $this->allowedExtensions)) {
            throw new Exception("File type not allowed: .$ext");
        }
    }

    private function sanitizeFileName($fileName) {
        $fileName = basename($fileName);
        $fileName = preg_replace('/[^a-zA-Z0-9._-]/', '_', $fileName);

        if (strlen($fileName) > 255) {
            $ext = pathinfo($fileName, PATHINFO_EXTENSION);
            $name = substr($fileName, 0, 250 - strlen($ext));
            $fileName = $name . '.' . $ext;
        }

        return $fileName;
    }

    private function ensureDirectory($dir) {
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0755, true)) {
                throw new Exception("Failed to create dir: $dir");
            }
        }
    }

    private function setCorsHeaders() {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization');
    }

    private function log($message) {
        if ($this->logFile) {
            $timestamp = date('Y-m-d H:i:s');
            file_put_contents($this->logFile, "[$timestamp] $message\n", FILE_APPEND);
        }
    }

    private function jsonResponse($success, $message, $data = [], $httpCode = 200) {
        http_response_code($httpCode);
        header('Content-Type: application/json');
        echo json_encode([
            'success' => $success,
            'message' => $message,
            'data' => $data
        ]);
        exit;
    }
}

