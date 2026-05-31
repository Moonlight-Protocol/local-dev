# Backend logging convention

Every Moonlight backend platform (`provider-platform`, `council-platform`,
`pay-platform`, `network-dashboard-platform`) follows the conventions in this
document. New backend code must adopt them; existing code is migrated.

The TypeScript Logger is a direct port of [AquiGorka/go-logger][go-logger] —
same interface, same level semantics, same output cues. Side-by-side with
OpenTelemetry, never merged with it.

[go-logger]: https://github.com/AquiGorka/go-logger

## Why this exists

Before this convention, each backend ran its own custom `Logger` class with a
variadic `console.log` wrapper, six levels (FATAL/ERROR/WARN/INFO/DEBUG/TRACE),
and no shared call-site discipline. Three of the four had OTEL tracing but
none correlated logs with spans, and only `provider-platform` followed the
`span.addEvent` pattern that this repo's `e2e/README.md` debugging walkthrough
already treats as the norm. The result: logs across services looked similar
but read differently, and nothing told a reader the operational story of a
single request.

This convention picks the smallest interface that gives readers a consistent
narrative ("this function ran, here are its params, this step happened, this
step failed") without merging logging and tracing into one ambiguous API.

## API surface

```typescript
export interface Logger {
  info(msg: string): void;                 // function-entry breadcrumb
  event(msg: string): void;                // logical-fork success marker
  debug(key: string, value: unknown): void;// labeled value (params, results)
  error(err: unknown, msg: string): void;  // error + context
  scope(name: string): Logger;             // nested child logger
}

export enum Level {
  Debug    = 0,  // logs everything
  Info     = 1,  // info, events, errors
  Event    = 2,  // events, errors only
  Disabled = 3,  // silent
}

export function newLogger(level: Level, opts?: LoggerOptions): Logger;
export function newNoop(): Logger;
export function parseLevel(s: string | undefined): Level;
```

Five methods. No `warn`, no `fatal`, no `trace`. `event` lives between `info`
and `error` in severity — a successful logical step is louder than a function
breadcrumb but quieter than a failure.

### `info(msg)`
First line of every function that matters to a flow. Just the function name.
Acts as the "I'm here" breadcrumb.

### `event(msg)`
Marks a successful logical fork — the bracket around an operation that could
have failed but didn't. Use **only** for steps where a reader needs the signal
that the action succeeded. Domain-significant. Do not use `event` for "X
happened" milestones that aren't bracketing a fallible operation — that's an
`info`, not an `event`.

### `debug(key, value)`
Labeled value dump. One call per value. Used for function parameters at entry
and for intermediate values where they aid debugging. The logger stringifies
non-string values internally — callers don't pre-`JSON.stringify`.

Don't blanket-debug everything. Debug what would matter when investigating a
problem.

### `error(err, msg)`
Error first, then a human string describing what was being attempted. Caller
decides flow (throw, return, fall through). The logger doesn't terminate or
swallow.

### `scope(name)`
Returns a new logger whose scope is the parent's scope plus `.name`. Scopes
nest. Default top-level scope is `main`.

```typescript
const log = newLogger(Level.Info);            // scope = "main"
const auth = log.scope("auth");               // scope = "main.auth"
const session = auth.scope("session");        // scope = "main.auth.session"
```

## Service injection — no singletons

Logger instances are passed into services as constructor params, not imported
from a singleton. This is the only pattern that lets tests pass `newNoop()` (or
a capturing writer) without monkey-patching imports.

```typescript
class CouncilService {
  private log: Logger;

  constructor(deps: { log: Logger; db: Db }) {
    this.log = deps.log.scope("CouncilService");
    this.db = deps.db;
  }

  async createCouncil(name: string, jurisdiction: string): Promise<Council> {
    this.log.info("createCouncil");
    this.log.debug("name", name);
    this.log.debug("jurisdiction", jurisdiction);

    this.log.event("inserting council row");
    try {
      const row = await this.db.councils.insert({ name, jurisdiction });
      this.log.event("council inserted");
      this.log.debug("id", row.id);
      return row;
    } catch (err) {
      this.log.error(err, "db.councils.insert");
      throw err;
    }
  }
}
```

### HTTP route handlers — factory pattern

Routes are not classes, but they still take the logger via injection. Each
handler file exports a **factory function** that receives the logger and any
service dependencies it needs, and returns the actual `(ctx) => ...` request
handler. The factory closes over its deps; the returned handler reads them
from the closure.

```typescript
// src/http/v1/council/approve-join-request.ts
export function handleApproveJoinRequest(
  deps: { log: Logger; db: Db },
): (ctx: Context) => Promise<void> {
  const log = deps.log.scope("approveJoinRequest");

  return async (ctx) => {
    log.info("approveJoinRequest");
    log.debug("requestId", ctx.params.id);

    log.event("loading join request");
    try {
      const request = await deps.db.joinRequests.findById(ctx.params.id);
      log.event("join request loaded");
      // ...
    } catch (err) {
      log.error(err, "db.joinRequests.findById");
      ctx.response.status = 500;
      return;
    }
  };
}
```

Wire-up happens in the router setup, where the root logger is in scope:

```typescript
// src/http/router.ts
import { handleApproveJoinRequest } from "./v1/council/approve-join-request.ts";
// ...

export function buildRouter(deps: { log: Logger; db: Db }): Router {
  const router = new Router();
  router.post(
    "/v1/council/join-requests/:id/approve",
    handleApproveJoinRequest(deps),
  );
  // ...
  return router;
}
```

Naming: `handle<Operation>(deps)`. No `create`/`get`/`Factory` suffix — the
closure-returning shape is the signal. The factory keeps the closure narrow
(handler sees only what it needs), makes the handler testable in isolation
(`handleApproveJoinRequest({ log: newNoop(), db: fakeDb })` returns a handler
you can call directly), and avoids the implicit-state problem of relying on
middleware to populate `ctx.state.log`. Don't use `ctx.state` for the logger.

### Free functions

Free functions take the logger as a parameter or are called from a class that
holds one. There is no module-level singleton.

### Bootstrap

`main.ts` is the only place where the root logger is constructed:

```typescript
const log = newLogger(parseLevel(Deno.env.get("LOG_LEVEL")));
const db = await connectDb();
const councilService = new CouncilService({ log, db });
```

## The five-call rhythm

Inside any non-trivial function the call order is:

1. `info(funcName)` — function entry.
2. `debug(label, value)` — for params worth recording.
3. `event("doing X")` — before a fallible logical step.
4. `error(err, "X")` on the failure branch, `event("X done")` on the success
   branch. One or the other, never both for the same step.
5. `debug("result", value)` — only when the result is interesting.

Not every function deserves all five. A 1-line helper that formats a date does
not. An operation that touches I/O, talks to another service, or affects flow
control does. No strict cutoff — author discretion.

## When to use which level — examples

| Situation | Method | Example |
|---|---|---|
| Function entry | `info` | `this.log.info("approveJoinRequest")` |
| Recording a param | `debug` | `this.log.debug("id", id)` |
| About to call the DB | `event` | `this.log.event("loading join request")` |
| DB call returned successfully | `event` | `this.log.event("join request loaded")` |
| DB call threw | `error` | `this.log.error(err, "db.joinRequests.findById")` |
| Reporting the loaded row | `debug` | `this.log.debug("request", request)` |
| Server-running message at boot | `info` | `log.info("Council Platform running on :3015")` |

`info` is also valid for things that aren't function entry — boot messages,
shutdown messages, milestone announcements that don't bracket a fallible step.
What `info` is *not* is the place to attach structured context. Context goes
in `debug` calls.

## Migrating existing call sites

The pre-convention pattern was a single `LOG.info(msg, contextObj)` call
carrying structured fields. Under the new convention each context field
becomes its own `debug` line:

```typescript
// Before
LOG.info("Provider added on-chain", {
  councilId: "C...",
  address: "G...",
  ledger: 459,
});

// After
log.info("handleProviderAdded");
log.debug("councilId", "C...");
log.debug("address", "G...");
log.debug("ledger", 459);
log.event("provider added on-chain");
```

The previous one-liner becomes five lines. This is deliberate — the per-field
debugs let a reader filter on a single value (`grep address=G`) without
running a structured-log parser, and the `event` marker signals "this domain
fact was recorded" separately from "this function ran."

Existing `LOG.warn(...)` calls have no direct equivalent. Migrate by:

- If the warning was reporting a recoverable error path → `error(err, msg)`.
- If the warning was reporting a milestone the operator should see → `event(msg)`.

`LOG.fatal(...)` and `LOG.trace(...)` calls don't exist in the current
codebase, but if encountered they map to `error(err, msg)` and (drop entirely)
respectively.

## OpenTelemetry relationship

The logger and OTEL spans are **independent**. Calls go side by side at the
same point in the code, never merged. The logger never calls `span.addEvent`
internally, and span events never trigger log lines.

```typescript
async function approveJoinRequest(id: string) {
  this.log.info("approveJoinRequest");
  this.log.debug("id", id);

  const span = tracer.startSpan("approveJoinRequest");
  span.setAttribute("request.id", id);

  this.log.event("loading join request");
  span.addEvent("loading_join_request");
  try {
    const request = await this.db.joinRequests.findById(id);
    this.log.event("join request loaded");
    span.addEvent("join_request_loaded");
    // ...
  } catch (err) {
    this.log.error(err, "db.joinRequests.findById");
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
```

OTEL coverage is the subject of a separate thread. The logger half of this
convention applies now to every backend; the OTEL half is enforced only where
OTEL is already wired (`provider-platform`, `council-platform`, `pay-platform`)
and adopted incrementally.

## Output destinations and formats

The logger always writes to stdout in human format. When a file path is also
configured, each record is mirrored to the file in JSON format. Two
destinations, two formats — humans read stdout, programs read the file.

### Stdout (human format)

Terse text matching go-logger's console output, prefixed with an ISO-8601
timestamp so Fly log search continues to work. Colored when stdout is a TTY;
plain ASCII otherwise.

```
[2026-05-27T12:42:08.241Z] INF [main.http.approveJoinRequest] approveJoinRequest
[2026-05-27T12:42:08.241Z] DBG  requestId: req-abc-123 (main.http.approveJoinRequest)
[2026-05-27T12:42:08.242Z] EVT -loading join request (main.http.approveJoinRequest)
[2026-05-27T12:42:08.255Z] EVT -join request loaded (main.http.approveJoinRequest)
[2026-05-27T12:42:08.256Z] DBG  request: {"id":"req-abc-123","providerKey":"G..."} (main.http.approveJoinRequest)
```

### File (JSON format)

Opt-in via `newLogger(level, { file: "logs/app.log" })`. One JSON object per
line, tight schema, no color, suitable for log shippers and `jq` queries.

```jsonl
{"ts":"2026-05-27T12:42:08.241Z","level":"info","scope":"main.http.approveJoinRequest","msg":"approveJoinRequest"}
{"ts":"2026-05-27T12:42:08.241Z","level":"debug","scope":"main.http.approveJoinRequest","key":"requestId","value":"req-abc-123"}
{"ts":"2026-05-27T12:42:08.242Z","level":"event","scope":"main.http.approveJoinRequest","msg":"loading join request"}
{"ts":"2026-05-27T12:42:08.255Z","level":"event","scope":"main.http.approveJoinRequest","msg":"join request loaded"}
{"ts":"2026-05-27T12:42:08.260Z","level":"error","scope":"main.http.approveJoinRequest","msg":"db.joinRequests.findById","error":"connection refused"}
```

Schema is stable: `ts` is ISO-8601, `level` is one of `debug|info|event|error`,
`scope` is the dotted scope path, `msg` is set for info/event/error, `key` +
`value` are set for debug, and `error` is set for error.

Fly deployments today consume stdout only. The file option is provided for
parity with go-logger and for local consumers (e.g. a script tailing
`logs/app.log` with `jq`). A follow-up thread will decide whether Fly stdout
should switch to JSON for Loki/Grafana ingest.

### Level tags

| Method | Level tag |
|---|---|
| `info` | `INF` |
| `event` | `EVT` |
| `debug` | `DBG` |
| `error` | `ERR` |

`LOG_LEVEL` env var is parsed via `parseLevel()`:

| Env value | Effect |
|---|---|
| `debug` | All four levels emit |
| `info` | Info + Event + Error |
| `event` | Event + Error |
| `disabled` (or unset / unknown) | Silent |

Default when env var is unset is **Disabled**, matching go-logger. Set
`LOG_LEVEL=info` in production and `LOG_LEVEL=debug` for local debugging.

## Testing

Pass `newNoop()` into service constructors to silence output, or use
`newLogger(Level.Debug, { writer: capturingWriter })` to assert on what gets
logged.

```typescript
// Service unit test
const log = newNoop();
const service = new CouncilService({ log, db: fakeDb });
await service.createCouncil("Test", "US");

// Capturing for assertion
const buf = new BufferWriter();
const log = newLogger(Level.Debug, { writer: buf });
const service = new CouncilService({ log, db: fakeDb });
await service.createCouncil("Test", "US");
assert(buf.contains("INF [main.CouncilService] createCouncil"));
```

## Per-repo implementation

Each backend repo carries its own copy of the Logger module at
`src/utils/logger/index.ts` plus a tiny bootstrap helper at
`src/config/logger.ts` that calls `newLogger(parseLevel(Deno.env.get("LOG_LEVEL")))`
and exposes it for `main.ts` to consume.

The Logger module is **not** factored into a shared `@moonlight/logging`
package — keeping it local to each repo avoids cross-repo coordination cost
for what's a ~120 line file. If the file drifts across repos, a maintenance
thread will reconcile.

## Hard rules summary

- Five methods only: `info`, `event`, `debug`, `error`, `scope`.
- `info` takes one string. No second arg.
- `debug` takes (key, value). One call per value.
- `error` takes (err, msg). Err first.
- Loggers are injected, never imported as a singleton.
- Scopes nest with `.` separators.
- Logger and OTEL stay independent. Don't bridge them.
