<?php

namespace TurboPush\Tests;

/**
 * Sizes, chunk counts and metadata are validated against configurable limits.
 */
class RequestValidationTest extends EndpointTestCase
{
    public function testRejectsMissingFields(): void {
        $endpoint = $this->endpoint();
        foreach (['fileName', 'fileId', 'chunkIndex', 'totalChunks', 'fileSize'] as $field) {
            $fields = $this->chunkFields('id', 'a.txt', 4, 1, 0);
            unset($fields[$field]);
            $response = $this->sendChunk($endpoint, $fields, 'data');
            $this->assertSame(400, $response['status']);
            $this->assertSame("Missing: $field", $response['body']['message']);
        }
    }

    public function testRejectsFilesLargerThanTheLimit(): void {
        $endpoint = $this->endpoint()->setMaxFileSize(10);

        $response = $this->sendChunk($endpoint, $this->chunkFields('big', 'a.txt', 11, 3, 0), 'abcd');
        $this->assertSame(413, $response['status']);
        $this->assertSame('File size exceeds limit', $response['body']['message']);

        $response = $this->sendJson($endpoint, [
            'action' => 'finalize', 'fileId' => 'big', 'fileName' => 'a.txt', 'fileSize' => 11, 'totalChunks' => 3,
        ]);
        $this->assertSame(413, $response['status']);
    }

    public function testCannotStoreMoreBytesThanDeclared(): void {
        $endpoint = $this->endpoint();

        // Declares 8 bytes in 2 chunks, then sends 6-byte chunks
        $first = $this->sendChunk($endpoint, $this->chunkFields('lie', 'a.txt', 8, 2, 0), '123456');
        $this->assertSame(200, $first['status']);

        $second = $this->sendChunk($endpoint, $this->chunkFields('lie', 'a.txt', 8, 2, 1), '789012');
        $this->assertSame(400, $second['status']);
        $this->assertSame('Upload exceeds the declared file size', $second['body']['message']);
        $this->assertFileDoesNotExist($this->tempDir . 'lie/chunk_0000000001');
    }

    public function testResendingAChunkDoesNotCountItTwice(): void {
        $endpoint = $this->endpoint();
        for ($i = 0; $i < 3; $i++) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('again', 'a.txt', 8, 2, 0), '1234');
            $this->assertSame(200, $response['status']);
        }
        $this->assertSame(200, $this->sendChunk($endpoint, $this->chunkFields('again', 'a.txt', 8, 2, 1), '5678')['status']);

        $response = $this->finalize($endpoint, 'again', 'a.txt', '12345678', 4);
        $this->assertSame(200, $response['status']);
        $this->assertSame('12345678', file_get_contents($this->uploadDir . 'a.txt'));
    }

    public function testRejectsChunksLargerThanTheChunkLimit(): void {
        $endpoint = $this->endpoint()->setMaxChunkSize(4);

        // Declared size of the uploaded file
        $response = $this->sendChunk($endpoint, $this->chunkFields('chunky', 'a.txt', 10, 2, 0), '12345');
        $this->assertSame(413, $response['status']);

        // Actual size on disk, even if the declared size lies
        $response = $this->sendChunk($endpoint, $this->chunkFields('chunky', 'a.txt', 10, 3, 0), '12345', ['size' => 1]);
        $this->assertSame(413, $response['status']);
        $this->assertSame([], glob($this->tempDir . 'chunky/chunk_*'));

        // A file that would need chunks above the limit
        $response = $this->sendChunk($endpoint, $this->chunkFields('chunky', 'a.txt', 10, 2, 0), '1234');
        $this->assertSame(413, $response['status']);
    }

    public function testRejectsTooManyOrInconsistentChunkCounts(): void {
        $endpoint = $this->endpoint()->setMaxChunks(5);

        $cases = [
            [100, 6, 413],  // more chunks than allowed
            [100, 0, 400],  // no chunks
            [3, 4, 400],    // more chunks than bytes
            [0, 2, 400],    // empty file must be one chunk
        ];
        foreach ($cases as $i => [$size, $total, $status]) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('count' . $i, 'a.txt', $size, $total, 0), 'a');
            $this->assertSame($status, $response['status'], "size $size, chunks $total");
        }
    }

    public function testRejectsChunksWhoseMetadataDiffersFromTheFirstChunk(): void {
        $endpoint = $this->endpoint();
        $this->assertSame(200, $this->sendChunk($endpoint, $this->chunkFields('meta', 'a.txt', 12, 3, 0), '1234')['status']);

        $variants = [
            $this->chunkFields('meta', 'b.txt', 12, 3, 1),
            $this->chunkFields('meta', 'a.txt', 11, 3, 1),
            $this->chunkFields('meta', 'a.txt', 12, 4, 1),
        ];
        foreach ($variants as $fields) {
            $response = $this->sendChunk($endpoint, $fields, '5678');
            $this->assertSame(409, $response['status'], json_encode($fields));
            $this->assertSame('Upload metadata does not match', $response['body']['message']);
        }
    }

    public function testFinalizeMustMatchTheUploadedChunks(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'fin', 'a.txt', '12345678', 4);

        foreach ([['fileSize' => 9, 'totalChunks' => 3], ['fileSize' => 8, 'totalChunks' => 3]] as $override) {
            $response = $this->sendJson($endpoint, $override + [
                'action' => 'finalize', 'fileId' => 'fin', 'fileName' => 'a.txt',
            ]);
            $this->assertSame(409, $response['status'], json_encode($override));
        }

        $response = $this->sendJson($endpoint, ['action' => 'finalize', 'fileId' => 'fin', 'fileName' => 'a.txt', 'fileSize' => '8x', 'totalChunks' => 2]);
        $this->assertSame(400, $response['status']);

        $response = $this->sendJson($endpoint, ['action' => 'finalize', 'fileId' => 'fin', 'fileName' => 'a.txt', 'fileSize' => 8]);
        $this->assertSame(400, $response['status']);
        $this->assertSame('Missing: totalChunks', $response['body']['message']);
    }

    public function testMapsPhpUploadErrorsToStatusCodes(): void {
        $endpoint = $this->endpoint();
        $cases = [
            UPLOAD_ERR_INI_SIZE => 413,
            UPLOAD_ERR_FORM_SIZE => 413,
            UPLOAD_ERR_PARTIAL => 400,
            UPLOAD_ERR_NO_FILE => 400,
            UPLOAD_ERR_NO_TMP_DIR => 500,
            UPLOAD_ERR_CANT_WRITE => 500,
        ];
        foreach ($cases as $error => $status) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('err', 'a.txt', 4, 1, 0), 'data', ['error' => $error]);
            $this->assertSame($status, $response['status'], "upload error $error");
        }
    }

    public function testRejectsMultipleFilesInOneRequest(): void {
        $response = $this->endpoint()->processRequest(
            ['REQUEST_METHOD' => 'POST'],
            $this->chunkFields('multi', 'a.txt', 4, 1, 0),
            ['file' => ['tmp_name' => ['/tmp/a', '/tmp/b'], 'error' => [0, 0], 'size' => [1, 1], 'name' => ['a', 'b']]]
        );
        $this->assertSame(400, $response['status']);
    }

    public function testReportsPostMaxSizeOverflowAsTooLarge(): void {
        // PHP leaves $_POST and $_FILES empty when post_max_size is exceeded
        $response = $this->endpoint()->processRequest(
            ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'multipart/form-data; boundary=x', 'CONTENT_LENGTH' => '999999999'],
            [],
            [],
            ''
        );
        $this->assertSame(413, $response['status']);
    }
}
