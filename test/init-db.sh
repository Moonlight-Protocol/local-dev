#!/bin/bash
set -e

# Creates all databases needed by the test stack.
# Mounted into /docker-entrypoint-initdb.d/ on the PostgreSQL container.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE provider_platform_db;
  CREATE DATABASE council_platform_db;
  CREATE DATABASE pay_platform_db;
EOSQL
