import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { MoonlightTracer, MoonlightSpan } from "@moonlight/moonlight-sdk";

const otelTracer = trace.getTracer("moonlight-e2e");
const collectedTraceIds = new Set<string>();
const e2eStartTimeUs = Date.now() * 1000; // microseconds for Jaeger API

const TRACE_IDS_PATH = new URL("./e2e-trace-ids.json", import.meta.url).pathname;

function wrapOtelSpan(otelSpan: ReturnType<typeof otelTracer.startSpan>): MoonlightSpan {
  return {
    addEvent(event, attrs) {
      otelSpan.addEvent(event, attrs);
    },
    setError(error) {
      const message = error instanceof Error ? error.message : String(error);
      otelSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      otelSpan.recordException(error instanceof Error ? error : new Error(message));
    },
    end() {
      otelSpan.end();
    },
  };
}

export const sdkTracer: MoonlightTracer = {
  startSpan(name, attributes) {
    return wrapOtelSpan(otelTracer.startSpan(name, { attributes }));
  },

  withActiveSpan(name, fn, attributes) {
    return otelTracer.startActiveSpan(name, { attributes }, (otelSpan) => {
      return fn(wrapOtelSpan(otelSpan));
    });
  },
};

/**
 * Wraps an async e2e flow step in an active OTel span.
 * Any fetch() calls inside the callback will carry W3C traceparent headers.
 */
export async function withE2ESpan<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return otelTracer.startActiveSpan(name, async (span) => {
    collectedTraceIds.add(span.spanContext().traceId);
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(error instanceof Error ? error : new Error(message));
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function writeTraceIds(): Promise<void> {
  const data = {
    traceIds: [...collectedTraceIds],
    startTimeUs: e2eStartTimeUs,
    endTimeUs: Date.now() * 1000,
  };
  await Deno.writeTextFile(TRACE_IDS_PATH, JSON.stringify(data, null, 2));
  console.log(`  Wrote ${data.traceIds.length} trace IDs to ${TRACE_IDS_PATH}`);
}
