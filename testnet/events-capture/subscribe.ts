/**
 * WebSocket subscribers — per-PP (provider-platform) + network-wide
 * (network-dashboard-platform).
 *
 * Both subscribers buffer every incoming message into an append-only array.
 * The harness reads the buffers after the script + tail window finish.
 *
 * Implementation notes:
 *  - Deno's built-in `WebSocket` global is used directly — no new dep, per
 *    the prompt's no-new-WS-lib rule.
 *  - The provider-platform WS expects `Sec-WebSocket-Protocol: bearer.<jwt>`;
 *    Deno's `WebSocket(url, protocols)` argument is mapped to that header.
 *  - Per-PP WS open can race ahead of the script's PP-registration step.
 *    `openPerPpSubscriber` polls until the PP exists in the operator's view
 *    (HTTP 200 from the dashboard PP-detail endpoint) before opening.
 *  - Network WS open never blocks — endpoint is public.
 */
import type { CapturedEvent } from "./types.ts";

const PER_PP_SUBPROTOCOL = "moonlight.events.v1";
const NETWORK_SUBPROTOCOL = "moonlight.network.v2";
const PER_PP_OPEN_RETRY_INTERVAL_MS = 500;
const PER_PP_OPEN_TIMEOUT_MS = 60_000;

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
 * initial `SnapshotFrame` (PM-acked: snapshot state depends on prior runs
 * and is not deterministic); captures every subsequent `LiveFrame`.
 */
export function openNetworkSubscriber(networkWsUrl: string): Subscriber {
  const subscriberId = "network";
  const captured: CapturedEvent[] = [];

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
  const socket = new WebSocket(url, NETWORK_SUBPROTOCOL);

  socket.onopen = () => {
    resolveReady();
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
    // SnapshotFrame is dropped per PM ack — only LiveFrame.event is captured.
    if (message.type !== "event") return;
    captured.push({
      subscriberId,
      message,
      receivedAtMs: Date.now(),
    });
  };
  socket.onerror = () => {
    if (socket.readyState !== WebSocket.OPEN) {
      rejectReady(new Error(`network WS error before open: ${url}`));
    }
  };
  socket.onclose = () => {
    resolveClose();
  };

  return {
    subscriberId,
    captured,
    ready,
    close: () => {
      if (
        socket.readyState !== WebSocket.CLOSING &&
        socket.readyState !== WebSocket.CLOSED
      ) {
        socket.close();
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
 * `GET /api/v1/dashboard/pp/<ppPublicKey>` until the response is 200, then
 * opens the WS.
 *
 * `ready` resolves after the WS is OPEN — the harness awaits this before
 * letting the script proceed to chain ops that emit per-PP events.
 */
export function openPerPpSubscriber(args: {
  providerUrl: string;
  ppPublicKey: string;
  operatorJwt: string;
}): Subscriber {
  const subscriberId = `perPp:${args.ppPublicKey}`;
  const captured: CapturedEvent[] = [];

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

  // Async open loop — retries while the PP is being registered upstream.
  (async () => {
    const start = Date.now();
    while (!cancelled) {
      const ppExists = await checkPpExists(
        args.providerUrl,
        args.ppPublicKey,
        args.operatorJwt,
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

    const wsUrl = toWsUrl(
      `${args.providerUrl}/api/v1/providers/${
        encodeURIComponent(args.ppPublicKey)
      }/events/ws`,
    );
    socket = new WebSocket(wsUrl, [
      `bearer.${args.operatorJwt}`,
      PER_PP_SUBPROTOCOL,
    ]);
    socket.onopen = () => resolveReady();
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
      if (socket && socket.readyState !== WebSocket.OPEN) {
        rejectReady(new Error(`per-PP WS error before open: ${wsUrl}`));
      }
    };
    socket.onclose = () => resolveClose();
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
      }
      // If we cancelled before the socket existed, resolve now.
      if (!socket) resolveClose();
      return closeDone;
    },
  };
}

/**
 * Provider-platform exposes `GET /api/v1/dashboard/pp/list` (scoped to the
 * authenticated operator). No single-PP GET endpoint exists today, so the
 * harness polls list and matches on publicKey.
 */
async function checkPpExists(
  providerUrl: string,
  ppPublicKey: string,
  operatorJwt: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${providerUrl}/api/v1/dashboard/pp/list`, {
      headers: { Authorization: `Bearer ${operatorJwt}` },
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    const body = await res.json() as {
      data?: Array<{ publicKey?: string }>;
    };
    return body.data?.some((pp) => pp.publicKey === ppPublicKey) ?? false;
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
