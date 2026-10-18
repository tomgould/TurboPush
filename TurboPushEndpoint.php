<?php
/**
 * TurboPush Server Endpoint (backward-compatible entry point)
 *
 * The endpoint now lives in the TurboPush namespace under php/ and is
 * autoloaded by Composer. This file keeps the original drop-in usage working:
 *
 * ```php
 * require_once 'TurboPushEndpoint.php';
 *
 * $turbopush = new TurboPushEndpoint('/var/uploads/');
 * $turbopush->handle();
 * ```
 *
 * New code should use Composer and the namespaced class instead:
 *
 * ```php
 * use TurboPush\TurboPushEndpoint;
 * ```
 *
 * @package TurboPush
 * @license MIT
 */

require_once __DIR__ . '/php/TurboPushEndpoint.php';

if (!class_exists('TurboPushEndpoint', false)) {
    class_alias(\TurboPush\TurboPushEndpoint::class, 'TurboPushEndpoint');
}
