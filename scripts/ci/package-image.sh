#!/usr/bin/env bash
set -Eeuo pipefail
service="backend"
[[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ ]] || { echo 'GITHUB_SHA inválido.' >&2; exit 1; }
image="o-espertinho-${service}:${GITHUB_SHA}"
output="${RUNNER_TEMP:?}/vps-bundle"
mkdir -p "$output"
docker build --pull --label "org.opencontainers.image.revision=$GITHUB_SHA" --tag "$image" .
# Smoke test runs in CI only. Production secrets are never used to build images.
bash scripts/ci/smoke-image.sh "$image"
# PRs verify the image without retaining large deploy archives.
if [[ ${GITHUB_EVENT_NAME:-} == pull_request ]]; then
  printf 'Imagem compilada e smoke test aprovado; pacote de deploy reservado à branch de integração.\n' >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
  exit 0
fi
docker save "$image" | gzip -1 > "$output/image.tar.gz"
cp deploy/compose.production.yml "$output/compose.production.yml"
printf '%s\n' "$image" > "$output/image.ref"
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],JSON.stringify({commit:process.env.GITHUB_SHA,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,createdAt:new Date().toISOString()},null,2)+"\n")' "$output/build-manifest.json"
(cd "$output" && sha256sum image.tar.gz compose.production.yml image.ref build-manifest.json > SHA256SUMS)
printf '### Imagem validada\n\n- Serviço: %s\n- Commit: `%s`\n- Artefato: imagem Docker, Compose e SHA-256.\n' "$service" "$GITHUB_SHA" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
