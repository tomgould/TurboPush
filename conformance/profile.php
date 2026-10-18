<?php
/**
 * The conformance profile: the endpoint configuration the conformance suite
 * runs against (see conformance/README.md).
 *
 * - maxFileSize 8MB, maxChunkSize 256KB, maxChunks 64
 * - the default extension blocklist, no allowlist, no MIME check
 * - same-origin only, unless TURBOPUSH_CONFORMANCE_ALLOWED_ORIGINS is set
 *   (a comma-separated origin list, used by the allowlist endpoint)
 * - no probabilistic cleanup, so uploads never vanish during a run
 * - storage under TURBOPUSH_CONFORMANCE_DIR: uploads/ for stored files and
 *   chunks/ for chunks waiting to be assembled
 *
 * Kept outside the server's document root so it cannot be requested directly.
 */

require_once __DIR__ . '/../php/TurboPushException.php';
require_once __DIR__ . '/../php/TurboPushEndpoint.php';

use TurboPush\TurboPushEndpoint;

/**
 * Builds an endpoint configured with the conformance profile
 *
 * @param string[] $allowedOrigins Origins for setAllowedOrigins() ([] = same-origin only)
 * @return TurboPushEndpoint
 */
function turbopush_conformance_endpoint(array $allowedOrigins = []) {
    $dir = getenv('TURBOPUSH_CONFORMANCE_DIR');
    if ($dir === false || $dir === '') {
        $dir = sys_get_temp_dir() . '/turbopush-conformance';
    }
    $dir = rtrim($dir, '/\\');

    return (new TurboPushEndpoint($dir . '/uploads', $dir . '/chunks'))
        ->setMaxFileSize(8 * 1024 * 1024)
        ->setMaxChunkSize(256 * 1024)
        ->setMaxChunks(64)
        ->setCleanupProbability(0)
        ->setAllowedOrigins($allowedOrigins);
}
