<?php

namespace TurboPush\Tests;

use TurboPush\TurboPushEndpoint;

/**
 * Endpoint whose uploaded-file move works on plain files.
 *
 * move_uploaded_file() only accepts files uploaded in the current HTTP
 * request, which never exist under the CLI, so tests use rename() instead.
 */
class TestableEndpoint extends TurboPushEndpoint
{
    protected function moveUploadedFile($from, $to) {
        return @rename($from, $to);
    }
}
