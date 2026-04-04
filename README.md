# Circle-of-minecraft

A quick-start toolkit for running a **Java + Bedrock Minecraft network** on Linux with:

- **Waterfall proxy** (Bungee-compatible)
- **Paper lobby + survival backends**
- **Geyser + Floodgate** support for Bedrock players

---

## What you get

- Automated provisioning script that:
  - Downloads latest Waterfall + Paper builds from PaperMC
  - Creates proxy/lobby/survival structure
  - Sets Bungee-compatible backend settings
  - Installs included `Geyser-BungeeCord.jar` and `floodgate-bungee.jar`
  - Generates start/stop scripts for tmux-based process management
- Production-friendly defaults for a small community server

---

## Requirements

- Linux host (Ubuntu 22.04+ recommended)
- Java 21+
- `python3`
- `curl`
- `tmux`

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
- `PAPER_VERSION` (default: latest stable from PaperMC)
- `WATERFALL_VERSION` (default: latest stable from PaperMC)
- `JAVA_PROXY_MEM` (default: `-Xms512M -Xmx1G`)
- `JAVA_LOBBY_MEM` (default: `-Xms1G -Xmx3G`)
- `JAVA_SURVIVAL_MEM` (default: `-Xms1G -Xmx4G`)

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

Expose only proxy + Bedrock ports publicly:

```bash
sudo ufw allow 25565/tcp
sudo ufw allow 19132/udp
sudo ufw enable
sudo ufw status
```

Keep backend ports (`25566`, `25567`) private.

---

## Notes

- Backends are intentionally `online-mode=false` because authentication is handled by proxy.
- Proxy has `ip_forward: true` and backends have `settings.bungeecord: true`.
- For internet-facing deployments, run behind a reverse proxy/firewall and consider anti-bot/proxy protections.
