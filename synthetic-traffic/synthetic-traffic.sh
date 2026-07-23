#!/usr/bin/env bash
# Run the synthetic-traffic engine. See README.md for env reference.
set -euo pipefail
cd "$(dirname "$0")"
exec deno run --allow-all main.ts "$@"
