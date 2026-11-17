#!/usr/bin/env bash
# One-time installer: generates bootstrap credentials, initialises OpenBao, loads policies and AppRoles.
# UNTESTED: written without a Docker host available. Review and dry-run in a throwaway VM first.
#
# Honest limits:
#  - The initial Postgres/Keycloak passwords exist as files in ./secrets (Docker secrets) at first start.
#  - OpenBao unseal keys and the initial root token are PRINTED ONCE and never stored by this script.
#    Hand each unseal key to a different operator.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets

gen() { [ -s "secrets/$1" ] || head -c 36 /dev/urandom | base64 | tr -d '\n=+/' | head -c 40 > "secrets/$1"; }
for s in postgres_password keycloak_db_password platform_db_password keycloak_admin_password; do gen "$s"; done
: > secrets/bao_api_role_id; : > secrets/bao_api_secret_id

compose() { docker compose "$@"; }
bao() { compose exec -T -e BAO_ADDR=http://127.0.0.1:8200 ${BAO_TOKEN:+-e BAO_TOKEN="$BAO_TOKEN"} openbao bao "$@"; }

compose up -d postgres openbao
sleep 5

if bao status -format=json 2>/dev/null | grep -q '"initialized": true'; then
  echo "OpenBao already initialised; skipping init."
else
  echo "Initialising OpenBao (5 key shares, threshold 3). RECORD THE OUTPUT NOW; it is not saved."
  bao operator init -key-shares=5 -key-threshold=3
  echo
  echo "Unseal with three different keys: bao operator unseal <key>   (run 3 times), then re-run this script with BAO_TOKEN=<root token>."
  exit 0
fi

: "${BAO_TOKEN:?export BAO_TOKEN=<initial root token> to configure OpenBao}"

bao secrets enable -path=qa-platform -version=2 kv || true
bao audit enable file file_path=/openbao/audit/audit.log || true
for p in qa-api qa-worker qa-runner-launcher; do
  compose exec -T -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$BAO_TOKEN" openbao bao policy write "$p" - < "openbao/policies/$p.hcl"
done
bao auth enable approle || true
for r in qa-api qa-worker qa-runner-launcher; do
  bao write "auth/approle/role/$r" token_policies="$r" token_ttl=15m token_max_ttl=1h secret_id_ttl=0 secret_id_num_uses=0
done

# AppRole credentials are written to Docker secret files; the platform renews short-lived tokens itself.
bao read -field=role_id auth/approle/role/qa-api/role-id > secrets/bao_api_role_id
bao write -f -field=secret_id auth/approle/role/qa-api/secret-id > secrets/bao_api_secret_id

# Seed platform-owned secrets (database credentials) into OpenBao so services fetch them at runtime.
bao kv put qa-platform/platform/database username=qa_platform password="$(cat secrets/platform_db_password)"

echo "Revoke the root token now:  bao token revoke -self"
echo "Then: docker compose up -d"
