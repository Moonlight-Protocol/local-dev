/**
 * The settled scenario (Gorka, 2026-07-23): corp×region councils, providers
 * are countries, bootstrap-as-history over days 0–5, dormancy-heavy entity
 * rosters, corridor-biased cross-country value at the ramps.
 *
 * Everything here is declarative data; timeline.ts turns it into a concrete
 * deterministic schedule.
 */

export type Tier = "big" | "mid" | "small";

export interface CouncilSpec {
  key: string;
  name: string;
  /** ISO country codes; one provider per country. */
  jurisdictions: string[];
  /** Virtual day the council forms (bootstrap-as-history, days 0–5). */
  bootstrapDay: number;
  /** Steady-state busyness multiplier (Careem is the near-idle laggard). */
  activity: number;
}

export const COUNCILS: CouncilSpec[] = [
  {
    key: "meli-mercosur",
    name: "Mercado Libre Mercosur",
    jurisdictions: ["AR", "BR", "UY", "PY"],
    bootstrapDay: 0,
    activity: 1.0,
  },
  {
    key: "amazon-na",
    name: "Amazon North America",
    jurisdictions: ["US", "CA", "MX"],
    bootstrapDay: 1,
    activity: 0.9,
  },
  {
    key: "amazon-eu",
    name: "Amazon Europe",
    jurisdictions: ["DE", "FR", "ES", "IT"],
    bootstrapDay: 2,
    activity: 0.8,
  },
  {
    key: "walmart-mxca",
    name: "Walmart México y Centroamérica",
    // MX overlap with Amazon NA is intentional (settled design).
    jurisdictions: ["MX", "GT", "CR"],
    bootstrapDay: 3,
    activity: 0.6,
  },
  {
    key: "falabella-pacifico",
    name: "Falabella Pacífico",
    jurisdictions: ["CL", "PE", "CO"],
    bootstrapDay: 3,
    activity: 0.7,
  },
  {
    key: "grab-sea",
    name: "Grab Southeast Asia",
    jurisdictions: ["SG", "TH", "PH"],
    bootstrapDay: 4,
    activity: 0.5,
  },
  {
    key: "safaricom-ea",
    name: "Safaricom East Africa",
    jurisdictions: ["KE", "TZ", "UG"],
    bootstrapDay: 4,
    activity: 0.5,
  },
  {
    key: "careem-gulf",
    name: "Careem Gulf",
    jurisdictions: ["AE", "SA"],
    bootstrapDay: 5,
    activity: 0.15,
  },
];

/** Settled tiering: big 150–250 direct entities, mid 50–100, small 15–40. */
const TIER_BY_COUNTRY: Record<string, Tier> = {
  BR: "big",
  MX: "big",
  US: "big",
  AR: "mid",
  CO: "mid",
  DE: "mid",
  FR: "mid",
  ES: "mid",
  IT: "mid",
  CL: "mid",
  PE: "mid",
  CA: "mid",
  SG: "mid",
  TH: "mid",
  KE: "mid",
  SA: "mid",
  AE: "mid",
};

export function tierOf(country: string): Tier {
  return TIER_BY_COUNTRY[country] ?? "small";
}

export const ENTITY_TARGET_RANGE: Record<Tier, [number, number]> = {
  big: [150, 250],
  mid: [50, 100],
  small: [15, 40],
};

/**
 * Steady-state bundle rate per provider at diurnal peak, bundles/hour.
 * With the diurnal/weekday shaping this lands in the settled 2–6
 * bundles/hour/provider band for active providers.
 */
export const PEAK_RATE_BY_TIER: Record<Tier, number> = {
  big: 6,
  mid: 3.5,
  small: 2,
};

/** UTC offsets (approximate, DST ignored) for diurnal shaping. */
export const UTC_OFFSET_BY_COUNTRY: Record<string, number> = {
  AR: -3,
  BR: -3,
  UY: -3,
  PY: -4,
  US: -6,
  CA: -5,
  MX: -6,
  GT: -6,
  CR: -6,
  DE: 1,
  FR: 1,
  ES: 1,
  IT: 1,
  CL: -4,
  PE: -5,
  CO: -5,
  SG: 8,
  TH: 7,
  PH: 8,
  KE: 3,
  TZ: 3,
  UG: 3,
  AE: 4,
  SA: 3,
};

/**
 * Named cross-country corridors (settled: plausible, intra-council).
 * Cross-country picks are biased to a named corridor partner when one exists;
 * intra-EU is handled as "any Amazon Europe pair".
 */
export const CORRIDORS: Array<[string, string]> = [
  ["AR", "UY"],
  ["MX", "US"],
  ["KE", "TZ"],
];

/** Share of send value that stays domestic (settled: ~85–90%). */
export const DOMESTIC_SHARE = 0.875;

