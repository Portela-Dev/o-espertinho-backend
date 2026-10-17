#!/usr/bin/env bash
set -Eeuo pipefail
service="backend"
for key in VPS_HOST VPS_USER VPS_SSH_PRIVATE_KEY VPS_KNOWN_HOSTS; do
  [[ -n ${!key:-} ]] || { echo "Configure $key no environment production." >&2; exit 1; }
done
[[ $VPS_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'VPS_HOST inválido.' >&2; exit 1; }
[[ $VPS_USER =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || { echo 'VPS_USER inválido.' >&2; exit 1; }
port="${VPS_PORT:-22}"
[[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port>=1 && 10#$port<=65535)) || { echo 'VPS_PORT inválida.' >&2; exit 1; }
[[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]] || exit 1
release="$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
root="/opt/o-espertinho/$service"
remote="$root/releases/$release"
bundle="${RUNNER_TEMP:?}/vps-bundle"
(cd "$bundle" && sha256sum --check SHA256SUMS)
keydir=$(mktemp -d "${RUNNER_TEMP}/vps-ssh.XXXXXX")
trap 'rm -rf -- "$keydir"' EXIT
chmod 700 "$keydir"
printf '%s\n' "$VPS_SSH_PRIVATE_KEY" | tr -d '\r' > "$keydir/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$keydir/known_hosts"
chmod 600 "$keydir/key" "$keydir/known_hosts"
options=(-i "$keydir/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$keydir/known_hosts" -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
target="$VPS_USER@$VPS_HOST"
# shellcheck disable=SC2029 # Validated path arguments intentionally expand on the client.
ssh "${options[@]}" -p "$port" "$target" "umask 077; mkdir -p '$remote'"
scp "${options[@]}" -P "$port" "$bundle/"* "$target:$remote/"
# shellcheck disable=SC2029 # Only validated release identifiers are sent as arguments.
ssh "${options[@]}" -p "$port" "$target" "bash -s -- '$root' '$release' '$GITHUB_SHA'" < scripts/ci/deploy-remote.sh
printf '### Deploy concluído\n\n- Serviço: %s\n- Commit: `%s`\n- Healthcheck do container: aprovado.\n' "$service" "$GITHUB_SHA" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
