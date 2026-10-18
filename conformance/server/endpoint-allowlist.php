<?php
/**
 * Conformance endpoint: the conformance profile with a CORS origin allowlist
 * taken from TURBOPUSH_CONFORMANCE_ALLOWED_ORIGINS (comma-separated).
 * See conformance/profile.php.
 */

require __DIR__ . '/../profile.php';

$origins = (string) getenv('TURBOPUSH_CONFORMANCE_ALLOWED_ORIGINS');
if ($origins === '') {
    $origins = 'https://allowed.conformance.test';
}

turbopush_conformance_endpoint(explode(',', $origins))->handle();
