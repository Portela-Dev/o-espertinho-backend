#!/usr/bin/env bash
set -Eeuo pipefail
service="backend"
root="${1:?}"; release_id="${2:?}"; expected_sha="${3:?}"
[[ $root == "/opt/o-espertinho/$service" && $expected_sha =~ ^[a-f0-9]{40}$ && $release_id =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 1
release="$root/releases/$release_id"
[[ -f "$root/.env" && ! -L "$root/.env" ]] || { echo "Prepare $root/.env na VPS antes do deploy." >&2; exit 1; }
command -v flock >/dev/null
exec 9> "$root/deploy.lock"
flock -n 9 || { echo 'Já existe um deploy deste serviço em andamento.' >&2; exit 1; }
docker compose version >/dev/null
cd "$release"
sha256sum --check SHA256SUMS
IFS= read -r APP_IMAGE < image.ref
[[ $APP_IMAGE == "o-espertinho-$service:$expected_sha" ]] || { echo 'Imagem difere do commit validado.' >&2; exit 1; }
export APP_IMAGE
export VPS_ENV_FILE="$root/.env"
chmod 600 "$VPS_ENV_FILE"
compose=(docker compose --env-file "$VPS_ENV_FILE" -p "o-espertinho-$service" -f "$release/compose.production.yml")
"${compose[@]}" config --quiet
if ! docker network inspect espertinho-internal >/dev/null 2>&1; then
  docker network create espertinho-internal >/dev/null || docker network inspect espertinho-internal >/dev/null
fi
gunzip -c image.tar.gz | docker load >/dev/null
# A failed container replacement attempts to restore the previous healthy image.
# SQL migrations are not undone by image rollback.
previous=''
if [[ -L "$root/current" ]]; then previous=$(readlink -f "$root/current"); fi
restore_previous(){
  local code=$?
  trap - ERR
  echo 'Deploy falhou; confira o job e o estado do serviço na VPS.' >&2
  if [[ -n $previous && $previous == "$root/releases/"* && -f "$previous/image.ref" ]]; then
    IFS= read -r APP_IMAGE < "$previous/image.ref"
    if [[ $APP_IMAGE =~ ^o-espertinho-backend:[a-f0-9]{40}$ ]]; then
      export APP_IMAGE
      docker compose --env-file "$VPS_ENV_FILE" -p "o-espertinho-$service" -f "$previous/compose.production.yml" up -d --no-deps --wait --wait-timeout 180 "$service" || true
    fi
  fi
  exit "$code"
}
"${compose[@]}" up -d --wait --wait-timeout 120 postgres
mkdir -p "$root/backups"
chmod 700 "$root/backups"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$root/backups/pre-$release_id.dump"
chmod 600 "$root/backups/pre-$release_id.dump"
"${compose[@]}" run --rm --no-deps migrate
trap restore_previous ERR
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 "$service"
ln -sfn "$release" "$root/current"
trap - ERR
# Keep old images and release metadata for rollback; discard only this transferred archive.
rm -- "$release/image.tar.gz"
echo "Serviço $service atualizado para $expected_sha."
