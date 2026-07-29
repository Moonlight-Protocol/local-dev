# synthetic-traffic engine image. Build context = repo root:
#   docker build -f synthetic-traffic/Dockerfile .
# The engine shells out to the stellar CLI + stellar-registry plugin, so a
# rust stage builds those once; runtime is the pinned deno image.

FROM rust:1.93-slim AS cli
RUN apt-get update && apt-get install -y --no-install-recommends git curl pkg-config libssl-dev libdbus-1-dev ca-certificates && rm -rf /var/lib/apt/lists/*
ARG STELLAR_CLI_VERSION=23.1.4
RUN curl -fsSL "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
  | tar -xz -C /usr/local/bin stellar
RUN cargo install --locked --git https://github.com/stellar-registry/cli stellar-registry-cli --root /usr/local

FROM denoland/deno:2.7.9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/stellar /usr/local/bin/stellar
COPY --from=cli /usr/local/bin/stellar-registry /usr/local/bin/stellar-registry
WORKDIR /app
COPY lib/ lib/
COPY synthetic-traffic/ synthetic-traffic/
WORKDIR /app/synthetic-traffic
RUN deno install --allow-scripts && deno check main.ts
# Wasms are fetched at build time so the image is self-contained.
RUN mkdir -p wasms
ARG CONTRACTS_VERSION=0.5.0
RUN curl -fsSL -o wasms/channel_auth_contract.wasm "https://github.com/Moonlight-Protocol/soroban-core/releases/download/v${CONTRACTS_VERSION}/channel_auth_contract.wasm" \
 && curl -fsSL -o wasms/privacy_channel.wasm "https://github.com/Moonlight-Protocol/soroban-core/releases/download/v${CONTRACTS_VERSION}/privacy_channel.wasm"
CMD ["deno", "run", "--allow-all", "main.ts"]
