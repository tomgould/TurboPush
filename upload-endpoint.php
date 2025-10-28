<?php
/**
 * Chunked File Upload Endpoint
 * 
 * Receives file chunks from FileUploader and reassembles them
 * Mirrors the scraper.class.php functionality but for uploads
 */

class ChunkedUploadHandler
{
    private $uploadDir = './uploads/';
    private $tempDir = './uploads/temp/';
    private $maxFileSize = 5368709120; // 5GB
    private $allowedExtensions = []; // Empty = allow all
    
    public function __construct($uploadDir = './uploads/', $tempDir = './uploads/temp/')
    {
        $this->uploadDir = rtrim($uploadDir, '/') . '/';
        $this->tempDir = rtrim($tempDir, '/') . '/';
        
        // Create directories if they don't exist
        if (!is_dir($this->uploadDir)) {
            mkdir($this->uploadDir, 0755, true);
        }
        if (!is_dir($this->tempDir)) {
            mkdir($this->tempDir, 0755, true);
        }
    }
    
    /**
     * Set maximum file size in bytes
     */
    public function setMaxFileSize($bytes)
    {
        $this->maxFileSize = $bytes;
        return $this;
    }
    
    /**
     * Set allowed file extensions
     */
    public function setAllowedExtensions($extensions)
    {
        $this->allowedExtensions = $extensions;
        return $this;
    }
    
    /**
     * Handle the upload request
     */
    public function handle()
    {
        try {
            // Check if this is a finalize request
            $input = file_get_contents('php://input');
            $json = json_decode($input, true);
            
            if ($json && isset($json['action']) && $json['action'] === 'finalize') {
                return $this->finalizeUpload($json);
            }
            
            // Otherwise, handle chunk upload
            return $this->handleChunk();
            
        } catch (Exception $e) {
            return $this->jsonResponse(false, $e->getMessage());
        }
    }
    
    /**
     * Handle a single chunk upload
     */
    private function handleChunk()
    {
        // Validate request
        if (!isset($_FILES['file']) || !isset($_POST['fileName']) || 
            !isset($_POST['fileId']) || !isset($_POST['chunkIndex'])) {
            throw new Exception('Missing required parameters');
        }
        
        $fileName = basename($_POST['fileName']);
        $fileId = $_POST['fileId'];
        $chunkIndex = (int)$_POST['chunkIndex'];
        $totalChunks = (int)$_POST['totalChunks'];
        $fileSize = (int)$_POST['fileSize'];
        
        // Validate file size
        if ($fileSize > $this->maxFileSize) {
            throw new Exception('File size exceeds maximum allowed size');
        }
        
        // Validate file extension
        if (!empty($this->allowedExtensions)) {
            $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
            if (!in_array($ext, $this->allowedExtensions)) {
                throw new Exception('File type not allowed');
            }
        }
        
        // Create temp directory for this file
        $fileTempDir = $this->tempDir . $this->sanitizeFileName($fileId) . '/';
        if (!is_dir($fileTempDir)) {
            mkdir($fileTempDir, 0755, true);
        }
        
        // Save chunk
        $chunkPath = $fileTempDir . 'chunk_' . $chunkIndex;
        
        if (!move_uploaded_file($_FILES['file']['tmp_name'], $chunkPath)) {
            throw new Exception('Failed to save chunk');
        }
        
        return $this->jsonResponse(true, 'Chunk uploaded successfully', [
            'chunkIndex' => $chunkIndex,
            'totalChunks' => $totalChunks
        ]);
    }
    
    /**
     * Finalize upload by reassembling chunks
     */
    private function finalizeUpload($data)
    {
        $fileName = basename($data['fileName']);
        $fileId = $data['fileId'];
        $fileSize = $data['fileSize'];
        $totalChunks = $data['totalChunks'];
        
        $fileTempDir = $this->tempDir . $this->sanitizeFileName($fileId) . '/';
        
        // Check if all chunks exist
        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $fileTempDir . 'chunk_' . $i;
            if (!file_exists($chunkPath)) {
                throw new Exception("Missing chunk: $i");
            }
        }
        
        // Create final file path
        $finalPath = $this->uploadDir . $this->sanitizeFileName($fileName);
        
        // If file exists, add timestamp to make it unique
        if (file_exists($finalPath)) {
            $info = pathinfo($fileName);
            $finalPath = $this->uploadDir . $info['filename'] . '_' . time() . 
                        (isset($info['extension']) ? '.' . $info['extension'] : '');
        }
        
        // Reassemble chunks
        $finalFile = fopen($finalPath, 'wb');
        
        for ($i = 0; $i < $totalChunks; $i++) {
            $chunkPath = $fileTempDir . 'chunk_' . $i;
            $chunk = fopen($chunkPath, 'rb');
            
            while (!feof($chunk)) {
                fwrite($finalFile, fread($chunk, 8192));
            }
            
            fclose($chunk);
            unlink($chunkPath); // Delete chunk after merging
        }
        
        fclose($finalFile);
        
        // Remove temp directory
        rmdir($fileTempDir);
        
        // Verify file size
        $actualSize = filesize($finalPath);
        if ($actualSize !== $fileSize) {
            unlink($finalPath);
            throw new Exception("File size mismatch. Expected: $fileSize, Got: $actualSize");
        }
        
        return $this->jsonResponse(true, 'Upload completed successfully', [
            'fileName' => basename($finalPath),
            'filePath' => $finalPath,
            'fileSize' => $actualSize
        ]);
    }
    
    /**
     * Sanitize filename
     */
    private function sanitizeFileName($fileName)
    {
        return preg_replace('/[^a-zA-Z0-9._-]/', '_', $fileName);
    }
    
    /**
     * Send JSON response
     */
    private function jsonResponse($success, $message, $data = [])
    {
        header('Content-Type: application/json');
        echo json_encode([
            'success' => $success,
            'message' => $message,
            'data' => $data
        ]);
        exit;
    }
}

// Usage example
$handler = new ChunkedUploadHandler('./uploads/', './uploads/temp/');
$handler->setMaxFileSize(5 * 1024 * 1024 * 1024) // 5GB
        ->setAllowedExtensions(['jpg', 'png', 'pdf', 'zip', 'mp4']) // Optional
        ->handle();

