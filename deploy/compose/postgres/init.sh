#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE ROLE qa_platform LOGIN PASSWORD '$(cat "$PLATFORM_DB_PASSWORD_FILE")';
CREATE ROLE keycloak LOGIN PASSWORD '$(cat "$KEYCLOAK_DB_PASSWORD_FILE")';
CREATE DATABASE qa_platform OWNER qa_platform;
CREATE DATABASE keycloak OWNER keycloak;
SQL
