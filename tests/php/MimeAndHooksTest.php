<?php

namespace TurboPush\Tests;

use TurboPush\TurboPushException;

/**
 * MIME allowlist, custom validator and completion callback.
 */
class MimeAndHooksTest extends EndpointTestCase
{
    /** 1x1 transparent PNG */
    private const PNG = "\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\x0f\0\0\x01\x01\0\x05\x18\xd8N\0\0\0\0IEND\xaeB`\x82";

    protected function setUp(): void {
        parent::setUp();
        if (!class_exists('finfo')) {
            $this->markTestSkipped('fileinfo extension not available');
        }
    }

    public function testAcceptsFilesWhoseContentMatchesTheAllowedTypes(): void {
        $endpoint = $this->endpoint()->setAllowedMimeTypes(['image/png']);
        $response = $this->upload($endpoint, 'png', 'pixel.png', self::PNG, 16);

        $this->assertSame(200, $response['status'], json_encode($response['body']));
        $this->assertSame(self::PNG, file_get_contents($this->uploadDir . 'pixel.png'));
    }

    public function testRejectsFilesWhoseContentDoesNotMatch(): void {
        $endpoint = $this->endpoint()->setAllowedMimeTypes(['image/png', 'image/jpeg']);
        $response = $this->upload($endpoint, 'fake', 'fake.png', '<?php system($_GET["c"]); ?>', 8);

        $this->assertSame(415, $response['status']);
        $this->assertSame('File type not allowed', $response['body']['message']);
        $this->assertSame([], self::listFiles($this->uploadDir));
    }

    public function testSupportsWildcardTypes(): void {
        $endpoint = $this->endpoint()->setAllowedMimeTypes(['IMAGE/*']);

        $this->assertSame(200, $this->upload($endpoint, 'wild', 'pixel.png', self::PNG, 16)['status']);
        $this->assertSame(415, $this->upload($endpoint, 'text', 'notes.png', 'just text', 4)['status']);
    }

    public function testValidatorCanRejectAFile(): void {
        $seen = null;
        $endpoint = $this->endpoint()->setFileValidator(function ($path, $info) use (&$seen) {
            $seen = ['content' => file_get_contents($path), 'info' => $info];
            return false;
        });

        $response = $this->upload($endpoint, 'val', 'a.txt', 'hello');

        $this->assertSame(415, $response['status']);
        $this->assertSame('File rejected', $response['body']['message']);
        $this->assertSame('hello', $seen['content']);
        $this->assertSame(['fileId' => 'val', 'fileName' => 'a.txt', 'fileSize' => 5, 'mimeType' => null], $seen['info']);
        $this->assertSame([], self::listFiles($this->uploadDir));
    }

    public function testValidatorCanChooseTheStatusAndMessage(): void {
        $endpoint = $this->endpoint()->setFileValidator(function () {
            throw new TurboPushException('Virus found', 422, ['signature' => 'EICAR']);
        });

        $response = $this->upload($endpoint, 'virus', 'a.txt', 'X5O!P%@AP');

        $this->assertSame(422, $response['status']);
        $this->assertSame('Virus found', $response['body']['message']);
        $this->assertSame(['signature' => 'EICAR'], $response['body']['data']);
    }

    public function testValidatorAcceptingTheFileStoresIt(): void {
        $endpoint = $this->endpoint()
            ->setAllowedMimeTypes(['image/png'])
            ->setFileValidator(function ($path, $info) {
                return $info['mimeType'] === 'image/png';
            });

        $this->assertSame(200, $this->upload($endpoint, 'ok', 'p.png', self::PNG, 16)['status']);
    }

    public function testCompleteCallbackReceivesTheStoredFileAndCanAddData(): void {
        mkdir($this->uploadDir, 0755, true);
        file_put_contents($this->uploadDir . 'a.txt', 'existing');
        $calls = [];

        $endpoint = $this->endpoint()->onComplete(function ($path, $info) use (&$calls) {
            $calls[] = [$path, $info, file_get_contents($path)];
            return ['id' => 42, 'fileName' => 'ignored'];
        });

        $response = $this->upload($endpoint, 'cb', 'a.txt', 'new data');

        $this->assertSame(200, $response['status']);
        $storedName = $response['body']['data']['fileName'];
        $this->assertNotSame('a.txt', $storedName);
        $this->assertSame(42, $response['body']['data']['id']);
        $this->assertCount(1, $calls);
        $this->assertSame($this->uploadDir . $storedName, $calls[0][0]);
        $this->assertSame('a.txt', $calls[0][1]['originalName']);
        $this->assertSame($storedName, $calls[0][1]['fileName']);
        $this->assertSame('new data', $calls[0][2]);

        // A repeated finalize returns the same data without calling back again
        $again = $this->finalize($endpoint, 'cb', 'a.txt', 'new data', 4);
        $this->assertSame($response['body'], $again['body']);
        $this->assertCount(1, $calls);
    }

    public function testFailingCompleteCallbackKeepsChunksForARetry(): void {
        $fail = true;
        $endpoint = $this->endpoint()->onComplete(function () use (&$fail) {
            if ($fail) {
                throw new \RuntimeException('Database is down at /var/db');
            }
        });

        $first = $this->upload($endpoint, 'retry', 'a.txt', 'abcdef');
        $this->assertSame(500, $first['status']);
        $this->assertStringNotContainsString('/var/db', json_encode($first));
        $this->assertSame([], self::listFiles($this->uploadDir));

        $fail = false;
        $second = $this->finalize($endpoint, 'retry', 'a.txt', 'abcdef', 4);
        $this->assertSame(200, $second['status']);
        $this->assertSame('abcdef', file_get_contents($this->uploadDir . 'a.txt'));
    }
}
