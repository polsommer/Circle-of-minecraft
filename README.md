# Circle-of-minecraft

A quick-start toolkit for running a **Java + Bedrock Minecraft network** on Linux with:

- **Waterfall proxy** (Bungee-compatible)
- **Paper lobby + survival backends**
- **Geyser + Floodgate** support for Bedrock players

---

## What you get

- Automated provisioning script that:
  - Downloads latest Waterfall + Paper builds from PaperMC
  - Aligns Paper backend version to Waterfall version by default (prevents proxy/backend protocol mismatch)
  - Downloads latest Geyser + Floodgate proxy plugins from Modrinth
  - Downloads ViaVersion on the proxy to allow broader Java client compatibility
  - Creates proxy/lobby/survival structure
  - Sets Bungee-compatible backend settings
  - Falls back to bundled `Geyser-BungeeCord.jar` and `floodgate-bungee.jar` only if plugin API lookup fails
  - Generates start/stop scripts for tmux-based process management
- Production-friendly defaults for a small community server

---

## Requirements

- Linux host (Ubuntu 22.04+ recommended)
- Java 21+
- `python3`
- `curl`
- `tmux`
- internet access (to fetch latest server and plugin binaries)

Install dependencies on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y openjdk-21-jre-headless python3 curl tmux ufw
java -version
```

---

## Easy clone + setup guide

If you are starting from scratch, use these exact commands:

```bash
git clone https://github.com/polsommer/Circle-of-minecraft.git
cd Circle-of-minecraft
chmod +x scripts/provision-network.sh
./scripts/provision-network.sh
```

That will clone the repo, enter the project folder, and provision your Minecraft network.

---

## One-command setup

From this repository root:

```bash
chmod +x scripts/provision-network.sh
./scripts/provision-network.sh
```

This creates `./mc-network` with:

- `proxy/` (Waterfall + plugins)
- `lobby/` (Paper backend on `25566`)
- `survival/` (Paper backend on `25567`)
- `start-all.sh` / `stop-all.sh`

### Optional environment overrides

```bash
NETWORK_DIR=/srv/mc-network PAPER_VERSION=1.21.4 ./scripts/provision-network.sh
```

Useful knobs:

- `NETWORK_DIR` (default: `./mc-network`)
- `PAPER_VERSION` (default: same Minecraft version as resolved Waterfall build)
- `WATERFALL_VERSION` (default: latest stable from PaperMC)
- `JAVA_PROXY_MEM` (default: `-Xms512M -Xmx1G`)
- `JAVA_LOBBY_MEM` (default: `-Xms1G -Xmx3G`)
- `JAVA_SURVIVAL_MEM` (default: `-Xms1G -Xmx4G`)
- `PROXY_LISTEN_IP` (default: `192.168.88.100`)
  - If this IP is not present on the machine, provisioning falls back to `0.0.0.0` so the proxy still starts.
- `BACKEND_START_TIMEOUT` (default in `start-all.sh`: `240` seconds)
  - Increase this if first boot is slow (chunk generation/plugins), for example:
    `BACKEND_START_TIMEOUT=420 ./start-all.sh`
- `PRESERVE_EXISTING_JARS=1` (default: `0`)
  - By default, provisioning refreshes Waterfall/Paper jars to the resolved latest build each run.
  - Set to `1` only if you intentionally want to keep already-downloaded jar files.

---

## Start the network

```bash
cd mc-network
./start-all.sh
```

Tmux sessions created:

- `mc-lobby`
- `mc-survival`
- `mc-proxy`

Attach to console:

```bash
tmux attach -t mc-proxy
```

Stop all sessions:

```bash
./stop-all.sh
```

---

## Bedrock support (Geyser + Floodgate)

After first proxy boot, Geyser generates config files under:

- `mc-network/proxy/plugins/Geyser-BungeeCord/`

Recommended check in `config.yml`:

- `auth-type: floodgate`
- Bedrock port (`19132/udp`) open in firewall

Floodgate key/config files are generated automatically on first run.

---

## Firewall (recommended)

For host `192.168.88.100`, expose only intended ports and keep everything else denied.

### LAN-only admin UI + public game ports

```bash
# default deny incoming
sudo ufw default deny incoming

# Java + Bedrock gameplay
sudo ufw allow 25565/tcp
sudo ufw allow 19132/udp

# Admin UI is LAN-restricted to 192.168.88.0/24 (host binds to 192.168.88.100)
sudo ufw allow from 192.168.88.0/24 to 192.168.88.100 port 7070 proto tcp

# NEVER expose backend Paper ports publicly
# (keep 25566/tcp and 25567/tcp blocked)

sudo ufw enable
sudo ufw status numbered
```

If you do not need remote Admin UI access, do not add the 7070 rule at all.

---

## Notes

- Backends are intentionally `online-mode=false` because authentication is handled by proxy.
- Proxy has `ip_forward: true` and backends have `settings.bungeecord: true`.
- For internet-facing deployments, run behind a reverse proxy/firewall and consider anti-bot/proxy protections.

---

## Troubleshooting: “Server is outdated”

If players see **“Outdated server/client”** when joining:

1. Re-run provisioning so proxy/backends are refreshed to current builds:

   ```bash
   ./scripts/provision-network.sh
   ```

2. Restart all tmux sessions:

   ```bash
   cd mc-network
   ./stop-all.sh
   ./start-all.sh
   ```

3. Confirm the client version:
   - **Java:** ViaVersion helps old/new Java clients, but very old versions can still fail depending on protocol gaps.
   - **Bedrock:** Ensure Geyser is loaded in `mc-network/proxy/plugins/` and UDP `19132` is open.

4. If you intentionally pinned old jars, remove `PRESERVE_EXISTING_JARS=1` and provision again.

---

## Troubleshooting: “Could not connect to a default or fallback server”

If the proxy log includes `finishConnect(..) failed: Connection refused: /127.0.0.1:25566`, the backend server was not listening yet (or failed to start).

1. Re-run provisioning to regenerate the improved `start-all.sh` that waits for backend ports before starting the proxy:

   ```bash
   ./scripts/provision-network.sh
   ```

2. Restart sessions:

   ```bash
   cd mc-network
   ./stop-all.sh
   ./start-all.sh
   ```

3. If it still fails, check backend tmux logs directly:

   ```bash
   tmux attach -t mc-lobby
   tmux attach -t mc-survival
   ```

   Common causes are Java version mismatch, plugin crashes, or an existing process already using `25566/25567`.
4. If `start-all.sh` reports a backend timeout, it now prints the last backend log lines automatically. You can also increase wait time:

   ```bash
   BACKEND_START_TIMEOUT=420 ./start-all.sh
   ```

## Troubleshooting: Paper crashes on startup with config deserialize errors

If a backend crashes with errors like:

- `Loading a newer configuration than is supported`
- `Could not deserialize value ... despawn-ranges`
- `NumberFormatException: For input string: "default"`

your existing Paper config files were generated by an incompatible build.

Re-run provisioning:

```bash
./scripts/provision-network.sh
```

The script now auto-backs up and removes stale Paper config files so the current jar can regenerate compatible defaults on next boot.
