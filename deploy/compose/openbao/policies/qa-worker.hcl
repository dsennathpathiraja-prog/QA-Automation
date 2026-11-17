# The worker (Connector Execution Manager) is the only reader of connector and environment secrets.
path "qa-platform/data/connectors/*"   { capabilities = ["read"] }
path "qa-platform/data/environments/*" { capabilities = ["read"] }
path "qa-platform/data/llm/*"          { capabilities = ["read"] }
path "qa-platform/data/platform/*"     { capabilities = ["read"] }
path "qa-platform/metadata/*"          { capabilities = ["read", "list"] }
path "qa-platform/metadata/connectors/drafts/*" { capabilities = ["read", "list", "delete"] }
