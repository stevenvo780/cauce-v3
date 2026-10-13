# Test-only TLS fixture

`mtls-server-private.pem` and `mtls-server-certificate.pem` are generated, self-signed localhost fixtures used by gateway tests for certificate-derived identity and mTLS requests,
including accepted-client and missing-client-certificate cases. The tests use local listeners, not the production gateway TLS listener.
They confer no authority in any environment and must never be deployed.
