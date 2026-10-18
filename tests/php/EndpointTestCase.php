<?php

namespace TurboPush\Tests;

use PHPUnit\Framework\TestCase;
use TurboPush\TurboPushEndpoint;

/**
 * Shared helpers: a private sandbox directory per test and request builders.
 */
abstract class EndpointTestCase extends TestCase
{
    /** @var string */
    protected $root;

    /** @var string */
    protected $uploadDir;

    /** @var string */
    protected $tempDir;

    protected function setUp(): void {
        $this->root = sys_get_temp_dir() . '/turbopush-test-' . bin2hex(random_bytes(6));
        $this->uploadDir = $this->root . '/uploads/';
        $this->tempDir = $this->root . '/temp/';
        mkdir($this->root, 0700, true);
    }

    protected function tearDown(): void {
        self::removeTree($this->root);
    }

    protected function endpoint(): TestableEndpoint {
        return new TestableEndpoint($this->uploadDir, $this->tempDir);
    }

    /**
     * Sends one chunk as a multipart request.
     */
    protected function sendChunk(TurboPushEndpoint $endpoint, array $fields, string $content, array $fileOverrides = []): array {
        $tmp = tempnam($this->root, 'php');
        file_put_contents($tmp, $content);

        $files = ['file' => $fileOverrides + [
            'name' => 'blob',
            'type' => 'application/octet-stream',
            'tmp_name' => $tmp,
            'error' => UPLOAD_ERR_OK,
            'size' => strlen($content),
        ]];

        return $endpoint->processRequest(
            ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'multipart/form-data; boundary=x'],
            $fields,
            $files,
            ''
        );
    }

    /**
     * Sends a JSON action request.
     */
    protected function sendJson(TurboPushEndpoint $endpoint, array $data): array {
        return $endpoint->processRequest(
            ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'application/json'],
            [],
            [],
            json_encode($data)
        );
    }

    /**
     * Builds the form fields the client sends with a chunk.
     */
    protected function chunkFields(string $fileId, string $fileName, int $fileSize, int $totalChunks, int $chunkIndex): array {
        return [
            'fileId' => $fileId,
            'fileName' => $fileName,
            'fileSize' => (string) $fileSize,
            'totalChunks' => (string) $totalChunks,
            'chunkIndex' => (string) $chunkIndex,
        ];
    }

    /**
     * Uploads every chunk of $content, in $order if given.
     *
     * @return array[] One response per chunk
     */
    protected function sendAllChunks(TurboPushEndpoint $endpoint, string $fileId, string $fileName, string $content, int $chunkSize, ?array $order = null): array {
        $chunks = $content === '' ? [''] : str_split($content, $chunkSize);
        $total = count($chunks);
        $responses = [];
        foreach ($order ?? array_keys($chunks) as $index) {
            $responses[] = $this->sendChunk(
                $endpoint,
                $this->chunkFields($fileId, $fileName, strlen($content), $total, $index),
                $chunks[$index]
            );
        }
        return $responses;
    }

    /**
     * Sends a finalize request matching sendAllChunks().
     */
    protected function finalize(TurboPushEndpoint $endpoint, string $fileId, string $fileName, string $content, int $chunkSize): array {
        $total = $content === '' ? 1 : (int) ceil(strlen($content) / $chunkSize);
        return $this->sendJson($endpoint, [
            'action' => 'finalize',
            'fileId' => $fileId,
            'fileName' => $fileName,
            'fileSize' => strlen($content),
            'totalChunks' => $total,
        ]);
    }

    /**
     * Uploads and finalizes a whole file.
     */
    protected function upload(TurboPushEndpoint $endpoint, string $fileId, string $fileName, string $content, int $chunkSize = 4): array {
        foreach ($this->sendAllChunks($endpoint, $fileId, $fileName, $content, $chunkSize) as $response) {
            $this->assertSame(200, $response['status'], json_encode($response['body']));
        }
        return $this->finalize($endpoint, $fileId, $fileName, $content, $chunkSize);
    }

    /**
     * Lists files (recursively) under a directory, relative to it.
     *
     * @return string[]
     */
    protected static function listFiles(string $dir): array {
        if (!is_dir($dir)) {
            return [];
        }
        $files = [];
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            $files[] = substr($file->getPathname(), strlen(rtrim($dir, '/')) + 1);
        }
        sort($files);
        return $files;
    }

    protected static function removeTree(string $path): void {
        if (is_link($path) || is_file($path)) {
            @chmod($path, 0600);
            @unlink($path);
            return;
        }
        if (!is_dir($path)) {
            return;
        }
        @chmod($path, 0700);
        foreach (scandir($path) as $entry) {
            if ($entry !== '.' && $entry !== '..') {
                self::removeTree($path . '/' . $entry);
            }
        }
        @rmdir($path);
    }
}
