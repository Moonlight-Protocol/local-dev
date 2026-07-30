/**
 * Post-run council cleanup shared by the testnet suites.
 *
 * testnet/main.ts and lifecycle/testnet-verify.ts each create an ephemeral
 * listed council per run; without a sweep those accumulate on council-platform
 * and pollute the public network dashboard (counters, directory, live feed).
 *
 * The sweep deletes every council OWNED by the suite's admin key rather than
 * just this run's id: with MASTER_SECRET-derived keys that also collects
 * leftovers from earlier runs that died before their own cleanup. With random
 * keys (MASTER_SECRET unset) only this run's council is owned — and a run
 * that dies mid-flow leaks a council no key can ever delete again, so
 * deployed-testnet invocations should always set MASTER_SECRET.
 */
export async function cleanupOwnedCouncils(
  councilUrl: string,
  adminJwt: string,
): Promise<void> {
  const listRes = await fetch(`${councilUrl}/api/v1/council/list`, {
    headers: { Authorization: `Bearer ${adminJwt}` },
  });
  if (!listRes.ok) {
    throw new Error(
      `Council list failed: ${listRes.status} ${await listRes.text()}`,
    );
  }
  const { data } = await listRes.json() as {
    data?: { councilId: string; name: string }[];
  };
  for (const council of data ?? []) {
    const delRes = await fetch(
      `${councilUrl}/api/v1/council/metadata?councilId=${
        encodeURIComponent(council.councilId)
      }`,
      { method: "DELETE", headers: { Authorization: `Bearer ${adminJwt}` } },
    );
    if (!delRes.ok) {
      throw new Error(
        `De-list ${council.councilId} failed: ${delRes.status} ${await delRes
          .text()}`,
      );
    }
    console.log(`  De-listed "${council.name}" (${council.councilId})`);
  }
}
