/**
 * Local Dev — Network Dashboard Demo (multi-country)
 *
 * The councils + PPs are now created statically by setup-c.sh + setup-pp.sh
 * (3 councils, 12 PPs — one per country). This demo just orchestrates
 * send-loop runs across every country so the provider-console dashboards
 * (one per PP) fill with realistic activity.
 *
 *   For each country in the fleet:
 *     shell out to send-loop.ts with TARGET_COUNTRY=<C>
 *     → registers Alicia <C> + Roberto <C> as entities, then deposit/sends/withdraw
 *
 * Prereqs:
 *   - up.sh has run
 *   - setup-c.sh has run (3 councils)
 *   - setup-pp.sh has run (12 PPs)
 *
 * Env overrides:
 *   ONLY_COUNTRIES   comma-separated list, e.g. "AR,BR,US" — runs only those.
 *                    Default: every country present in .local-dev-state.
 *   STATE_FILE       default ./.local-dev-state
 */
const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const ONLY_COUNTRIES = (Deno.env.get("ONLY_COUNTRIES") ?? "")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter((c) => c.length > 0);

function parseStateFile(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

function loadCountries(): string[] {
  const map = parseStateFile(Deno.readTextFileSync(STATE_FILE));
  const count = Number(map.PP_COUNT ?? "0");
  if (!count) {
    throw new Error(
      `State file ${STATE_FILE} has PP_COUNT=0. Re-run setup-pp.sh.`,
    );
  }
  const all: string[] = [];
  for (let i = 1; i <= count; i++) {
    const j = map[`PP_${i}_JURISDICTION`];
    if (j) all.push(j.toUpperCase());
  }
  if (ONLY_COUNTRIES.length > 0) {
    return all.filter((c) => ONLY_COUNTRIES.includes(c));
  }
  return all;
}

async function runSendLoopFor(country: string): Promise<void> {
  const here = new URL("./", import.meta.url).pathname;
  const cmd = new Deno.Command("bash", {
    args: [`${here}send-loop.sh`],
    env: { TARGET_COUNTRY: country },
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    throw new Error(`send-loop failed for ${country} (exit ${code})`);
  }
}

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("\n=== local-dev — Network Dashboard Demo ===\n");
  const countries = loadCountries();
  if (countries.length === 0) {
    throw new Error("No countries found in state file.");
  }
  console.log(`  Will run send-loop across ${countries.length} countries:`);
  console.log(`    ${countries.join(", ")}\n`);

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < countries.length; i++) {
    const c = countries[i];
    console.log(`\n──── [${i + 1}/${countries.length}] ${c} ────`);
    try {
      await runSendLoopFor(c);
      ok++;
    } catch (err) {
      fail++;
      console.error(`  ✗ ${c} failed:`, err);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Demo complete in ${elapsed}s ===`);
  console.log(`  Succeeded: ${ok}/${countries.length}`);
  console.log(`  Failed:    ${fail}/${countries.length}`);
}

main().catch((err) => {
  console.error("\n=== Demo FAILED ===");
  console.error(err);
  Deno.exit(1);
});
