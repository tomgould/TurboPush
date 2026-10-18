<?php

namespace TurboPush\Tests;

/**
 * CORS headers and origin checks.
 */
class CorsTest extends EndpointTestCase
{
    private function request(array $server, $endpoint = null): array {
        $endpoint = $endpoint ?: $this->endpoint();
        return $endpoint->processRequest(
            $server + ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'application/json'],
            [],
            [],
            json_encode(['action' => 'status', 'fileId' => 'none'])
        );
    }

    public function testAllowsAnyOriginByDefault(): void {
        $response = $this->request(['HTTP_ORIGIN' => 'https://anywhere.example']);

        $this->assertSame('*', $response['headers']['Access-Control-Allow-Origin']);
        $this->assertArrayNotHasKey('Access-Control-Allow-Credentials', $response['headers']);
        $this->assertSame(404, $response['status']);
    }

    public function testEchoesAllowedOriginsWithCredentials(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example/']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://app.example'], $endpoint);

        $this->assertSame('https://app.example', $response['headers']['Access-Control-Allow-Origin']);
        $this->assertSame('true', $response['headers']['Access-Control-Allow-Credentials']);
        $this->assertSame('Origin', $response['headers']['Vary']);
    }

    public function testRejectsOtherOrigins(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(403, $response['status']);
        $this->assertArrayNotHasKey('Access-Control-Allow-Origin', $response['headers']);
    }

    public function testAllowsSameOriginAndNonBrowserRequests(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);

        $sameOrigin = $this->request(['HTTP_ORIGIN' => 'http://localhost:8000', 'HTTP_HOST' => 'localhost:8000'], $endpoint);
        $noOrigin = $this->request([], $endpoint);

        $this->assertSame(404, $sameOrigin['status']);
        $this->assertSame(404, $noOrigin['status']);
    }

    public function testCanDisableCorsHeaders(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins([]);
        $response = $this->request(['HTTP_ORIGIN' => 'https://anywhere.example'], $endpoint);

        $this->assertArrayNotHasKey('Access-Control-Allow-Origin', $response['headers']);
        $this->assertArrayNotHasKey('Access-Control-Allow-Methods', $response['headers']);
    }

    public function testOriginsMatchCaseInsensitively(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://App.Example']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://app.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(404, $response['status']);
        $this->assertSame('https://app.example', $response['headers']['Access-Control-Allow-Origin']);
    }
}
