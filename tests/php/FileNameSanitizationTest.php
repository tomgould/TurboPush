<?php

namespace TurboPush\Tests;

/**
 * Stored file names must be safe on any filesystem and web server.
 */
class FileNameSanitizationTest extends EndpointTestCase
{
    public function testSanitizesFileNames(): void {
        $endpoint = $this->endpoint();
        $cases = [
            'photo.jpg' => 'photo.jpg',
            'my report (final).pdf' => 'my_report__final_.pdf',
            '.htaccess' => 'htaccess',
            '.user.ini' => 'user.ini',
            'notes.txt.' => 'notes.txt',
            'trailing.txt...' => 'trailing.txt',
            "nul\0byte.txt" => 'nulbyte.txt',
            'résumé.pdf' => 'r__sum__.pdf',
            'CON.txt' => '_CON.txt',
            'lpt1' => '_lpt1',
            'archive.tar.gz' => 'archive.tar.gz',
            'shell.php.jpg' => 'shell_php.jpg',
            'a.PHTML.b.png' => 'a_PHTML.b.png',
            'semi;colon&amp.txt' => 'semi_colon_amp.txt',
            'stream.txt::$DATA' => 'stream.txt___DATA',
        ];

        $i = 0;
        foreach ($cases as $input => $expected) {
            $response = $this->upload($endpoint, 'name' . $i++, $input, 'x');
            $this->assertSame(200, $response['status'], $input . ': ' . json_encode($response['body']));
            $this->assertSame($expected, $response['body']['data']['fileName'], 'input ' . json_encode($input));
        }
    }

    public function testTruncatesLongNamesAndKeepsTheExtension(): void {
        $response = $this->upload($this->endpoint(), 'long', str_repeat('a', 400) . '.pdf', 'x');

        $this->assertSame(200, $response['status']);
        $name = $response['body']['data']['fileName'];
        $this->assertSame(200, strlen($name));
        $this->assertStringEndsWith('.pdf', $name);
    }

    public function testRejectsMissingOrEmptyFileName(): void {
        $endpoint = $this->endpoint();
        foreach (['', '   '] as $name) {
            $response = $this->sendChunk($endpoint, $this->chunkFields('empty', $name, 1, 1, 0), 'x');
            $this->assertSame(400, $response['status']);
            $this->assertSame('Missing: fileName', $response['body']['message']);
        }
    }

    public function testNeverOverwritesAnExistingFile(): void {
        mkdir($this->uploadDir, 0755, true);
        file_put_contents($this->uploadDir . 'report.pdf', 'original');
        $endpoint = $this->endpoint();

        $names = [];
        for ($i = 0; $i < 3; $i++) {
            $response = $this->upload($endpoint, 'dup' . $i, 'report.pdf', 'new ' . $i);
            $this->assertSame(200, $response['status']);
            $names[] = $response['body']['data']['fileName'];
        }

        $this->assertSame('original', file_get_contents($this->uploadDir . 'report.pdf'));
        $this->assertCount(3, array_unique($names));
        foreach ($names as $i => $name) {
            $this->assertNotSame('report.pdf', $name);
            $this->assertMatchesRegularExpression('/^report_\d+(_\d+)?\.pdf$/', $name);
            $this->assertSame('new ' . $i, file_get_contents($this->uploadDir . $name));
        }
    }
}
