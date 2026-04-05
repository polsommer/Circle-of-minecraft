# Admin UI service

A minimal Node.js + Express + HTMX admin panel for controlling Circle of Minecraft services.

## Security defaults (new)

- **Authentication required** for all `/api/*` and `/ws` endpoints.
- **Admin login** via `POST /api/auth/login` with session cookie.
- Credentials are loaded from either:
  - env vars `ADMIN_UI_ADMIN_USER` + `ADMIN_UI_ADMIN_PASSWORD_HASH`, or
  - secret file (`ADMIN_UI_AUTH_FILE`, default: `<repo>/.secrets/admin-ui-auth.json`).
- Password hash format: `scrypt$<salt>$<hexDigest>`.
- **CSRF protection**: all mutating requests (`POST/PUT/PATCH/DELETE`) require `x-csrf-token` from `/api/auth/session` or login response.
- **Rate limiting** per IP (global + login scope).
- **IP access restriction by default** to private/LAN CIDRs and loopback.
- **IP request logging** to `mc-network/backups/admin-ui-access.log` (or `ADMIN_UI_ACCESS_LOG`).
- **CORS deny-by-default**: no cross-origin requests are allowed unless explicitly configured.
- **Strict validation** for server/action/plugin params and plugin install URL body.

## Endpoints

- `GET /health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`
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

Authentication/session:

- `ADMIN_UI_ADMIN_USER`
- `ADMIN_UI_ADMIN_PASSWORD_HASH`
- `ADMIN_UI_AUTH_FILE` (default: `<repo>/.secrets/admin-ui-auth.json`)
- `ADMIN_UI_SESSION_COOKIE` (default: `admin_ui_session`)
- `ADMIN_UI_SECURE_COOKIE` (`1` to set `Secure`)
- `ADMIN_UI_SESSION_TTL_MS` (default: 8h)

Network hardening:

- `ADMIN_UI_IP_ALLOWLIST` (CIDR CSV; default only loopback + RFC1918 private ranges)
- `ADMIN_UI_CORS_ALLOWLIST` (exact origin CSV; default empty/deny)

Rate limiting:

- `ADMIN_UI_RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `ADMIN_UI_RATE_LIMIT_MAX_REQUESTS` (default: `120`)
- `ADMIN_UI_RATE_LIMIT_MAX_AUTH_ATTEMPTS` (default: `10`)

Audit logging:

- `ADMIN_UI_ACCESS_LOG` (default: `mc-network/backups/admin-ui-access.log`)

## Secret file example

Create `.secrets/admin-ui-auth.json`:

```json
{
  "username": "admin",
  "passwordHash": "scrypt$REPLACE_WITH_SALT$REPLACE_WITH_HEX_DIGEST"
}
```

Generate a hash with Node:

```bash
node -e 'const c=require("crypto");const p=process.argv[1];const s=c.randomBytes(16).toString("hex");const d=c.scryptSync(p,s,64).toString("hex");console.log(`scrypt$${s}$${d}`)' 'ChangeMeNow!'
```

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
