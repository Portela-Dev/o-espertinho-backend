#!/usr/bin/env bash
set -Eeuo pipefail
image="${1:?}"
name="ci-backend-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
cleanup(){
 docker rm -f "$name" >/dev/null 2>&1 || true
 docker rm -f "$name-db" >/dev/null 2>&1 || true
 docker network rm "$name-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$name-net" >/dev/null
docker run -d --name "$name-db" --network "$name-net" -e POSTGRES_USER=test -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=test postgres:17-alpine >/dev/null
# The bootstrap server accepts Unix sockets before the final TCP server is ready.
database_ready=false
for _attempt in $(seq 1 60); do
 if docker exec -e PGPASSWORD=ci-only-password "$name-db" psql -h 127.0.0.1 -U test -d test -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then database_ready=true; break; fi
 sleep 1
done
if [[ $database_ready != true ]]; then docker logs "$name-db"; echo 'PostgreSQL não ficou pronto para conexões TCP.' >&2; exit 1; fi
settings=(--network "$name-net" -e "DATABASE_URL=postgresql://espertinho_app:ci-only-application-password-32-chars@$name-db:5432/test" -e APP_ORIGIN=https://ci.example.com -e EXTENSION_BACKEND_URL=https://ci.example.com -e RUN_WORKER=false)
docker run --rm "${settings[@]}" -e "MIGRATION_DATABASE_URL=postgresql://test:ci-only-password@$name-db:5432/test" "$image" node dist/provision-database.js
docker run -d --name "$name" "${settings[@]}" "$image" >/dev/null
for _attempt in $(seq 1 90); do
 if docker exec "$name" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
   echo 'Imagem iniciou e respondeu ao healthcheck.'
   :
   exit 0
 fi
 if [[ $(docker inspect --format '{{.State.Running}}' "$name") != true ]]; then break; fi
 sleep 2
done
docker logs "$name"
echo 'A imagem não passou no smoke test.' >&2
exit 1
