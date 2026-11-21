#!/usr/bin/env bash
# Verify sdk.paynsure.internal (or $SHOP_HOST) resolves inside playwright-mcp the same way Explore UI Chromium will.
# Also checks HTTP status — DNS OK + HTTP 4xx/5xx usually means PLAYWRIGHT_MCP_SHOP_IP points at the wrong host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/deploy/compose/local/docker-compose.local.yml}"
SHOP_OVERLAY="${SHOP_OVERLAY:-$ROOT/deploy/compose/local/docker-compose.playwright-shop.yml}"
SHOP_HOST="${SHOP_HOST:-sdk.paynsure.internal}"
SERVICE="${SERVICE:-playwright-mcp}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [[ -f "$SHOP_OVERLAY" ]] && [[ -n "${PLAYWRIGHT_MCP_SHOP_IP:-}" ]]; then
  COMPOSE+=(-f "$SHOP_OVERLAY")
fi

echo "== Host resolver =="
if command -v getent >/dev/null 2>&1; then
  getent hosts "$SHOP_HOST" || echo "(getent: no address for $SHOP_HOST — check /etc/hosts or VPN DNS)"
else
  grep -E "[[:space:]]$SHOP_HOST([[:space:]]|$)" /etc/hosts 2>/dev/null || echo "(no /etc/hosts line for $SHOP_HOST)"
fi
echo "PLAYWRIGHT_MCP_SHOP_IP=${PLAYWRIGHT_MCP_SHOP_IP:-<(unset)>}"

echo
echo "== Compose service $SERVICE =="
if ! "${COMPOSE[@]}" --profile browser ps --status running "$SERVICE" 2>/dev/null | grep -q "$SERVICE"; then
  echo "Start the browser profile first (with shop overlay when using private DNS):"
  echo "  PLAYWRIGHT_MCP_SHOP_IP=<lan-ip> docker compose -f $COMPOSE_FILE -f $SHOP_OVERLAY --profile browser up --build -d $SERVICE"
  exit 1
fi

echo "extra_hosts (inspect):"
"${COMPOSE[@]}" --profile browser config 2>/dev/null | sed -n '/playwright-mcp:/,/healthcheck:/p' | grep -E 'extra_hosts|sdk\.paynsure|host.docker' || true

echo
echo "== Resolve inside container =="
"${COMPOSE[@]}" --profile browser exec -T "$SERVICE" \
  node -e "require('dns').lookup(process.argv[1],(e,a,f)=>{if(e){console.error('FAIL',e.message);process.exit(1)};console.log('OK',process.argv[1],'->',a,'(family',f+')');})" \
  "$SHOP_HOST"

echo
echo "== HTTP reachability from Chromium network namespace =="
HTTP_OUT="$("${COMPOSE[@]}" --profile browser exec -T "$SERVICE" \
  node -e "
fetch('http://'+process.argv[1]+'/shop',{redirect:'follow',signal:AbortSignal.timeout(8000)})
  .then(async r=>{
    console.log('HTTP', r.status, r.url);
    if (r.status >= 400) process.exit(2);
    process.exit(0);
  })
  .catch(e=>{ console.error('FAIL', e.cause?.code||e.message); process.exit(1); })
" "$SHOP_HOST" 2>&1)" || status=$?
echo "$HTTP_OUT"
status="${status:-0}"
if [[ "$status" -eq 2 ]]; then
  echo
  echo "HTTP status >= 400: DNS worked but the server rejected the request (wrong IP / VirtualHost)."
  echo "Set PLAYWRIGHT_MCP_SHOP_IP to the host DNS A record for $SHOP_HOST (not host-gateway unless the shop is on the Docker host),"
  echo "recreate with -f $SHOP_OVERLAY, then re-run this script (expect HTTP 2xx)."
  exit 2
fi
if [[ "$status" -ne 0 ]]; then
  echo "(HTTP check failed — DNS may be OK but the shop is not reachable from the container)"
  exit 1
fi

echo
echo "Done. Explore UI needs this HTTP 2xx path. If DNS FAIL: set PLAYWRIGHT_MCP_SHOP_IP and:"
echo "  docker compose -f $COMPOSE_FILE -f $SHOP_OVERLAY --profile browser up -d --force-recreate $SERVICE"
