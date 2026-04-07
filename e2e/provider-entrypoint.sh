#!/bin/sh
set -e

# Source config written by setup container
if [ -f /config/provider.env ]; then
  echo "Loading config from /config/provider.env..."
  set -a
  . /config/provider.env
  set +a
fi

echo "Running database migrations..."
deno task db:migrate

# Seed DB with PP and council membership from /config/seed.json
if [ -f /config/seed.json ]; then
  echo "Seeding database from /config/seed.json..."
  deno eval "
    const postgres = (await import('postgres')).default;
    const { encryptSk } = await import('./src/core/crypto/encrypt-sk.ts');
    const sql = postgres(Deno.env.get('DATABASE_URL'));
    const seed = JSON.parse(await Deno.readTextFile('/config/seed.json'));
    const now = new Date();
    const encryptedSk = await encryptSk(seed.provider.secretKey, Deno.env.get('SERVICE_AUTH_SECRET'));

    await sql\`
      INSERT INTO payment_providers (id, public_key, encrypted_sk, derivation_index, is_active, label, created_at, updated_at)
      VALUES (\${seed.provider.id}, \${seed.provider.publicKey}, \${encryptedSk}, \${seed.provider.derivationIndex}, true, \${seed.provider.label}, \${now}, \${now})
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

echo "Starting provider platform..."
exec deno task serve
