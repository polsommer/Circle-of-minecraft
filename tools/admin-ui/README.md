# Admin UI service

A minimal Node.js + Express + HTMX admin panel for controlling Circle of Minecraft services.

## Endpoints

- `GET /health`
- `GET /api/servers`
- `POST /api/servers/:name/start`
- `POST /api/servers/:name/stop`
- `POST /api/servers/:name/restart`

Allowed server names: `proxy`, `lobby`, `survival`.

## Configuration

- `ADMIN_UI_HOST` (default: `192.168.88.100`)
- `ADMIN_UI_PORT` (default: `7070`)
- `MC_NETWORK_DIR` (default: `<repo>/mc-network`)

## Run

```bash
cd tools/admin-ui
npm install
npm start
```

The command runner never executes raw user input. It resolves commands only from a strict allowlist of script paths under `mc-network/`.
