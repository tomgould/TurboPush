<?php

namespace TurboPush\Tests;

/**
 * Extension blocklist and allowlist, checked on every chunk and on finalize.
 */
class ExtensionPolicyTest extends EndpointTestCase
{
    public function testBlocksServerExecutableExtensionsByDefault(): void {
        $endpoint = $this->endpoint();
        foreach (['shell.php', 'SHELL.PHP', 'x.phtml', 'x.phar', 'x.php5', 'x.pht', 'x.cgi', 'x.asp', 'x.jsp', 'x.shtml', 'shell.php.'] as $i => $name) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('blk' . $i, $name, 4, 1, 0), '<?php');
            $this->assertSame(415, $response['status'], $name);
            $this->assertStringStartsWith('File type not allowed', $response['body']['message']);
        }
        $this->assertSame([], self::listFiles($this->tempDir));
    }

    public function testBlocklistCanBeReplaced(): void {
        $endpoint = $this->endpoint()->setBlockedExtensions(['exe']);

        $this->assertSame(200, $this->upload($endpoint, 'ok', 'script.php', 'data')['status']);
        $response = $this->sendChunk($endpoint, $this->chunkFields('exe', 'setup.EXE', 4, 1, 0), 'data');
        $this->assertSame(415, $response['status']);
    }

    public function testAllowlistIsCaseInsensitiveAndAcceptsLeadingDots(): void {
        $endpoint = $this->endpoint()->setAllowedExtensions(['.JPG', 'png']);

        $this->assertSame(200, $this->upload($endpoint, 'a', 'photo.jpg', 'data')['status']);
        $this->assertSame(200, $this->upload($endpoint, 'b', 'PHOTO.PNG', 'data')['status']);

        foreach (['doc.pdf', 'noextension', 'photo.jpg.exe'] as $i => $name) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('c' . $i, $name, 4, 1, 0), 'data');
            $this->assertSame(415, $response['status'], $name);
        }
    }

    public function testFinalizeCannotRenameTheUploadToADifferentFile(): void {
        $endpoint = $this->endpoint()->setAllowedExtensions(['jpg']);
        $this->sendAllChunks($endpoint, 'swap', 'innocent.jpg', '<?php echo 1;', 4);

        // Changing the name at finalize time is refused, whatever the extension
        foreach (['shell.php', 'other.jpg'] as $name) {
            $response = $this->sendJson($endpoint, [
                'action' => 'finalize', 'fileId' => 'swap', 'fileName' => $name, 'fileSize' => 13, 'totalChunks' => 4,
            ]);
            $this->assertContains($response['status'], [409, 415], $name);
        }

        $this->assertSame([], self::listFiles($this->uploadDir));

        // The original name still works
        $response = $this->finalize($endpoint, 'swap', 'innocent.jpg', '<?php echo 1;', 4);
        $this->assertSame(200, $response['status']);
        $this->assertSame(['innocent.jpg'], self::listFiles($this->uploadDir));
    }

    public function testFinalizeChecksTheExtensionEvenIfChunksWereStoredEarlier(): void {
        // Chunks stored while everything was allowed...
        $this->sendAllChunks($this->endpoint()->setBlockedExtensions([]), 'late', 'run.php', 'code', 4);

        // ...cannot be finalized once the policy forbids them
        $response = $this->finalize($this->endpoint(), 'late', 'run.php', 'code', 4);
        $this->assertSame(415, $response['status']);
        $this->assertSame([], self::listFiles($this->uploadDir));
    }

    public function testBlocksTypesBrowsersRunScriptsInByDefault(): void {
        $endpoint = $this->endpoint();
        foreach (['page.html', 'page.HTM', 'page.xhtml', 'image.svg', 'image.svgz', 'archive.mht', 'app.hta', 'lib.inc', 'x.php6'] as $i => $name) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('xss' . $i, $name, 4, 1, 0), 'data');
            $this->assertSame(415, $response['status'], $name);
        }
    }
}
