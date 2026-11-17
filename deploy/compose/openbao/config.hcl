ui = false
disable_mlock = false

storage "raft" {
  path    = "/openbao/data"
  node_id = "qa-bao-1"
}

# The data network is internal-only. TLS for this listener is a tracked hardening item (see README).
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://openbao:8200"
cluster_addr = "http://openbao:8201"
