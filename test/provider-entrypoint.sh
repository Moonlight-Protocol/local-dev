#!/bin/sh
set -e

# Copy source from read-only mount, excluding host artifacts
cd /app-src && tar cf - --exclude node_modules --exclude .git --exclude target --exclude .data --exclude .env . | tar xf - -C /app
cd /app

# Write .env so that @std/dotenv load() and drizzle-kit --env both find it.
# Merge config from setup container + docker-compose DATABASE_URL.
if [ -f /config/provider.env ]; then
  cp /config/provider.env .env
fi
echo "DATABASE_URL=${DATABASE_URL}" >> .env

deno install
deno task db:migrate

# Seed DB with test fixture (PP + council membership) if seed.json exists
if [ -f /config/seed.json ]; then
  echo "Seeding database from /config/seed.json..."
  deno eval "
    const postgres = (await import('postgres')).default;
    const sql = postgres(Deno.env.get('DATABASE_URL'));
    const seed = JSON.parse(await Deno.readTextFile('/config/seed.json'));
    const now = new Date();

    await sql\`
      INSERT INTO payment_providers (id, public_key, encrypted_sk, derivation_index, is_active, label, created_at, updated_at)
      VALUES (\${seed.provider.id}, \${seed.provider.publicKey}, \${seed.provider.encryptedSk}, \${seed.provider.derivationIndex}, true, \${seed.provider.label}, \${now}, \${now})
      ON CONFLICT (public_key) DO NOTHING
    \`;

    const configJson = JSON.stringify({
      council: { name: 'E2E Test Council', channelAuthId: seed.membership.channelAuthId },
      channels: [{ channelContractId: seed.membership.channelContractId, assetCode: 'XLM', assetContractId: seed.membership.assetContractId }],
      jurisdictions: [],
      providers: [{ publicKey: seed.provider.publicKey, label: seed.provider.label }],
    });

    await sql\`
      INSERT INTO council_memberships (id, council_url, council_name, council_public_key, channel_auth_id, status, config_json, pp_public_key, created_at, updated_at)
      VALUES (\${seed.membership.id}, 'http://e2e-council', 'E2E Test Council', '', \${seed.membership.channelAuthId}, 'ACTIVE', \${configJson}, \${seed.membership.ppPublicKey}, \${now}, \${now})
      ON CONFLICT DO NOTHING
    \`;

    await sql.end();
    console.log('[seed] DB seeded: PP + council membership');
  "
fi

exec deno task serve
