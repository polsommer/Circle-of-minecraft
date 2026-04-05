# Admin UI service

A minimal Node.js + Express + HTMX admin panel for controlling Circle of Minecraft services.

## Endpoints

- `GET /health`
- `GET /api/servers`
- `POST /api/servers/:name/start`
- `POST /api/servers/:name/stop`
- `POST /api/servers/:name/restart`
- `GET /api/servers/:name/plugins`
- `POST /api/servers/:name/plugins/upload` (raw `.jar` body; set `?filename=` or `x-plugin-filename`)
- `POST /api/servers/:name/plugins/install-from-url` (JSON body: `{ "url": "https://..." }`)
- `POST /api/servers/:name/plugins/:plugin/enable`
- `POST /api/servers/:name/plugins/:plugin/disable`
- `POST /api/servers/:name/plugins/:plugin/reload`
- `DELETE /api/servers/:name/plugins/:plugin`
- `POST /api/servers/:name/plugins/:plugin/rollback`

Allowed server names: `proxy`, `lobby`, `survival`.

## Configuration

- `ADMIN_UI_HOST` (default: `192.168.88.100`)
- `ADMIN_UI_PORT` (default: `7070`)
- `MC_NETWORK_DIR` (default: `<repo>/mc-network`)
- `PLUGIN_URL_ALLOWLIST` (comma-separated plugin source domains)

## Plugin management notes

- Stages uploads/downloads under `mc-network/.admin-ui/plugins/staging`.
- Validates plugin jars for:
  - `META-INF/MANIFEST.MF`
  - basic manifest markers (`Manifest-Version` and one plugin marker header)
  - signature files (`META-INF/*.SF` and key files such as `.RSA`, `.DSA`, `.EC`)
- Backs up replaced/removed jars to timestamped paths in `mc-network/backups/plugins/<server>/<plugin>/`.
- Writes audit events to `mc-network/backups/admin-ui-audit.log` with actor, action, server, plugin, result, and timestamp.
- Keeps rollback history in `mc-network/backups/plugins/.history.json` and supports rolling back the last plugin change per server/plugin.

## Run

```bash
cd tools/admin-ui
npm install
npm start
```

The command runner never executes raw user input. It resolves commands only from a strict allowlist of script paths under `mc-network/`.
