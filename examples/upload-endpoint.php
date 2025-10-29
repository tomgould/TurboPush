<?php
/**
 * TurboPush Upload Endpoint - Example Implementation
 * 
 * This is an example of how to use the TurboPushEndpoint class.
 * Copy this file and customize it for your needs.
 */

require_once __DIR__ . '/../TurboPushEndpoint.php';

$turbopush = new TurboPushEndpoint('./uploads/', './uploads/temp/');
$turbopush
    ->setMaxFileSize(10 * 1024 * 1024 * 1024)  // 10GB
    ->setAllowedExtensions(['jpg', 'png', 'pdf', 'zip', 'gz', 'mp4', 'doc', 'docx', 'txt', 'sql'])
    ->enableLogging('./uploads/turbopush.log')
    ->handle();


