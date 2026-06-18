/**
 * WebSocket subscribers — per-PP (provider-platform) + network-wide
 * (network-dashboard-platform).
 *
 * Both subscribers buffer every incoming message into an append-only array.
 * The harness reads the buffers after the script + tail window finish.
 *
 * Robustness:
 *  - The server-side WebSocket has an `idleTimeout` (300 s on
 *    network-dashboard-platform; 30 s on provider-platform). For long-running
 *    deploys where chain events don't fire for tens of seconds after `onopen`,
 *    a single dropped frame would lose `council_formed` or
 *    `channel.provider_added`. Both subscribers therefore auto-reconnect on
 *    close (RECONNECT_BACKOFF below).
 *  - The network subscriber deduplicates on reconnect by parsing the new
 *    `SnapshotFrame.recent` (newest-first ring buffer) and re-emitting any
 *    `NetworkEvent` whose `id` we haven't observed yet. This recovers events
 *    that landed on the bus during the disconnect window.
 *  - Per-PP messages have no stable id field, so its reconnect path just
 *    resumes live capture — same as the SPA behaviour. The 300 s idle window
 *    is wide enough for any practical script that we don't expect mid-run
 *    drops on the per-PP socket.
 *
 * Implementation notes:
 *  - Deno's built-in `WebSocket` global is used directly — no new dep, per
 *    the prompt's no-new-WS-lib rule.
 *  - The provider-platform WS expects `Sec-WebSocket-Protocol: bearer.<jwt>`;
 *    Deno's `WebSocket(url, protocols)` argument is mapped to that header.
 *  - Per-PP WS open can race ahead of the script's PP-registration step.
 *    `openPerPpSubscriber` polls `GET /api/v1/dashboard/pp/list` until the
 *    operator's PP appears, then opens the WS.
 */
import type { CapturedEvent } from "./types.ts";

const PER_PP_SUBPROTOCOL = "moonlight.events.v1";
const NETWORK_SUBPROTOCOL = "moonlight.network.v2";
const PER_PP_OPEN_RETRY_INTERVAL_MS = 500;
/**
 * How long the per-PP WebSocket subscriber will poll provider-platform's
 * dashboard view waiting for the PP to be registered before giving up.
 *
 * 60 s was sufficient on local stack (`testnet/run-local.sh`) where the
 * full flow completes in ~80 s. On deployed testnet under load, the
 * flow regularly runs 4–9 minutes — Tempo trace
 * `44207a4b4cacf8c1101cc4332076ee2c` shows `Testnet E2E passed in 539.4s`
 * end-to-end with individual council-platform handler spans hitting the
 * 30 s `postgres-js` `connect_timeout` ceiling. PP registration sits
 * behind those handlers (steps 8–9 of the flow), so the per-PP
 * subscriber needs to be patient enough to outlast a slow upstream
 * round-trip without giving up before the PP exists.
 *
 * 300 s gives the harness 5 minutes of patience — long enough to cover
 * the observed worst-case testnet latency, short enough to still fail
 * loud rather than hang indefinitely.
 */
const PER_PP_OPEN_TIMEOUT_MS = 300_000;
const RECONNECT_BACKOFF_INITIAL_MS = 250;
const RECONNECT_BACKOFF_MAX_MS = 5_000;

export interface Subscriber {
  /** Identity used by the harness to key the captured-events buffer. */
  subscriberId: string;
  /** Append-only capture buffer. */
  captured: CapturedEvent[];
  /** Resolves once the socket is OPEN — the script can start chain ops. */
  ready: Promise<void>;
  /** Close the socket; resolves once the close handler fires. */
  close(): Promise<void>;
}

/**
 * Open a subscriber on `/api/v1/network/ws` (no auth, public). Discards the
 * initial `SnapshotFrame` from the FIRST open (PM-acked: snapshot state at
 * connect-time depends on prior runs and is not deterministic). On
 * subsequent reconnects, replays any `SnapshotFrame.recent` entries whose
 * event.id hasn't been observed yet — so events that fired during the
 * disconnect window are recovered from the server's ring buffer.
 */
