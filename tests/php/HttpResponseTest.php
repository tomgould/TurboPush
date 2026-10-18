<?php

namespace TurboPush\Tests;

use TurboPush\TurboPushEndpoint;
use TurboPush\TurboPushException;

/**
 * Status codes, headers, and no internal details in error responses.
 */
class HttpResponseTest extends EndpointTestCase
{
    public function testRejectsMethodsOtherThanPost(): void {
        foreach (['GET', 'PUT', 'DELETE', 'PATCH'] as $method) {
            $response = $this->endpoint()->processRequest(['REQUEST_METHOD' => $method], [], [], '');
            $this->assertSame(405, $response['status'], $method);
            $this->assertSame('POST, OPTIONS', $response['headers']['Allow']);
        }
    }

    public function testAnswersPreflightWithNoContent(): void {
        $response = $this->endpoint()->processRequest(['REQUEST_METHOD' => 'OPTIONS'], [], [], '');

        $this->assertSame(204, $response['status']);
        $this->assertNull($response['body']);
        $this->assertSame('POST, OPTIONS', $response['headers']['Access-Control-Allow-Methods']);
        $this->assertArrayNotHasKey('Content-Type', $response['headers']);
    }

    public function testJsonResponsesCarrySafeHeaders(): void {
        $response = $this->upload($this->endpoint(), 'hdr', 'a.txt', 'abcd');

        $this->assertSame('application/json; charset=utf-8', $response['headers']['Content-Type']);
        $this->assertSame('nosniff', $response['headers']['X-Content-Type-Options']);
        $this->assertSame('no-store', $response['headers']['Cache-Control']);
        $this->assertSame(['success', 'message', 'data'], array_keys($response['body']));
        $this->assertTrue($response['body']['success']);
    }

    public function testRejectsUnknownActionsAndEmptyRequests(): void {
        $endpoint = $this->endpoint();

        $this->assertSame(400, $this->sendJson($endpoint, ['action' => 'delete-everything'])['status']);
        $this->assertSame(400, $endpoint->processRequest(['REQUEST_METHOD' => 'POST'], [], [], '')['status']);
        $this->assertSame(400, $endpoint->processRequest(['REQUEST_METHOD' => 'POST'], [], [], 'not json')['status']);
    }

    public function testRejectsOversizedJsonBodies(): void {
        $body = json_encode(['action' => 'finalize', 'padding' => str_repeat('x', TurboPushEndpoint::MAX_JSON_BODY)]);
        $response = $this->endpoint()->processRequest(['REQUEST_METHOD' => 'POST'], [], [], $body);

        $this->assertSame(413, $response['status']);
    }

    public function testInternalErrorsDoNotLeakPaths(): void {
        // The upload directory cannot be created because a file is in the way
        file_put_contents(rtrim($this->uploadDir, '/'), 'not a directory');
        $logFile = $this->root . '/turbopush.log';
        $endpoint = $this->endpoint()->enableLogging($logFile);

        $this->sendAllChunks($endpoint, 'leak', 'a.txt', 'abcd', 4);
        $response = $this->finalize($endpoint, 'leak', 'a.txt', 'abcd', 4);

        $this->assertSame(500, $response['status']);
        $this->assertSame('Internal server error', $response['body']['message']);
        $this->assertSame([], $response['body']['data']);
        $this->assertStringNotContainsString($this->root, json_encode($response));

        // The details go to the log instead
        $this->assertStringContainsString($this->root, file_get_contents($logFile));

        // The chunks survive, so the client can retry once the problem is fixed
        unlink(rtrim($this->uploadDir, '/'));
        $this->assertSame(200, $this->finalize($endpoint, 'leak', 'a.txt', 'abcd', 4)['status']);
    }

    public function testClientErrorsDoNotLeakPaths(): void {
        $endpoint = $this->endpoint();
        $responses = [
            $this->sendChunk($endpoint, $this->chunkFields('../../x', 'a.txt', 4, 1, 0), 'data'),
            $this->sendChunk($endpoint, $this->chunkFields('x', 'a.php', 4, 1, 0), 'data'),
            $this->finalize($endpoint, 'missing', 'a.txt', 'data', 4),
        ];
        foreach ($responses as $response) {
            $this->assertStringNotContainsString($this->root, json_encode($response));
            $this->assertStringNotContainsString(sys_get_temp_dir(), json_encode($response));
        }
    }

    public function testTurboPushExceptionCarriesStatusAndData(): void {
        $e = new TurboPushException('Quota exceeded', 413, ['limit' => 10]);

        $this->assertSame(413, $e->getHttpStatus());
        $this->assertSame(['limit' => 10], $e->getData());
        $this->assertInstanceOf(\RuntimeException::class, $e);
    }

    public function testLegacyGlobalClassNameStillWorks(): void {
        require_once __DIR__ . '/../../TurboPushEndpoint.php';

        $endpoint = new \TurboPushEndpoint($this->uploadDir, $this->tempDir);
        $this->assertInstanceOf(TurboPushEndpoint::class, $endpoint);
        $this->assertSame($endpoint, $endpoint->setMaxFileSize(100)->setAllowedExtensions(['txt'])->enableLogging($this->root . '/log'));
    }
}
