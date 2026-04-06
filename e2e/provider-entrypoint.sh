#!/bin/sh
set -e

# Source config written by setup container
if [ -f /config/provider.env ]; then
  echo "Loading config from /config/provider.env..."
  set -a
  . /config/provider.env
  set +a
fi

echo "Running database migrations..."
deno task db:migrate

echo "Starting provider platform..."
exec deno task serve
