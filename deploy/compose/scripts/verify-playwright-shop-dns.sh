#!/usr/bin/env bash
# Verify sdk.paynsure.internal (or $SHOP_HOST) resolves inside playwright-mcp the same way Explore UI Chromium will.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/deploy/compose/local/docker-compose.local.yml}"
SHOP_HOST="${SHOP_HOST:-sdk.paynsure.internal}"
SERVICE="${SERVICE:-playwright-mcp}"

echo "== Host resolver =="
if command -v getent >/dev/null 2>&1; then
  getent hosts "$SHOP_HOST" || echo "(getent: no address for $SHOP_HOST — check /etc/hosts or VPN DNS)"
else
  grep -E "[[:space:]]$SHOP_HOST([[:space:]]|$)" /etc/hosts 2>/dev/null || echo "(no /etc/hosts line for $SHOP_HOST)"
fi

echo
echo "== Compose service $SERVICE =="
if ! docker compose -f "$COMPOSE_FILE" --profile browser ps --status running "$SERVICE" 2>/dev/null | grep -q "$SERVICE"; then
  echo "Start the browser profile first:"
  echo "  docker compose -f $COMPOSE_FILE --profile browser up --build -d $SERVICE"
  exit 1
fi

echo "extra_hosts (inspect):"
docker compose -f "$COMPOSE_FILE" --profile browser config 2>/dev/null | sed -n '/playwright-mcp:/,/healthcheck:/p' | grep -E 'extra_hosts|sdk\.paynsure|host.docker' || true

echo
echo "== Resolve inside container =="
docker compose -f "$COMPOSE_FILE" --profile browser exec -T "$SERVICE" \
  node -e "require('dns').lookup(process.argv[1],(e,a,f)=>{if(e){console.error('FAIL',e.message);process.exit(1)};console.log('OK',process.argv[1],'->',a,'(family',f+')');})" \
  "$SHOP_HOST"

echo
echo "== HTTP reachability from Chromium network namespace =="
docker compose -f "$COMPOSE_FILE" --profile browser exec -T "$SERVICE" \
  node -e "fetch('http://'+process.argv[1]+'/shop',{redirect:'follow',signal:AbortSignal.timeout(8000)}).then(r=>{console.log('HTTP',r.status,r.url);process.exit(0)}).catch(e=>{console.error('FAIL',e.cause?.code||e.message);process.exit(1)})" \
  "$SHOP_HOST" || echo "(HTTP check failed — DNS may be OK but the shop is not listening on that IP from the container)"

echo
echo "Done. If DNS FAIL: set PLAYWRIGHT_MCP_SHOP_IP to the host getent address (or host-gateway), then:"
echo "  docker compose -f $COMPOSE_FILE --profile browser up -d --force-recreate $SERVICE"
