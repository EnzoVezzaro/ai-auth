# Observability and analytics

The service writes registration, connect/disconnect, status, message, task, lock, revocation, and SDK analytics events to a local SQLite audit table. Agent audit reads are scoped to events whose actor ID is the caller. `/v1/analytics` returns connected public sessions and total audit-row count. Private session connections do not affect public connection counters.

This is not the required product analytics system: there are no latency percentiles, time-series aggregation, structured OpenTelemetry spans/metrics/exporters, dashboards for global administrators, or tamper-evident audit hash chain. The `/dashboard` page polls these API routes and is a basic local view, not a production admin console.
