<?php

namespace TurboPush\Tests;

/**
 * Parallel and duplicate requests, run as real separate PHP processes.
 */
class ConcurrencyTest extends EndpointTestCase
{
    /** @var string */
    private $barrier;

    protected function setUp(): void {
        parent::setUp();
        if (!function_exists('proc_open')) {
            $this->markTestSkipped('proc_open is not available');
        }
        $this->barrier = $this->root . '/go';
        mkdir($this->root . '/scratch');
    }

    public function testParallelDuplicateChunksProduceACorrectFile(): void {
        $content = random_bytes(16 * 8192);
        $chunks = str_split($content, 8192);

        // Every chunk is sent twice, all at the same time
        $jobs = [];
        foreach ([0, 1] as $copy) {
            foreach ($chunks as $index => $chunk) {
                $jobs[] = [
                    'type' => 'chunk',
                    'fields' => $this->chunkFields('par', 'parallel.bin', strlen($content), count($chunks), $index),
                    'content' => base64_encode($chunk),
                ];
            }
        }

        foreach ($this->runWorkers($jobs) as $result) {
            $this->assertSame(200, $result['status'], json_encode($result['body']));
        }

        $response = $this->finalize($this->endpoint(), 'par', 'parallel.bin', $content, 8192);
        $this->assertSame(200, $response['status'], json_encode($response['body']));
        $this->assertSame($content, file_get_contents($this->uploadDir . 'parallel.bin'));
        $this->assertSame([], glob($this->tempDir . 'par/*.part'));
    }

    public function testParallelFinalizeAssemblesTheFileExactlyOnce(): void {
        $content = random_bytes(40 * 65536);
        $endpoint = $this->endpoint();
        foreach ($this->sendAllChunks($endpoint, 'race', 'race.bin', $content, 65536) as $response) {
            $this->assertSame(200, $response['status']);
        }

        $body = [
            'action' => 'finalize', 'fileId' => 'race', 'fileName' => 'race.bin',
            'fileSize' => strlen($content), 'totalChunks' => 40,
        ];
        $results = $this->runWorkers(array_fill(0, 8, ['type' => 'finalize', 'body' => $body]));

        foreach ($results as $result) {
            $this->assertSame(200, $result['status'], json_encode($result['body']));
            $this->assertSame('race.bin', $result['body']['data']['fileName']);
        }
        $this->assertSame(['race.bin'], self::listFiles($this->uploadDir));
        $this->assertSame($content, file_get_contents($this->uploadDir . 'race.bin'));
    }

    public function testFinalizeWaitsForTheUploadLock(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'locked', 'a.txt', 'abcdefgh', 4);

        // Hold the upload's lock as if another request were working on it
        $lock = fopen($this->tempDir . 'locked/.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX));

        touch($this->barrier);
        [$process, $stdout, $jobFile] = $this->startWorker([
            'type' => 'finalize',
            'body' => ['action' => 'finalize', 'fileId' => 'locked', 'fileName' => 'a.txt', 'fileSize' => 8, 'totalChunks' => 2],
        ]);

        usleep(500000);
        $this->assertTrue(proc_get_status($process)['running'], 'finalize should block while the lock is held');
        $this->assertSame([], self::listFiles($this->uploadDir));

        flock($lock, LOCK_UN);
        fclose($lock);

        $result = json_decode(stream_get_contents($stdout), true);
        fclose($stdout);
        proc_close($process);
        unlink($jobFile);

        $this->assertSame(200, $result['status']);
        $this->assertSame('abcdefgh', file_get_contents($this->uploadDir . 'a.txt'));
    }

    /**
     * Starts all jobs, releases them at once and returns their responses.
     */
    private function runWorkers(array $jobs): array {
        $workers = [];
        foreach ($jobs as $job) {
            $workers[] = $this->startWorker($job);
        }

        touch($this->barrier);

        $results = [];
        foreach ($workers as [$process, $stdout, $jobFile]) {
            $output = stream_get_contents($stdout);
            fclose($stdout);
            proc_close($process);
            unlink($jobFile);
            $decoded = json_decode($output, true);
            $this->assertIsArray($decoded, 'worker output: ' . $output);
            $results[] = $decoded;
        }
        return $results;
    }

    /**
     * @return array [process, stdout pipe, job file]
     */
    private function startWorker(array $job): array {
        $job += [
            'uploadDir' => $this->uploadDir,
            'tempDir' => $this->tempDir,
            'barrier' => $this->barrier,
            'scratch' => $this->root . '/scratch',
        ];
        $jobFile = tempnam($this->root, 'job');
        file_put_contents($jobFile, json_encode($job));

        $process = proc_open(
            [PHP_BINARY, '-d', 'xdebug.mode=off', __DIR__ . '/fixtures/worker.php', $jobFile],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        $this->assertIsResource($process);
        fclose($pipes[2]);

        return [$process, $pipes[1], $jobFile];
    }
}