export function openNetworkSubscriber(networkWsUrl: string): Subscriber {
  const subscriberId = "network";
  const captured: CapturedEvent[] = [];
  const seenEventIds = new Set<string>();

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let resolveClose!: () => void;
  const closeDone = new Promise<void>((res) => {
    resolveClose = res;
  });

  const url = toWsUrl(networkWsUrl);
  let cancelled = false;
  let socket: WebSocket | null = null;
  let openCount = 0;
  let backoffMs = RECONNECT_BACKOFF_INITIAL_MS;

  const ingestNetworkEvent = (event: Record<string, unknown>): void => {
    const id = typeof event.id === "string" ? event.id : null;
    if (id !== null) {
      if (seenEventIds.has(id)) return;
      seenEventIds.add(id);
    }
    captured.push({
      subscriberId,
      // Wrap NetworkEvent in the original LiveFrame shape so the rest of
      // the framework (assert.ts strips it back out) sees the same envelope
      // whether the event arrived live or via snapshot replay.
      message: { type: "event", event },
      receivedAtMs: Date.now(),
    });
  };

  const connect = (): void => {
    if (cancelled) return;
    socket = new WebSocket(url, NETWORK_SUBPROTOCOL);

    socket.onopen = () => {
      openCount++;
      backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
      if (openCount === 1) resolveReady();
    };
    socket.onmessage = (evt) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof evt.data === "string" ? evt.data : "");
      } catch {
        return;
      }
      if (
        parsed === null || typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return;
      }
      const message = parsed as Record<string, unknown>;
      if (message.type === "snapshot") {
        // First snapshot: drop entirely (per PM ack). Reconnect snapshots:
        // walk recent[] (newest-first per `seedRecent`) in reverse so
        // ingested order is chronological, ingestNetworkEvent dedups by
        // event.id so we only pick up events that landed during the
        // disconnect window.
        if (openCount === 1) return;
        const recent = Array.isArray(message.recent) ? message.recent : [];
        for (let i = recent.length - 1; i >= 0; i--) {
          const ev = recent[i];
          if (ev && typeof ev === "object" && !Array.isArray(ev)) {
            ingestNetworkEvent(ev as Record<string, unknown>);
          }
        }
        return;
      }
      if (message.type === "event") {
        const ev = message.event;
        if (ev && typeof ev === "object" && !Array.isArray(ev)) {
          ingestNetworkEvent(ev as Record<string, unknown>);
        }
      }
    };
    socket.onerror = () => {
      if (
        openCount === 0 && socket && socket.readyState !== WebSocket.OPEN
      ) {
        rejectReady(new Error(`network WS error before open: ${url}`));
      }
    };
    socket.onclose = () => {
      if (cancelled) {
        resolveClose();
        return;
      }
      // Reconnect with exponential backoff. Snapshot replay on the next
      // open re-fills events that fired during the disconnect window.
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
      setTimeout(connect, wait);
    };
  };

  connect();

  return {
    subscriberId,
    captured,
    ready,
    close: () => {
      cancelled = true;
      if (
        socket && socket.readyState !== WebSocket.CLOSING &&
        socket.readyState !== WebSocket.CLOSED
      ) {
        socket.close();
      } else {
        resolveClose();
      }
      return closeDone;
    },
  };
}

/**
 * Open a subscriber on `/api/v1/providers/:ppPublicKey/events/ws`.
 *
 * The provider-platform WS auth handler checks the operator JWT against
 * `PpRepository.findByPublicKeyAndOwner(ppPublicKey, session.sub)`. Until
 * the script's PP-registration step lands a row in `payment_providers`,
 * the WS upgrade returns 403. This helper polls
 * `GET /api/v1/dashboard/pp/list` until the operator's PP appears, then
 * opens the WS.
 *
 * Reconnects on close (same backoff as the network subscriber). Per-PP
 * events don't carry a stable id field, so reconnects just resume live
 * capture — any frame that landed during the disconnect window is lost
 * (provider-platform doesn't expose a recent-events replay). In practice
 * the per-PP socket's 30 s idle timeout is wide enough that no mid-run
 * drop has been observed for the testnet flow scripts.
 *
 * `ready` resolves after the WS is OPEN — the harness awaits this before
 * letting the script proceed to chain ops that emit per-PP events.
 */
