<?php
/**
 * TurboPush Upload Endpoint - Example Implementation
 *
 * Copy this file into your public web root and adjust it. Keep the upload,
 * temp and log locations outside the web root, and put your own
 * authentication in front of it: anyone who can reach this URL can upload.
 *
 * With Composer:
 *     composer require tomgould/turbopush
 *     require __DIR__ . '/../vendor/autoload.php';
 *
 * Without Composer, require the bundled entry point instead (as below).
 */

require_once __DIR__ . '/../TurboPushEndpoint.php';

use TurboPush\TurboPushEndpoint;
use TurboPush\TurboPushException;

// Example: only signed-in users may upload
// session_start();
// if (empty($_SESSION['user_id'])) {
//     http_response_code(401);
//     exit;
// }

$storage = '/var/lib/myapp';  // Outside the web root

$turbopush = new TurboPushEndpoint(
    $storage . '/uploads',  // Where finished files go
    $storage . '/chunks'    // Where chunks wait (default: a folder under sys_get_temp_dir())
);

$turbopush
    ->setMaxFileSize(10 * 1024 * 1024 * 1024)                     // 10GB
    ->setMaxChunkSize(8 * 1024 * 1024)                            // At least the client's chunkSize
    ->setAllowedExtensions(['jpg', 'jpeg', 'png', 'pdf', 'zip', 'mp4'])
    ->setAllowedMimeTypes(['image/jpeg', 'image/png', 'application/pdf', 'application/zip', 'video/mp4'])
    ->setAllowedOrigins(['https://app.example.com'])              // Or leave the default '*'
    ->setUploadTtl(24 * 60 * 60)                                  // Drop abandoned chunks after a day
    ->enableLogging($storage . '/logs/turbopush.log')
    ->setFileValidator(function ($path, array $info) {
        // Reject anything that claims to be an image but is not one
        if (strpos((string) $info['mimeType'], 'image/') === 0 && @getimagesize($path) === false) {
            throw new TurboPushException('Not a valid image', 415);
        }
        return true;
    })
    ->onComplete(function ($path, array $info) {
        // Record the upload; anything returned is added to the response data
        // $id = $db->insert('uploads', ['path' => $path, 'size' => $info['fileSize']]);
        // return ['id' => $id];
    })
    ->handle();