export interface AggregatorSpec {
  key: string;
  name: string;
  /** One pay-account per country (pay_account jurisdiction is single-valued). */
  countries: string[];
  /** Rough total invisible end users across its countries. */
  endUsers: number;
  /** Days after the last of its providers is ACTIVE before it appears. */
  entryLagDays: number;
}

export const AGGREGATORS: AggregatorSpec[] = [
  {
    key: "rappipay",
    name: "RappiPay",
    // Spans MELI + Falabella countries (settled).
    countries: ["AR", "BR", "CL", "PE", "CO"],
    endUsers: 2000,
    entryLagDays: 7,
  },
  {
    key: "venmo-style",
    name: "Vemmo",
    countries: ["US"],
    endUsers: 1500,
    entryLagDays: 7,
  },
];

/**
 * Entity display names: modest per-region pools; the engine combines
 * first + last deterministically so rosters look human without shipping a
 * huge dataset.
 */
const NAMES: Record<string, { first: string[]; last: string[] }> = {
  latam: {
    first: [
      "Alicia",
      "Roberto",
      "Camila",
      "Diego",
      "Lucía",
      "Mateo",
      "Valentina",
      "Joaquín",
      "Sofía",
      "Andrés",
    ],
    last: [
      "García",
      "Fernández",
      "Silva",
      "Rodríguez",
      "López",
      "Martínez",
      "Pereira",
      "Sosa",
      "Mendoza",
      "Rojas",
    ],
  },
  brazil: {
    first: [
      "Mariana",
      "Pedro",
      "Beatriz",
      "Lucas",
      "Ana",
      "Gabriel",
      "Júlia",
      "Rafael",
    ],
    last: [
      "Silva",
      "Santos",
      "Oliveira",
      "Souza",
      "Costa",
      "Almeida",
      "Pereira",
      "Lima",
    ],
  },
  anglo: {
    first: [
      "Emma",
      "Liam",
      "Olivia",
      "Noah",
      "Ava",
      "Ethan",
      "Grace",
      "Mason",
    ],
    last: [
      "Smith",
      "Johnson",
      "Brown",
      "Miller",
      "Davis",
      "Wilson",
      "Taylor",
      "Clark",
    ],
  },
  europe: {
    first: [
      "Lena",
      "Paul",
      "Chiara",
      "Hugo",
      "Marta",
      "Luca",
      "Camille",
      "Jonas",
    ],
    last: [
      "Müller",
      "Bernard",
      "Rossi",
      "Fischer",
      "Moreau",
      "Ricci",
      "Weber",
      "Laurent",
    ],
  },
  sea: {
    first: ["Wei", "Ananya", "Somchai", "Maria", "Arun", "Mei", "Jose", "Nok"],
    last: [
      "Tan",
      "Lim",
      "Santos",
      "Nguyen",
      "Chaiyasit",
      "Reyes",
      "Wong",
      "Suwan",
    ],
  },
  eastafrica: {
    first: [
      "Amani",
      "Baraka",
      "Neema",
      "Juma",
      "Zawadi",
      "Kito",
      "Asha",
      "Simba",
    ],
    last: [
      "Mwangi",
      "Okello",
      "Nyerere",
      "Kamau",
      "Abdalla",
      "Mushi",
      "Otieno",
      "Ssemakula",
    ],
  },
  gulf: {
    first: [
      "Omar",
      "Layla",
      "Khalid",
      "Noor",
      "Faisal",
      "Huda",
      "Zayd",
      "Rana",
    ],
    last: [
      "Al-Rashid",
      "Haddad",
      "Al-Farsi",
      "Nasser",
      "Al-Amin",
      "Karim",
      "Saleh",
      "Al-Zahrani",
    ],
  },
};

const NAME_REGION_BY_COUNTRY: Record<string, keyof typeof NAMES> = {
  AR: "latam",
  UY: "latam",
  PY: "latam",
  MX: "latam",
  GT: "latam",
  CR: "latam",
  CL: "latam",
  PE: "latam",
  CO: "latam",
  ES: "latam",
  BR: "brazil",
  US: "anglo",
  CA: "anglo",
  DE: "europe",
  FR: "europe",
  IT: "europe",
  SG: "sea",
  TH: "sea",
  PH: "sea",
  KE: "eastafrica",
  TZ: "eastafrica",
  UG: "eastafrica",
  AE: "gulf",
  SA: "gulf",
};

/** Share of the roster that holds USDC (local grants / testnet treasury). */
export function usdcEligible(index: number): boolean {
  return index % 10 < 3;
}

export function namePool(country: string): { first: string[]; last: string[] } {
  return NAMES[NAME_REGION_BY_COUNTRY[country] ?? "anglo"];
}
