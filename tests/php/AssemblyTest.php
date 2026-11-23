<?php

namespace TurboPush\Tests;

/**
 * Chunks are reassembled byte for byte, atomically and only once.
 */
class AssemblyTest extends EndpointTestCase
{
    public function testAssemblesChunksArrivingInAnyOrder(): void {
        $endpoint = $this->endpoint();
        $content = random_bytes(1000);
        $order = range(0, 9);
        shuffle($order);

        foreach ($this->sendAllChunks($endpoint, 'shuffled', 'data.bin', $content, 100, $order) as $response) {
            $this->assertSame(200, $response['status']);
        }
        $response = $this->finalize($endpoint, 'shuffled', 'data.bin', $content, 100);

        $this->assertSame(200, $response['status']);
        $this->assertSame(['fileName' => 'data.bin', 'fileSize' => 1000], $response['body']['data']);
        $this->assertSame($content, file_get_contents($this->uploadDir . 'data.bin'));
    }

    public function testUploadsEmptyFiles(): void {
        $response = $this->upload($this->endpoint(), 'empty', 'empty.txt', '');

        $this->assertSame(200, $response['status']);
        $this->assertSame('', file_get_contents($this->uploadDir . 'empty.txt'));
    }

    public function testReportsMissingChunks(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'gaps', 'a.txt', 'aaaabbbbccccdddd', 4, [0, 2]);

        $response = $this->finalize($endpoint, 'gaps', 'a.txt', 'aaaabbbbccccdddd', 4);
        $this->assertSame(409, $response['status']);
        $this->assertSame('Missing chunks', $response['body']['message']);
        $this->assertSame([1, 3], $response['body']['data']['missingChunks']);
        $this->assertSame([], self::listFiles($this->uploadDir));

        // Sending the missing chunks makes the upload complete
        $this->sendAllChunks($endpoint, 'gaps', 'a.txt', 'aaaabbbbccccdddd', 4, [1, 3]);
        $this->assertSame(200, $this->finalize($endpoint, 'gaps', 'a.txt', 'aaaabbbbccccdddd', 4)['status']);
    }

    public function testFinalizeOfUnknownUploadIsNotFound(): void {
        $response = $this->finalize($this->endpoint(), 'nothing', 'a.txt', 'abcd', 4);

        $this->assertSame(404, $response['status']);
        $this->assertSame('Upload not found', $response['body']['message']);
    }

    public function testRepeatedFinalizeReturnsTheSameResultWithoutDuplicating(): void {
        $endpoint = $this->endpoint();
        $first = $this->upload($endpoint, 'twice', 'a.txt', 'hello world');
        $second = $this->finalize($endpoint, 'twice', 'a.txt', 'hello world', 4);

        $this->assertSame(200, $first['status']);
        $this->assertSame($first['body'], $second['body']);
        $this->assertSame(['a.txt'], self::listFiles($this->uploadDir));

        // A finalize for the same ID with different details is refused
        $other = $this->finalize($endpoint, 'twice', 'b.txt', 'hello world', 4);
        $this->assertSame(409, $other['status']);
    }

    public function testChunksAfterFinalizeAreRefused(): void {
        $endpoint = $this->endpoint();
        $this->upload($endpoint, 'closed', 'a.txt', 'abcd');

        $response = $this->sendChunk($endpoint, $this->chunkFields('closed', 'a.txt', 4, 1, 0), 'zzzz');
        $this->assertSame(409, $response['status']);
        $this->assertSame('abcd', file_get_contents($this->uploadDir . 'a.txt'));
    }

    public function testCleansUpChunksAndLeavesNoTemporaryFiles(): void {
        $endpoint = $this->endpoint();
        $this->upload($endpoint, 'tidy', 'a.txt', 'abcdefghij');

        $this->assertSame(['a.txt'], self::listFiles($this->uploadDir));
        $this->assertSame(['tidy/.lock', 'tidy/complete.json'], self::listFiles($this->tempDir));
    }

    public function testCreatesTemporaryDirectoriesPrivately(): void {
        $this->sendAllChunks($this->endpoint(), 'perm', 'a.txt', 'abcd', 4);

        $this->assertSame(0700, fileperms($this->tempDir) & 0777);
        $this->assertSame(0700, fileperms($this->tempDir . 'perm') & 0777);
    }

    public function testDefaultTempDirIsOutsideTheUploadDirectory(): void {
        $endpoint = new TestableEndpoint($this->uploadDir);
        $tempDir = new \ReflectionProperty(\TurboPush\TurboPushEndpoint::class, 'tempDir');
        if (PHP_VERSION_ID < 80100) {
            $tempDir->setAccessible(true);
        }
        $path = $tempDir->getValue($endpoint);

        $this->assertStringStartsWith(rtrim(sys_get_temp_dir(), '/') . '/turbopush-', $path);
        $this->assertStringNotContainsString($this->uploadDir, $path);

        // Different upload directories get different temp directories
        $other = new TestableEndpoint($this->root . '/elsewhere/');
        $this->assertNotSame($path, $tempDir->getValue($other));

        // And uploads really go there
        $response = $this->upload($endpoint, 'deflt', 'a.txt', 'abcd');
        $this->assertSame(200, $response['status']);
        $this->assertFileExists($path . 'deflt/complete.json');
        self::removeTree($path);
    }
}
