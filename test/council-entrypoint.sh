#!/bin/sh
set -e

# Copy source from read-only mount to writable working directory
cp -r /app-src/. /app/
cd /app

# Load config written by the setup container
if [ -f /config/council.env ]; then
  set -a
  . /config/council.env
  set +a
fi

# DB URL comes from docker-compose environment (uses Docker service name)
deno install
deno task db:migrate
exec deno task serve
