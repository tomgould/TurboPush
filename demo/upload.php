<?php
/**
 * TurboPush Demo Endpoint
 *
 * Used by the demo page. Files are stored under the system temp directory
 * (for example /tmp/turbopush-demo/uploads), never in the web root.
 *
 * Add ?simulateFailures=1 to the endpoint URL to make the first attempt of
 * every fourth chunk (chunk 1, 5, 9, ...) fail with a 503, so you can watch
 * the client retry.
 *
 * This is a demo. For a production setup see examples/upload-endpoint.php.
 */

require_once __DIR__ . '/../TurboPushEndpoint.php';

$storage = sys_get_temp_dir() . '/turbopush-demo';

if (!empty($_GET['simulateFailures'])
    && isset($_POST['fileId'], $_POST['chunkIndex'])
    && preg_match('/^[A-Za-z0-9_-]{1,200}$/', $_POST['fileId'])
    && ctype_digit($_POST['chunkIndex'])
    && (int) $_POST['chunkIndex'] % 4 === 1) {

    if (!is_dir($storage . '/simulated')) {
        mkdir($storage . '/simulated', 0700, true);
    }

    // Fail each of these chunks once, then let the retry through
    $marker = $storage . '/simulated/' . $_POST['fileId'] . '-' . $_POST['chunkIndex'];
    if (!file_exists($marker)) {
        touch($marker);
        http_response_code(503);
        header('Content-Type: application/json');
        echo json_encode(['success' => false, 'message' => 'Simulated failure', 'data' => []]);
        exit;
    }
}

$turbopush = new TurboPushEndpoint($storage . '/uploads', $storage . '/chunks');
$turbopush
    ->setMaxFileSize(10 * 1024 * 1024 * 1024)  // 10GB
    ->setMaxChunkSize(2 * 1024 * 1024)          // Matches PHP's default upload_max_filesize
    ->enableLogging($storage . '/turbopush.log')
    ->handle();
