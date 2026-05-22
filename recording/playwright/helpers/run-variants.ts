/**
 * Per-RUN_ID variants used so the recording rig's council + PP show up as
 * unique entries on the deployed (multi-tenant) testnet dashboard.
 *
 * - Council name: a famous cartoon-cat name (e.g. "Council Garfield"), so
 *   the world-map drilldown can pick our council out of the live list
 *   (28+ councils on testnet) without resorting to opaque numeric suffixes.
 * - PP name: a famous fictional first name (e.g. "Provider Luke"). Same
 *   reason on the council-details PP list.
 * - Jurisdiction: deterministic pick from 8 countries (no longer
 *   hardcoded to US), so successive runs visually distribute on the map.
 *
 * Everything is derived from `RUN_ID` so the four specs agree without
 * passing state through run.env.
 */
import process from "node:process";

const JURISDICTIONS: ReadonlyArray<{ name: string; code: string }> = [
  { name: "United States", code: "us" },
  { name: "Germany", code: "de" },
  { name: "Japan", code: "jp" },
  { name: "Brazil", code: "br" },
  { name: "Australia", code: "au" },
  { name: "United Kingdom", code: "gb" },
  { name: "Canada", code: "ca" },
  { name: "France", code: "fr" },
];

const COUNCIL_NAMES: ReadonlyArray<string> = [
  "Garfield",
  "Felix",
  "Tom",
  "Sylvester",
  "Salem",
  "Cheshire",
  "Heathcliff",
  "Crookshanks",
];

const PROVIDER_NAMES: ReadonlyArray<string> = [
  "Vanguard",
  "Citadel",
  "Sentinel",
  "Helios",
  "Aegis",
  "Meridian",
  "Orion",
  "Apex",
];

function getRunId(): string {
  const id = process.env.RUN_ID;
  if (!id) {
    throw new Error("RUN_ID env var is required for recording rig specs");
  }
  return id;
}

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getCouncilName(): string {
  return `Council ${COUNCIL_NAMES[hash32(getRunId()) % COUNCIL_NAMES.length]}`;
}

export function getProviderName(): string {
  // Offset by a second hash so council + PP names don't lockstep.
  return `Provider ${
    PROVIDER_NAMES[hash32(getRunId() + ":pp") % PROVIDER_NAMES.length]
  }`;
}

export function getJurisdiction(): { name: string; code: string } {
  return JURISDICTIONS[hash32(getRunId()) % JURISDICTIONS.length];
}
