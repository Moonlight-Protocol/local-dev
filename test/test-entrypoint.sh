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

  lifecycle)
    # Copy both lifecycle and e2e sources (lifecycle imports e2e modules)
    cp /lifecycle-src/*.ts /lifecycle-src/deno.json . && cp /lifecycle-src/deno.lock . 2>/dev/null || true
    mkdir -p e2e && cp /e2e-src/*.ts e2e/
    deno install
    echo "Waiting for provider and Stellar..."
    for i in $(seq 1 60); do
      provider_ok=false stellar_ok=false
      deno eval "try { await fetch('$PROVIDER_URL'); Deno.exit(0) } catch { Deno.exit(1) }" 2>/dev/null && provider_ok=true
      deno eval "
        const r = await fetch('$STELLAR_RPC_URL', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'})});
        const d = await r.json(); Deno.exit(d.result?.status==='healthy'?0:1)
      " 2>/dev/null && stellar_ok=true
      if [ "$provider_ok" = true ] && [ "$stellar_ok" = true ]; then
        echo "Provider and Stellar are ready."
        break
      fi
      if [ "$i" -eq 60 ]; then echo "Services not ready after 120s"; exit 1; fi
      sleep 2
    done
    exec deno run --allow-all main.ts
    ;;

  otel)
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
    echo "Running payment flow to generate traces..."
    deno run --allow-all main.ts
    echo "Verifying OTEL traces..."
    exec deno run --allow-all verify-otel.ts
    ;;

  *)
    echo "Unknown test suite: $SUITE"
    echo "Usage: TEST_SUITE=e2e|governance|otel"
    exit 1
    ;;
esac