export function openPerPpSubscriber(args: {
  providerUrl: string;
  ppPublicKey: string;
  operatorJwt: string;
  /**
   * "multi-pp" (default) → /api/v1/providers/:ppPublicKey/events/ws
   *                       + checkPpExists polls /dashboard/pp/list
   * "single-pp"          → /api/v1/provider/events/ws
   *                       + checkPpExists fetches /dashboard/pp (singular)
   * The Rust standin uses single-pp shape; the Deno provider-platform uses
   * multi-pp. Set per-script via the harness's SUPPORTED_SCRIPTS config.
   */
  urlShape?: "multi-pp" | "single-pp";
}): Subscriber {
  const subscriberId = `perPp:${args.ppPublicKey}`;
  const captured: CapturedEvent[] = [];
  const urlShape = args.urlShape ?? "multi-pp";

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let resolveClose!: () => void;
  const closeDone = new Promise<void>((res) => {
    resolveClose = res;
  });

  let socket: WebSocket | null = null;
  let cancelled = false;
  let openCount = 0;
  let backoffMs = RECONNECT_BACKOFF_INITIAL_MS;

  const wsUrl = toWsUrl(
    urlShape === "single-pp"
      ? `${args.providerUrl}/api/v1/provider/events/ws`
      : `${args.providerUrl}/api/v1/providers/${
        encodeURIComponent(args.ppPublicKey)
      }/events/ws`,
  );

  const connect = (): void => {
    if (cancelled) return;
    socket = new WebSocket(wsUrl, [
      `bearer.${args.operatorJwt}`,
      PER_PP_SUBPROTOCOL,
    ]);
    socket.onopen = () => {
      openCount++;
      backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
      if (openCount === 1) resolveReady();
    };
    socket.onmessage = (evt) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof evt.data === "string" ? evt.data : "");
      } catch {
        return;
      }
      if (
        parsed === null || typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return;
      }
      captured.push({
        subscriberId,
        message: parsed as Record<string, unknown>,
        receivedAtMs: Date.now(),
      });
    };
    socket.onerror = () => {
      if (
        openCount === 0 && socket && socket.readyState !== WebSocket.OPEN
      ) {
        rejectReady(new Error(`per-PP WS error before open: ${wsUrl}`));
      }
    };
    socket.onclose = () => {
      if (cancelled) {
        resolveClose();
        return;
      }
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
      setTimeout(connect, wait);
    };
  };

  // Async open loop — retries while the PP is being registered upstream.
  (async () => {
    const start = Date.now();
    while (!cancelled) {
      const ppExists = await checkPpExists(
        args.providerUrl,
        args.ppPublicKey,
        args.operatorJwt,
        urlShape,
      );
      if (ppExists) break;
      if (Date.now() - start > PER_PP_OPEN_TIMEOUT_MS) {
        rejectReady(
          new Error(
            `per-PP WS gave up after ${PER_PP_OPEN_TIMEOUT_MS}ms: PP ${args.ppPublicKey} never appeared in dashboard view`,
          ),
        );
        resolveClose();
        return;
      }
      await sleep(PER_PP_OPEN_RETRY_INTERVAL_MS);
    }
    if (cancelled) {
      resolveClose();
      return;
    }
    connect();
  })();

  return {
    subscriberId,
    captured,
    ready,
    close: () => {
      cancelled = true;
      if (
        socket && socket.readyState !== WebSocket.CLOSING &&
        socket.readyState !== WebSocket.CLOSED
      ) {
        socket.close();
      } else if (!socket) {
        resolveClose();
      }
      return closeDone;
    },
  };
}

/**
 * Confirm the operator's PP is reachable on the provider before opening
 * the WS. The multi-PP path polls `/dashboard/pp/list` until the
 * script-registered PP appears; the single-PP path checks `/dashboard/pp`
 * (singular — returns one object). Both return false on transient errors
 * so the surrounding loop keeps polling.
 */
async function checkPpExists(
  providerUrl: string,
  ppPublicKey: string,
  operatorJwt: string,
  urlShape: "multi-pp" | "single-pp",
): Promise<boolean> {
  const url = urlShape === "single-pp"
    ? `${providerUrl}/api/v1/dashboard/pp`
    : `${providerUrl}/api/v1/dashboard/pp/list`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${operatorJwt}` },
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    const body = await res.json() as {
      data?:
        | Array<{ publicKey?: string }>
        | { publicKey?: string };
    };
    if (urlShape === "single-pp") {
      return (body.data as { publicKey?: string } | undefined)?.publicKey ===
        ppPublicKey;
    }
    return (body.data as Array<{ publicKey?: string }> | undefined)?.some(
      (pp) => pp.publicKey === ppPublicKey,
    ) ?? false;
  } catch {
    return false;
  }
}

function toWsUrl(httpOrWsUrl: string): string {
  if (httpOrWsUrl.startsWith("ws://") || httpOrWsUrl.startsWith("wss://")) {
    return httpOrWsUrl;
  }
  if (httpOrWsUrl.startsWith("https://")) {
    return "wss://" + httpOrWsUrl.slice("https://".length);
  }
  if (httpOrWsUrl.startsWith("http://")) {
    return "ws://" + httpOrWsUrl.slice("http://".length);
  }
  return httpOrWsUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
