# Deployment status

This project is designed to run locally. Do not deploy the current service to an untrusted network: registration is open, WebSocket credentials are in URLs, tenant/room ACLs and production rate limiting are absent, and presence is process-local. `HOST=0.0.0.0` is intended only for a trusted local network. Set a strict `CORS_ORIGIN` when using the browser SDK from another local origin.

Production deployment needs a reviewed identity provider flow, audience and scope checks, durable distributed presence, PostgreSQL/Redis, TLS, secure WebSocket credential exchange, migration/backup procedures, key management, retention/deletion controls, observability, and a security review. No Docker Compose, hosted deployment, or production integration is included yet.
