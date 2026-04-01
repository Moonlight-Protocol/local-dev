#!/bin/sh
set -e

# Copy source from read-only mount to writable working directory
cp -r /app-src/. /app/
cd /app

# Remove host node_modules (may contain macOS-native binaries)
rm -rf node_modules

# Write .env so that @std/dotenv load() and drizzle-kit --env both find it.
if [ -f /config/council.env ]; then
  cp /config/council.env .env
fi
echo "DATABASE_URL=${DATABASE_URL}" >> .env

deno install
deno task db:migrate
exec deno task serve
