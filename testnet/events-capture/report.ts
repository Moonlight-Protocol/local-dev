/**
 * Format + write the post-run report.
 *
 *  - Pass: one-line OK summary to stdout, JSON dump to runs/<run-id>/report.json.
 *  - Fail: structured diff to stdout (one block per failing subscriber, each
 *    listing every expected slot vs captured slot with diff text), plus the
 *    same JSON dump.
 */
import type { RunReport, SubscriberDiff } from "./types.ts";

const RUNS_ROOT = new URL("./runs/", import.meta.url).pathname;

export interface ReportWriteResult {
  reportPath: string;
}

/**
 * Persist the run report to `events-capture/runs/<run-id>/report.json` and
 * mirror a one-block-per-subscriber summary to stdout.
 */
export async function writeReport(
  report: RunReport,
): Promise<ReportWriteResult> {
  const runDir = `${RUNS_ROOT}${report.runId}`;
  await Deno.mkdir(runDir, { recursive: true });
  const reportPath = `${runDir}/report.json`;
  await Deno.writeTextFile(reportPath, JSON.stringify(report, null, 2));

  if (report.pass) {
    console.log(
      `[events-capture] PASS — script ${report.scriptName} — run ${report.runId}`,
    );
    for (const sub of report.perSubscriber) {
      console.log(
        `[events-capture]   ${sub.subscriberId}: ${sub.capturedCount}/${sub.expectedCount} events matched`,
      );
    }
  } else {
    console.error(
      `[events-capture] FAIL — script ${report.scriptName} — run ${report.runId}`,
    );
    for (const sub of report.perSubscriber) {
      formatSubscriberToStderr(sub);
    }
  }
  console.log(`[events-capture] report: ${reportPath}`);
  return { reportPath };
}

function formatSubscriberToStderr(sub: SubscriberDiff): void {
  if (sub.pass) {
    console.error(
      `[events-capture]   ${sub.subscriberId}: PASS (${sub.capturedCount}/${sub.expectedCount})`,
    );
    return;
  }
  console.error(
    `[events-capture]   ${sub.subscriberId}: FAIL — expected ${sub.expectedCount}, captured ${sub.capturedCount}`,
  );
  for (const entry of sub.entries) {
    switch (entry.status) {
      case "match":
        console.error(
          `[events-capture]     [${entry.index}] OK   kind=${
            JSON.stringify(
              (entry.captured as Record<string, unknown>)?.kind ?? "(none)",
            )
          }`,
        );
        break;
      case "mismatch":
        console.error(
          `[events-capture]     [${entry.index}] DIFF ${
            entry.diffText ?? "structural"
          }`,
        );
        console.error(
          `[events-capture]       expected: ${JSON.stringify(entry.expected)}`,
        );
        console.error(
          `[events-capture]       captured: ${JSON.stringify(entry.captured)}`,
        );
        break;
      case "expected_missing":
        console.error(
          `[events-capture]     [${entry.index}] MISS expected ${
            JSON.stringify(
              (entry.expected as Record<string, unknown>)?.kind ?? "(none)",
            )
          } not received`,
        );
        console.error(
          `[events-capture]       expected: ${JSON.stringify(entry.expected)}`,
        );
        break;
      case "captured_extra":
        console.error(
          `[events-capture]     [${entry.index}] EXTRA captured event with no expected slot`,
        );
        console.error(
          `[events-capture]       captured: ${JSON.stringify(entry.captured)}`,
        );
        break;
    }
  }
}

export function makeRunId(scriptName: string): string {
  return `${scriptName}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
