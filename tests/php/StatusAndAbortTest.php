<?php

namespace TurboPush\Tests;

/**
 * The status action (for resuming) and the abort action (for cancelling).
 */
class StatusAndAbortTest extends EndpointTestCase
{
    public function testStatusListsTheChunksAlreadyStored(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'part', 'a.txt', 'aaaabbbbccccdd', 4, [3, 0, 2]);

        $response = $this->sendJson($endpoint, ['action' => 'status', 'fileId' => 'part']);

        $this->assertSame(200, $response['status']);
        $this->assertSame([
            'complete' => false,
            'fileName' => 'a.txt',
            'fileSize' => 14,
            'totalChunks' => 4,
            'receivedBytes' => 10,
            'uploadedChunks' => [0, 2, 3],
        ], $response['body']['data']);
    }

    public function testStatusOfACompletedUpload(): void {
        $endpoint = $this->endpoint();
        $this->upload($endpoint, 'done', 'a.txt', 'abcd');

        $response = $this->sendJson($endpoint, ['action' => 'status', 'fileId' => 'done']);

        $this->assertSame(200, $response['status']);
        $this->assertSame(['complete' => true, 'fileName' => 'a.txt', 'fileSize' => 4], $response['body']['data']);
    }

    public function testStatusOfUnknownOrInvalidUploads(): void {
        $endpoint = $this->endpoint();

        $this->assertSame(404, $this->sendJson($endpoint, ['action' => 'status', 'fileId' => 'nope'])['status']);
        $this->assertSame(400, $this->sendJson($endpoint, ['action' => 'status', 'fileId' => '../x'])['status']);
        $this->assertSame(400, $this->sendJson($endpoint, ['action' => 'status'])['status']);
    }

    public function testAbortRemovesStoredChunks(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'stop', 'a.txt', 'abcdefgh', 4, [0]);

        $response = $this->sendJson($endpoint, ['action' => 'abort', 'fileId' => 'stop']);

        $this->assertSame(200, $response['status']);
        $this->assertDirectoryDoesNotExist($this->tempDir . 'stop');
        $this->assertSame(404, $this->sendJson($endpoint, ['action' => 'status', 'fileId' => 'stop'])['status']);

        // Repeating it is harmless
        $this->assertSame(200, $this->sendJson($endpoint, ['action' => 'abort', 'fileId' => 'stop'])['status']);
    }

    public function testAbortDoesNotTouchStoredFiles(): void {
        $endpoint = $this->endpoint();
        $this->upload($endpoint, 'kept', 'a.txt', 'abcd');

        $this->sendJson($endpoint, ['action' => 'abort', 'fileId' => 'kept']);

        $this->assertSame('abcd', file_get_contents($this->uploadDir . 'a.txt'));
    }

    public function testAbortRejectsInvalidIds(): void {
        $response = $this->sendJson($this->endpoint(), ['action' => 'abort', 'fileId' => '..']);

        $this->assertSame(400, $response['status']);
        $this->assertDirectoryExists($this->root);
    }
}
