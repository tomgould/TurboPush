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

    private function preflight(array $server, $endpoint = null): array {
        $endpoint = $endpoint ?: $this->endpoint();
        return $endpoint->processRequest($server + [
            'REQUEST_METHOD' => 'OPTIONS',
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
            'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'content-type',
        ], [], [], '');
    }

    private function assertNoCorsHeaders(array $response): void {
        foreach (array_keys($response['headers']) as $name) {
            $this->assertStringStartsNotWith('Access-Control-', $name);
        }
    }

    public function testSendsNoCorsHeadersByDefault(): void {
        $response = $this->request(['HTTP_ORIGIN' => 'https://upload.example', 'HTTP_HOST' => 'upload.example']);

        $this->assertSame(404, $response['status']);
        $this->assertNoCorsHeaders($response);
        $this->assertArrayNotHasKey('Vary', $response['headers']);
    }

    public function testRejectsCrossOriginRequestsByDefault(): void {
        $response = $this->request(['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'upload.example']);

        $this->assertSame(403, $response['status']);
        $this->assertSame('Origin not allowed', $response['body']['message']);
        $this->assertNoCorsHeaders($response);
    }

    public function testRejectsCrossOriginChunksByDefault(): void {
        $endpoint = $this->endpoint();
        $response = $endpoint->processRequest(
            ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'multipart/form-data; boundary=x',
                'HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'upload.example'],
            $this->chunkFields('csrf', 'a.txt', 4, 1, 0),
            [],
            ''
        );

        $this->assertSame(403, $response['status']);
        $this->assertSame([], self::listFiles($this->tempDir));
    }

    public function testRejectsNullOriginByDefault(): void {
        $response = $this->request(['HTTP_ORIGIN' => 'null', 'HTTP_HOST' => 'upload.example']);

        $this->assertSame(403, $response['status']);
        $this->assertNoCorsHeaders($response);
    }

    public function testAllowsSameOriginAndNonBrowserRequestsByDefault(): void {
        $sameOrigin = $this->request(['HTTP_ORIGIN' => 'http://localhost:8000', 'HTTP_HOST' => 'localhost:8000']);
        $noOrigin = $this->request([]);

        $this->assertSame(404, $sameOrigin['status']);
        $this->assertSame(404, $noOrigin['status']);
    }

    public function testRejectsPlainHttpOriginOnHttpsRequests(): void {
        $http = $this->request(['HTTP_ORIGIN' => 'http://upload.example', 'HTTP_HOST' => 'upload.example', 'HTTPS' => 'on']);
        $https = $this->request(['HTTP_ORIGIN' => 'https://upload.example', 'HTTP_HOST' => 'upload.example', 'HTTPS' => 'on']);
        $proxied = $this->request(['HTTP_ORIGIN' => 'https://upload.example', 'HTTP_HOST' => 'upload.example', 'HTTPS' => 'off']);

        $this->assertSame(403, $http['status']);
        $this->assertSame(404, $https['status']);
        $this->assertSame(404, $proxied['status']);
    }

    public function testRejectsMalformedOriginsThatShareTheHost(): void {
        foreach (['http://upload.example/path', 'http://user@upload.example', 'upload.example'] as $origin) {
            $response = $this->request(['HTTP_ORIGIN' => $origin, 'HTTP_HOST' => 'upload.example']);
            $this->assertSame(403, $response['status'], $origin);
        }
    }

    public function testPreflightFromOtherOriginIsRejectedByDefault(): void {
        $response = $this->preflight(['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'upload.example']);

        $this->assertSame(403, $response['status']);
        $this->assertNoCorsHeaders($response);
    }

    public function testEchoesAllowedOriginsWithCredentials(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example/']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://app.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(404, $response['status']);
        $this->assertSame('https://app.example', $response['headers']['Access-Control-Allow-Origin']);
        $this->assertSame('true', $response['headers']['Access-Control-Allow-Credentials']);
        $this->assertSame('Origin', $response['headers']['Vary']);
    }

    public function testAcceptsSeveralOrigins(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example', 'https://admin.example']);

        foreach (['https://app.example', 'https://admin.example'] as $origin) {
            $response = $this->request(['HTTP_ORIGIN' => $origin, 'HTTP_HOST' => 'upload.example'], $endpoint);
            $this->assertSame(404, $response['status'], $origin);
            $this->assertSame($origin, $response['headers']['Access-Control-Allow-Origin']);
        }
    }

    public function testAnswersPreflightFromAllowedOrigin(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);
        $response = $this->preflight(['HTTP_ORIGIN' => 'https://app.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(204, $response['status']);
        $this->assertNull($response['body']);
        $this->assertSame('https://app.example', $response['headers']['Access-Control-Allow-Origin']);
        $this->assertSame('true', $response['headers']['Access-Control-Allow-Credentials']);
        $this->assertSame('POST, OPTIONS', $response['headers']['Access-Control-Allow-Methods']);
        $this->assertStringContainsString('Content-Type', $response['headers']['Access-Control-Allow-Headers']);
        $this->assertSame('600', $response['headers']['Access-Control-Max-Age']);
        $this->assertSame('Origin', $response['headers']['Vary']);
    }

    public function testRejectsOtherOrigins(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(403, $response['status']);
        $this->assertNoCorsHeaders($response);
        $this->assertSame('Origin', $response['headers']['Vary']);
    }

    public function testPreflightFromOtherOriginGetsNoCorsHeaders(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);
        $response = $this->preflight(['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(403, $response['status']);
        $this->assertNoCorsHeaders($response);
    }

    public function testNeverReflectsLookalikeOrigins(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);

        foreach (['https://app.example.evil.example', 'https://evilapp.example', 'http://app.example', 'https://app.example:8443'] as $origin) {
            $response = $this->request(['HTTP_ORIGIN' => $origin, 'HTTP_HOST' => 'upload.example'], $endpoint);
            $this->assertSame(403, $response['status'], $origin);
            $this->assertNoCorsHeaders($response);
        }
    }

    public function testAllowsSameOriginAndNonBrowserRequestsWithAList(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example']);

        $sameOrigin = $this->request(['HTTP_ORIGIN' => 'http://localhost:8000', 'HTTP_HOST' => 'localhost:8000'], $endpoint);
        $noOrigin = $this->request([], $endpoint);

        $this->assertSame(404, $sameOrigin['status']);
        $this->assertSame(404, $noOrigin['status']);
        $this->assertArrayNotHasKey('Access-Control-Allow-Origin', $sameOrigin['headers']);
    }

    public function testWildcardMustBeConfiguredExplicitly(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['*']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://anywhere.example', 'HTTP_HOST' => 'upload.example'], $endpoint);
        $preflight = $this->preflight(['HTTP_ORIGIN' => 'https://anywhere.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(404, $response['status']);
        $this->assertSame('*', $response['headers']['Access-Control-Allow-Origin']);
        $this->assertArrayNotHasKey('Access-Control-Allow-Credentials', $response['headers']);
        $this->assertArrayNotHasKey('Vary', $response['headers']);
        $this->assertSame(204, $preflight['status']);
        $this->assertSame('*', $preflight['headers']['Access-Control-Allow-Origin']);
    }

    public function testEmptyListRestoresTheDefault(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://app.example'])->setAllowedOrigins([]);
        $response = $this->request(['HTTP_ORIGIN' => 'https://app.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(403, $response['status']);
        $this->assertNoCorsHeaders($response);
    }

    public function testOriginsMatchCaseInsensitively(): void {
        $endpoint = $this->endpoint()->setAllowedOrigins(['https://App.Example']);
        $response = $this->request(['HTTP_ORIGIN' => 'https://app.example', 'HTTP_HOST' => 'upload.example'], $endpoint);

        $this->assertSame(404, $response['status']);
        $this->assertSame('https://app.example', $response['headers']['Access-Control-Allow-Origin']);
    }

    public function testRejectsInvalidOriginsInTheList(): void {
        $invalid = ['app.example', 'https://app.example/uploads', 'https://*.example', 'null', 'https://user@app.example'];

        foreach ($invalid as $origin) {
            try {
                $this->endpoint()->setAllowedOrigins(['https://app.example', $origin]);
                $this->fail('Accepted ' . $origin);
            } catch (\InvalidArgumentException $e) {
                $this->assertSame('Invalid origin: ' . $origin, $e->getMessage());
            }
        }
    }
}
