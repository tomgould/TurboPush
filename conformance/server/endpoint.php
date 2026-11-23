<?php
/**
 * Conformance endpoint: the conformance profile with the default CORS policy
 * (same-origin only). See conformance/profile.php.
 */

require __DIR__ . '/../profile.php';

turbopush_conformance_endpoint()->handle();
