<?php

namespace TurboPush;

/**
 * TurboPushException
 *
 * An error that is safe to show to the client. The message is sent back in
 * the JSON response together with the HTTP status code, so it must never
 * contain server paths or other internal details.
 *
 * Throw it from a file validator or completion callback to reject an upload
 * with your own message and status code. Any other exception is treated as
 * an internal error: it is logged and the client only sees a generic 500.
 *
 * @package TurboPush
 * @since   1.1.0
 *
 * @example
 * ```php
 * throw new TurboPushException('Quota exceeded', 413);
 * ```
 */
class TurboPushException extends \RuntimeException
{
    /**
     * HTTP status code to send with the error response
     * @var int
     */
    private $httpStatus;

    /**
     * Extra data to include in the JSON response
     * @var array
     */
    private $data;

    /**
     * @param string          $message    Client-safe error message
     * @param int             $httpStatus HTTP status code (default: 400)
     * @param array           $data       Extra data for the JSON response
     * @param \Throwable|null $previous   Underlying exception, if any
     */
    public function __construct($message, $httpStatus = 400, array $data = [], ?\Throwable $previous = null) {
        parent::__construct($message, (int) $httpStatus, $previous);
        $this->httpStatus = (int) $httpStatus;
        $this->data = $data;
    }

    /**
     * Gets the HTTP status code for the response
     *
     * @return int
     */
    public function getHttpStatus() {
        return $this->httpStatus;
    }

    /**
     * Gets extra data to include in the JSON response
     *
     * @return array
     */
    public function getData() {
        return $this->data;
    }
}
