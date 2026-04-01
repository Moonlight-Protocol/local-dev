#!/bin/sh
set -e

# Copy source from read-only mount, excluding host artifacts
cd /app-src && tar cf - --exclude node_modules --exclude .git --exclude target . | tar xf - -C /app
cd /app

# Write .env so that @std/dotenv load() and drizzle-kit --env both find it.
# Merge config from setup container + docker-compose DATABASE_URL.
if [ -f /config/provider.env ]; then
  cp /config/provider.env .env
fi
echo "DATABASE_URL=${DATABASE_URL}" >> .env

deno install
deno task db:migrate
exec deno task serve
