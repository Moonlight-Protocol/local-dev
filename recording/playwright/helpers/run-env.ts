/**
 * Read/write `recording/runs/<RUN_ID>/run.env`.
 *
 * `setup-recording-keys.sh` produces the file with sentinel comments
 * for values that are minted on-chain during the recording:
 *
 *   # CHANNEL_AUTH_ID=
 *   # PRIVACY_CHANNEL_ID=
 *
 * Section 01 (council onboarding) writes back the real values; later
 * sections read them. Each spec is a separate Playwright invocation,
 * so the .env file is the only shared-state mechanism.
 */
import fs from "fs";
import path from "path";
import process from "node:process";

export interface RunEnv {
  RUN_ID: string;
  ADMIN_PK: string;
  ADMIN_SK: string;
  PP_PK: string;
  PP_SK: string;
  ALICE_MNEMONIC: string;
  ALICE_PK: string;
  BOB_MNEMONIC: string;
  BOB_PK: string;
  COUNCIL_CONSOLE_URL: string;
  COUNCIL_PLATFORM_URL: string;
  DASHBOARD_URL: string;
  PROVIDER_PLATFORM_URL: string;
  CHANNEL_AUTH_ID?: string;
  PRIVACY_CHANNEL_ID?: string;
  [key: string]: string | undefined;
}

export function getRunDir(): string {
  if (process.env.RECORDING_RUN_DIR) return process.env.RECORDING_RUN_DIR;
  const runId = process.env.RUN_ID;
  if (!runId) {
    throw new Error(
      "Set RUN_ID (or RECORDING_RUN_DIR). Run setup-recording-keys.sh first.",
    );
  }
  return path.join(__dirname, "..", "..", "runs", runId);
}

export function loadRunEnv(): RunEnv {
  const file = path.join(getRunDir(), "run.env");
  if (!fs.existsSync(file)) {
    throw new Error(
      `run.env not found at ${file}; run setup-recording-keys.sh`,
    );
  }
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out as unknown as RunEnv;
}

/**
 * Update or insert keys in run.env. For each key:
 *   - replace the FIRST matching active or sentinel line (`KEY=` / `# KEY=`)
 *     in place so positional context is preserved
 *   - drop EVERY other line matching the same key, so reruns can't leave
 *     duplicate `KEY=` rows behind (loadRunEnv is last-wins, which would
 *     otherwise quietly resurrect a stale value)
 *   - if no existing line matches, append one
 */
export function updateRunEnv(updates: Record<string, string>): void {
  const file = path.join(getRunDir(), "run.env");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const placed = new Set<string>();

  const matchKey = (line: string): string | undefined => {
    for (const key of Object.keys(updates)) {
      if (
        new RegExp(`^${key}=`).test(line) ||
        new RegExp(`^#\\s*${key}=`).test(line)
      ) return key;
    }
    return undefined;
  };

  const next: string[] = [];
  for (const line of lines) {
    const key = matchKey(line);
    if (!key) {
      next.push(line);
      continue;
    }
    if (!placed.has(key)) {
      next.push(`${key}=${updates[key]}`);
      placed.add(key);
    }
    // else: silently drop the duplicate
  }

  for (const key of Object.keys(updates)) {
    if (!placed.has(key)) next.push(`${key}=${updates[key]}`);
  }

  fs.writeFileSync(file, next.join("\n"));
}

export function requireValue(env: RunEnv, key: keyof RunEnv): string {
  const v = env[key];
  if (!v) {
    throw new Error(
      `run.env is missing ${String(key)}. Did the prior section run?`,
    );
  }
  return v;
}

/**
 * Persist a multi-line blob (e.g. MLXDR) to <runDir>/<name>.txt so that
 * newlines survive between specs without polluting run.env.
 */
export function writeRunArtifact(name: string, content: string): void {
  const file = path.join(getRunDir(), `${name}.txt`);
  fs.writeFileSync(file, content);
}

export function readRunArtifact(name: string): string | undefined {
  const file = path.join(getRunDir(), `${name}.txt`);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8");
}
