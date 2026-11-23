# Stock tus-php on PHP's built-in server, for TurboPush's interop tests
FROM php:8.3-cli

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app
COPY composer.json ./
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist

COPY server.php ./
RUN mkdir -p /data/uploads /data/.cache && chown -R www-data:www-data /data

# Several workers, so parallel requests are handled in parallel
ENV PHP_CLI_SERVER_WORKERS=4 \
    TUS_CACHE_HOME=/data
USER www-data
EXPOSE 8000
CMD ["php", "-S", "0.0.0.0:8000", "server.php"]
