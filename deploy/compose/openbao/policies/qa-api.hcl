# The API may WRITE secrets (wizard, Replace) and check existence/delete, but never READ values.
path "qa-platform/data/connectors/*"   { capabilities = ["create", "update"] }
path "qa-platform/data/environments/*" { capabilities = ["create", "update"] }
path "qa-platform/data/llm/*"          { capabilities = ["create", "update"] }
path "qa-platform/metadata/connectors/*"   { capabilities = ["read", "delete"] }
path "qa-platform/metadata/environments/*" { capabilities = ["read", "delete"] }
path "qa-platform/metadata/llm/*"          { capabilities = ["read", "delete"] }
