# Test-only TLS fixture

`mtls-server-private.pem` and `mtls-server-certificate.pem` are a generated, self-signed
localhost pair used only to prove that the gateway TLS listener rejects clients without a
certificate. They confer no authority in any environment and must never be deployed.
