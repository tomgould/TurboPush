<?php

namespace TurboPush\Tests;

/**
 * Abandoned uploads are removed, active ones and foreign files are not.
 */
class CleanupTest extends EndpointTestCase
{
    public function testRemovesAbandonedUploadsOnly(): void {
        $endpoint = $this->endpoint()->setUploadTtl(3600);
        $this->sendAllChunks($endpoint, 'old', 'a.txt', 'abcdefgh', 4, [0]);
        $this->sendAllChunks($endpoint, 'fresh', 'b.txt', 'abcdefgh', 4, [0]);
        touch($this->tempDir . 'old', time() - 7200);

        $this->assertSame(1, $endpoint->cleanup());

        $this->assertDirectoryDoesNotExist($this->tempDir . 'old');
        $this->assertFileExists($this->tempDir . 'fresh/chunk_0000000000');
    }

    public function testMaxAgeCanBeOverridden(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'recent', 'a.txt', 'abcd', 4);
        touch($this->tempDir . 'recent', time() - 120);

        $this->assertSame(0, $endpoint->cleanup());
        $this->assertSame(1, $endpoint->cleanup(60));
    }

    public function testSkipsUploadsThatAreLocked(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'busy', 'a.txt', 'abcd', 4);
        touch($this->tempDir . 'busy', time() - 100000);

        $lock = fopen($this->tempDir . 'busy/.lock', 'c');
        flock($lock, LOCK_EX);
        $this->assertSame(0, $endpoint->cleanup());
        flock($lock, LOCK_UN);
        fclose($lock);

        $this->assertSame(1, $endpoint->cleanup());
    }

    public function testOnlyDeletesFilesItCreated(): void {
        $endpoint = $this->endpoint();
        mkdir($this->tempDir . 'mine/', 0700, true);
        file_put_contents($this->tempDir . 'mine/chunk_0000000000', 'x');
        file_put_contents($this->tempDir . 'mine/important.doc', 'keep me');
        mkdir($this->tempDir . 'not.an.id/', 0700, true);
        file_put_contents($this->tempDir . 'not.an.id/chunk_0000000000', 'x');
        file_put_contents($this->tempDir . 'loose-file', 'x');
        foreach (['mine', 'not.an.id'] as $dir) {
            touch($this->tempDir . $dir, time() - 100000);
        }

        $this->assertSame(0, $endpoint->cleanup());

        $this->assertFileDoesNotExist($this->tempDir . 'mine/chunk_0000000000');
        $this->assertFileExists($this->tempDir . 'mine/important.doc');
        $this->assertFileExists($this->tempDir . 'not.an.id/chunk_0000000000');
        $this->assertFileExists($this->tempDir . 'loose-file');
    }

    public function testRemovesStaleAssemblyFilesFromTheUploadDirectory(): void {
        mkdir($this->uploadDir, 0755, true);
        file_put_contents($this->uploadDir . '.turbopush-0123abcd.part', 'x');
        file_put_contents($this->uploadDir . '.turbopush-fedc0000.part', 'x');
        file_put_contents($this->uploadDir . 'user-file.part', 'x');
        touch($this->uploadDir . '.turbopush-0123abcd.part', time() - 100000);
        touch($this->uploadDir . 'user-file.part', time() - 100000);

        $this->endpoint()->cleanup();

        $this->assertSame(['.turbopush-fedc0000.part', 'user-file.part'], self::listFiles($this->uploadDir));
    }

    public function testRequestsTriggerCleanupWithTheConfiguredProbability(): void {
        $endpoint = $this->endpoint()->setCleanupProbability(0);
        $this->sendAllChunks($endpoint, 'stale', 'a.txt', 'abcdefgh', 4, [0]);
        touch($this->tempDir . 'stale', time() - 100000);

        $this->sendAllChunks($endpoint, 'other', 'a.txt', 'abcd', 4);
        $this->assertDirectoryExists($this->tempDir . 'stale');

        $endpoint->setCleanupProbability(1);
        $this->sendAllChunks($endpoint, 'other2', 'a.txt', 'abcd', 4);
        $this->assertDirectoryDoesNotExist($this->tempDir . 'stale');
    }

    public function testChunkForACleanedUpUploadStartsAFreshUpload(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'gone', 'a.txt', 'abcdefgh', 4, [0]);
        touch($this->tempDir . 'gone', time() - 100000);
        $endpoint->cleanup();

        $this->sendAllChunks($endpoint, 'gone', 'a.txt', 'abcdefgh', 4, [1]);
        $response = $this->finalize($endpoint, 'gone', 'a.txt', 'abcdefgh', 4);

        $this->assertSame(409, $response['status']);
        $this->assertSame([0], $response['body']['data']['missingChunks']);
    }
}
