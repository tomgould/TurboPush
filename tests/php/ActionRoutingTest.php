<?php

namespace TurboPush\Tests;

/**
 * JSON actions are matched exactly: only the strings finalize, status and abort.
 */
class ActionRoutingTest extends EndpointTestCase
{
    public function testNonStringActionsAreUnknown(): void {
        $endpoint = $this->endpoint();
        foreach ([true, 0, 1, 0.0, ['finalize'], ['name' => 'finalize']] as $action) {
            $response = $this->sendJson($endpoint, [
                'action' => $action, 'fileId' => 'nope', 'fileName' => 'a.txt', 'fileSize' => 1, 'totalChunks' => 1,
            ]);
            $this->assertSame(400, $response['status'], json_encode($action));
            $this->assertSame('Unknown action', $response['body']['message']);
        }
    }

    public function testNonStringActionDoesNotFinalize(): void {
        $endpoint = $this->endpoint();
        $this->sendAllChunks($endpoint, 'loose', 'a.txt', 'abcd', 4);

        $response = $this->sendJson($endpoint, [
            'action' => true, 'fileId' => 'loose', 'fileName' => 'a.txt', 'fileSize' => 4, 'totalChunks' => 1,
        ]);
        $this->assertSame(400, $response['status']);
        $this->assertFileDoesNotExist($this->uploadDir . 'a.txt');
    }

    public function testActionsAreCaseSensitive(): void {
        $response = $this->sendJson($this->endpoint(), ['action' => 'STATUS', 'fileId' => 'nope']);
        $this->assertSame(400, $response['status']);
        $this->assertSame('Unknown action', $response['body']['message']);
    }
}
