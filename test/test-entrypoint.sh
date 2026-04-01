#!/bin/sh
set -e

# Load contracts config written by setup
if [ -f /config/contracts.env ]; then
  set -a
  . /config/contracts.env
  set +a
fi

SUITE="${TEST_SUITE:-e2e}"

case "$SUITE" in
  e2e)
    cp /e2e-src/*.ts /e2e-src/deno.json . && cp /e2e-src/deno.lock . 2>/dev/null || true
    deno install
    echo "Waiting for provider..."
    for i in $(seq 1 60); do
      if deno eval "try { await fetch('$PROVIDER_URL'); Deno.exit(0) } catch { Deno.exit(1) }" 2>/dev/null; then
        echo "Provider is ready."
        break
      fi
      if [ "$i" -eq 60 ]; then echo "Provider not ready after 120s"; exit 1; fi
      sleep 2
    done
    exec deno run --allow-all main.ts
    ;;

  governance)
    cp /governance-src/*.ts /governance-src/deno.json . && cp /governance-src/deno.lock . 2>/dev/null || true
    deno install
    echo "Waiting for provider and council..."
    for i in $(seq 1 60); do
      provider_ok=false council_ok=false
      deno eval "try { await fetch('$PROVIDER_URL'); Deno.exit(0) } catch { Deno.exit(1) }" 2>/dev/null && provider_ok=true
      deno eval "try { await fetch('$COUNCIL_URL'); Deno.exit(0) } catch { Deno.exit(1) }" 2>/dev/null && council_ok=true
      if [ "$provider_ok" = true ] && [ "$council_ok" = true ]; then
        echo "Provider and Council are ready."
        break
      fi
      if [ "$i" -eq 60 ]; then echo "Services not ready after 120s"; exit 1; fi
      sleep 2
    done
    exec deno run --allow-all uc2-approve-reject.ts
    ;;

  uc2)
    cp /uc2-src/*.ts /uc2-src/deno.json . && cp /uc2-src/deno.lock . 2>/dev/null || true
    deno install
    echo "Waiting for provider and council..."
    for i in $(seq 1 60); do
      provider_ok=false council_ok=false
      deno eval "try { await fetch('$PROVIDER_URL'); Deno.exit(0) } catch { Deno.exit(1) }" 2>/dev/null && provider_ok=true
      deno eval "try { await fetch('$COUNCIL_URL'); Deno.exit(0) } catch { Deno.exit(1) }" 2>/dev/null && council_ok=true
      if [ "$provider_ok" = true ] && [ "$council_ok" = true ]; then
        echo "Provider and Council are ready."
        break
      fi
      if [ "$i" -eq 60 ]; then echo "Services not ready after 120s"; exit 1; fi
      sleep 2
    done
    exec deno run --allow-all uc2-pp-joins-council.ts
    ;;

  *)
    echo "Unknown test suite: $SUITE"
    echo "Usage: TEST_SUITE=e2e|governance|uc2"
    exit 1
    ;;
esac
