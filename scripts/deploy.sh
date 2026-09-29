#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: scripts/deploy.sh <private-runtime-directory> <command> [args...]
  up                 Build, validate, stop app, migrate, and start healthy services
  ps                 Show service status
  logs [args...]     Show logs (e.g. logs --tail 100 team-manager)
  stop [services...]  Stop services, retaining data
  down               Remove containers/network, retaining database volume
  db-status          Check pending migrations
  exec <args...>      Run a Compose exec command (e.g. exec -T postgres ...)
Requires Docker Engine, Docker Compose v2 with up --wait, and config.yaml in the runtime directory.
USAGE
}

if [[ $# -lt 2 ]]; then usage >&2; exit 2; fi
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_dir="$(cd "$1" && pwd -P)"
action="$2"
shift 2
case "$action" in
  up|ps|down|db-status) [[ $# -eq 0 ]] || { usage >&2; exit 2; } ;;
  logs|exec|stop) ;;
  *) usage >&2; exit 2 ;;
esac
case "$runtime_dir/" in
  "$source_dir/"*) printf '%s\n' 'Runtime directory must be outside the source checkout.' >&2; exit 2 ;;
esac
[[ -f "$runtime_dir/config.yaml" ]] || { printf '%s\n' 'Missing runtime config.yaml; copy config.example.yaml and fill in secrets first.' >&2; exit 2; }
command -v docker >/dev/null || { printf '%s\n' 'Docker is required.' >&2; exit 1; }
docker compose version >/dev/null

# Bootstrap the config reader from the application image; no host Node/pnpm needed.
if [[ "$action" == up ]]; then
  docker build --tag team-manager:local "$source_dir"
else
  docker image inspect team-manager:local >/dev/null 2>&1 || { printf '%s\n' 'Application image missing; run up first.' >&2; exit 1; }
fi

runtime_env="$(mktemp "${TMPDIR:-/tmp}/team-manager-env.XXXXXX")"
trap 'rm -f "$runtime_env"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --network none \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$runtime_dir,target=/runtime" \
  team-manager:local node apps/server/dist/configCli.js compose-env \
  --config /runtime/config.yaml > "$runtime_env"
# No eval/source: dollars, quotes, backticks and line breaks remain literal values.
while IFS= read -r -d '' assignment; do
  [[ "$assignment" == TEAMMGR_*=* ]] || { printf '%s\n' 'Invalid runtime environment output.' >&2; exit 1; }
  export "$assignment"
done < "$runtime_env"
rm -f "$runtime_env"
export TEAMMGR_RUNTIME_DIR="$runtime_dir"

compose() {
  docker compose --env-file /dev/null --project-name team-manager \
    --file "$source_dir/docker-compose.yaml" "$@"
}

compose config --quiet
case "$action" in
  up)
    # Build before taking down the running app; do not migrate under live writers.
    compose build curl-cffi-worker
    compose stop team-manager
    compose up -d --wait --wait-timeout 120 postgres curl-cffi-worker
    compose run --rm --no-deps migrate
    compose up -d --no-build --wait --wait-timeout 120 team-manager
    compose ps
    ;;
  db-status)
    compose run --rm --no-deps migrate node apps/server/dist/database/cli.js status --config /runtime/config.yaml --profile compose
    ;;
  *) compose "$action" "$@" ;;
esac
