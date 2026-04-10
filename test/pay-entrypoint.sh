#!/bin/sh
set -e

# Copy source from read-only mount, excluding host artifacts
cd /app-src && tar cf - --exclude node_modules --exclude .git --exclude .data --exclude .env . | tar xf - -C /app
cd /app

# Write .env from docker-compose environment
touch .env
echo "PORT=${PORT}" >> .env
echo "MODE=${MODE}" >> .env
echo "SERVICE_DOMAIN=${SERVICE_DOMAIN}" >> .env
echo "DATABASE_URL=${DATABASE_URL}" >> .env
echo "SERVICE_AUTH_SECRET=${SERVICE_AUTH_SECRET}" >> .env
echo "CHALLENGE_TTL=${CHALLENGE_TTL}" >> .env
echo "SESSION_TTL=${SESSION_TTL}" >> .env
echo "ADMIN_WALLETS=${ADMIN_WALLETS}" >> .env

deno install
deno task db:migrate

exec deno task serve
