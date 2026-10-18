<?php
/**
 * Minimal tus-php server for TurboPush's interop tests
 *
 * Runs as the router script of PHP's built-in server, so every request,
 * including PATCH, HEAD and DELETE on /files/<key>, ends up here.
 * GET /files/<key>/get downloads a finished upload.
 */

require __DIR__ . '/vendor/autoload.php';

$server = new \TusPhp\Tus\Server('file');
$server->setApiPath('/files')->setUploadDir('/data/uploads');

$server->serve()->send();
