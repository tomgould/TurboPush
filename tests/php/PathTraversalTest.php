<?php

namespace TurboPush\Tests;

/**
 * Upload IDs, file names and chunk indexes must never reach outside the
 * configured directories.
 */
class PathTraversalTest extends EndpointTestCase
{
    public function testRejectsUploadIdsThatAreNotPlainTokens(): void {
        $endpoint = $this->endpoint();
        $badIds = ['..', '.', '../escape', 'a/b', 'a\\b', '..%2f', "abc\0def", '', ' ', 'a.b', str_repeat('a', 201), "evil\n", "x\r\n"];

        foreach ($badIds as $id) {
            $response = $this->sendChunk($endpoint, $this->chunkFields($id, 'a.txt', 4, 1, 0), 'data');
            $this->assertSame(400, $response['status'], 'fileId ' . json_encode($id));
            $this->assertSame('Invalid fileId', $response['body']['message']);

            $response = $this->sendJson($endpoint, [
                'action' => 'finalize', 'fileId' => $id, 'fileName' => 'a.txt', 'fileSize' => 4, 'totalChunks' => 1,
            ]);
            $this->assertSame(400, $response['status'], 'finalize fileId ' . json_encode($id));
        }

        // Nothing at all was written outside the sandbox, or even inside it
        $this->assertSame([], self::listFiles($this->tempDir));
        $this->assertSame([], self::listFiles($this->uploadDir));
    }

    public function testRejectsNonScalarUploadId(): void {
        $response = $this->sendJson($this->endpoint(), [
            'action' => 'finalize', 'fileId' => ['..'], 'fileName' => 'a.txt', 'fileSize' => 4, 'totalChunks' => 1,
        ]);
        $this->assertSame(400, $response['status']);
    }

    public function testFileNameTraversalStaysInsideUploadDir(): void {
        $endpoint = $this->endpoint();
        $names = [
            '../../evil.txt' => 'evil.txt',
            '..\\..\\windows.txt' => 'windows.txt',
            '/etc/passwd' => 'passwd',
            'C:\\Windows\\win.ini' => 'win.ini',
            'uploads/../../../x.txt' => 'x.txt',
            '..' => 'file',
            '....//....//y.txt' => 'y.txt',
        ];

        $i = 0;
        foreach ($names as $name => $expected) {
            $response = $this->upload($endpoint, 'trav' . $i++, $name, 'payload');
            $this->assertSame(200, $response['status'], $name . ': ' . json_encode($response['body']));
            $this->assertSame($expected, $response['body']['data']['fileName'], $name);
            $this->assertFileExists($this->uploadDir . $expected);
        }

        // Only the expected files exist, all directly inside the upload dir
        $expectedFiles = array_values(array_unique(array_values($names)));
        sort($expectedFiles);
        $this->assertSame($expectedFiles, self::listFiles($this->uploadDir));
        $this->assertFileDoesNotExist($this->root . '/evil.txt');
        $this->assertFileDoesNotExist(dirname($this->root) . '/evil.txt');
    }

    public function testRejectsInvalidChunkIndexes(): void {
        $endpoint = $this->endpoint();
        $badIndexes = ['-1', '1e3', '0x1', '1.5', ' 1', "1\n", 'abc', '', '99999999999999999999', '3'];

        foreach ($badIndexes as $index) {
            $fields = $this->chunkFields('idx', 'a.txt', 12, 3, 0);
            $fields['chunkIndex'] = $index;
            $response = $this->sendChunk($endpoint, $fields, 'abcd');
            $this->assertSame(400, $response['status'], 'chunkIndex ' . json_encode($index));
            $this->assertSame('Invalid chunkIndex', $response['body']['message'], 'chunkIndex ' . json_encode($index));
        }

        $this->assertSame([], self::listFiles($this->tempDir));
    }

    public function testChunkFilesUseFixedNamesInsideTheUploadDirectory(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'fixed', 'a.txt', 'abcdefgh', 4);

        $this->assertSame(
            ['fixed/.lock', 'fixed/chunk_0000000000', 'fixed/chunk_0000000001', 'fixed/upload.json'],
            self::listFiles($this->tempDir)
        );
    }
}
