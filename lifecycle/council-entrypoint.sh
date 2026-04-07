#!/bin/sh
set -e

# Source config written by setup container
if [ -f /config/council.env ]; then
  echo "Loading config from /config/council.env..."
  set -a
  . /config/council.env
  set +a
fi

echo "Running database migrations..."
deno task db:migrate

echo "Starting council platform..."
exec deno task serve
