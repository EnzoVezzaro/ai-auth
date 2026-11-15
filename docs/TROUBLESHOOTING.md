# Troubleshooting

- **`tsx` missing:** run `npm ci` from the repository root.
- **Port in use:** set `PORT` to an unused local port and use the same port in the SDK/API URL.
- **Browser CORS failure:** set `CORS_ORIGIN` to the exact local website origin, including scheme and port. Restart the service after changing it.
- **WebSocket closes as unauthorized:** register a fresh local agent and use its token with a valid room name. Check token revocation and room syntax.
- **No presence shown:** presence is live only while a WebSocket is connected; send the `ping` heartbeat at least every 45 seconds. Private sessions are hidden.
- **Database is locked/corrupt:** stop the service before moving the local SQLite database; for disposable development state, remove `data/ai-auth.sqlite` and restart.
- **SDK request fails on another origin:** configure `CORS_ORIGIN`, pass the API `baseUrl`, and avoid embedding administrator credentials in the page.
