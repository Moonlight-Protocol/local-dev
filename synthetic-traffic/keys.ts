/**
 * Key derivation: every synthetic identity derives from SYNTRAF_MASTER_SECRET
 * via lib/master-seed's scheme (SHA-256(masterSeed || role || index)), with
 * engine-scoped role strings so nothing collides with local-dev's standard
 * roles. State loss never loses identities.
 */
import type { Keypair } from "stellar-sdk";
import { deriveKeypair, masterSeedFromSecret } from "../lib/master-seed.ts";

export class KeyRing {
  private constructor(
    private seed: Uint8Array,
    /** hex-ish digest string used to seed the deterministic Rng streams. */
    readonly rngSeed: string,
  ) {}

  static async open(masterSecret: string): Promise<KeyRing> {
    const seed = await masterSeedFromSecret(masterSecret);
    const rngSeed = Array.from(seed.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return new KeyRing(seed, rngSeed);
  }

  /** Council admin account (deploys contracts, approves providers). */
  councilAdmin(councilKey: string): Promise<Keypair> {
    return deriveKeypair(this.seed, `syntraf-council-admin:${councilKey}`, 0);
  }

  /** Provider identity key (registered on-chain via add_provider). */
  provider(providerKey: string): Promise<Keypair> {
    return deriveKeypair(this.seed, `syntraf-pp:${providerKey}`, 0);
  }

  /** Entity wallet (Ed25519 root; P-256 UTXO keys derive from it in the SDK). */
  entity(providerKey: string, index: number): Promise<Keypair> {
    return deriveKeypair(this.seed, `syntraf-entity:${providerKey}`, index);
  }

  /** Aggregator per-country merchant wallet. */
  aggregator(aggKey: string, country: string): Promise<Keypair> {
    return deriveKeypair(this.seed, `syntraf-agg:${aggKey}:${country}`, 0);
  }

  /** Aggregator per-country custodial OpEx account. */
  aggregatorOpex(aggKey: string, country: string): Promise<Keypair> {
    return deriveKeypair(this.seed, `syntraf-agg-opex:${aggKey}:${country}`, 0);
  }

  /** Invisible end-user wallet from the aggregator's customer pool. */
  aggregatorUser(
    aggKey: string,
    country: string,
    index: number,
  ): Promise<Keypair> {
    return deriveKeypair(
      this.seed,
      `syntraf-agg-user:${aggKey}:${country}`,
      index,
    );
  }

  /** USDC issuer/treasury for local runs (testnet uses Circle's issuer). */
  usdcIssuer(): Promise<Keypair> {
    return deriveKeypair(this.seed, "syntraf-usdc-issuer", 0);
  }
}
