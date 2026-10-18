<?php
/**
 * Runs one endpoint request in its own process, for the concurrency tests.
 *
 * Usage: php worker.php <job.json>
 */

require __DIR__ . '/../../../vendor/autoload.php';

$job = json_decode(file_get_contents($argv[1]), true);
$endpoint = new TurboPush\Tests\TestableEndpoint($job['uploadDir'], $job['tempDir']);

// Wait until every worker has started, so the requests really overlap
while (!file_exists($job['barrier'])) {
    usleep(500);
}

if ($job['type'] === 'chunk') {
    $tmp = tempnam($job['scratch'], 'chunk');
    file_put_contents($tmp, base64_decode($job['content']));
    $files = ['file' => [
        'name' => 'blob',
        'type' => 'application/octet-stream',
        'tmp_name' => $tmp,
        'error' => UPLOAD_ERR_OK,
        'size' => filesize($tmp),
    ]];
    $response = $endpoint->processRequest(['REQUEST_METHOD' => 'POST'], $job['fields'], $files, '');
} else {
    $response = $endpoint->processRequest(['REQUEST_METHOD' => 'POST'], [], [], json_encode($job['body']));
}

echo json_encode(['status' => $response['status'], 'body' => $response['body']]);
