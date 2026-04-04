# Circle-of-minecraft

A quick-start guide to run a **Java + Bedrock Minecraft network** using **BungeeCord** (no Docker).

---

## What this setup gives you

- One proxy server (BungeeCord) that players connect to.
- Multiple backend Paper/Spigot servers (lobby, survival, etc.).
- Java players connect directly.
- Bedrock players connect through **Geyser + Floodgate**.

> Recommended for stability: use **Waterfall** (Bungee-compatible) instead of vanilla BungeeCord. If you want strict BungeeCord, the steps are nearly identical.

---

## Requirements

### Hardware (minimum for small network)

- 4 vCPU
- 8 GB RAM
- SSD storage (strongly recommended)
- Linux server (Ubuntu 22.04+ suggested)

### Software

- Java 21 (or Java version required by your proxy/backend builds)
- `screen` or `tmux` (for background sessions)
- `ufw`/firewall management
- Optional but recommended:
  - `git`
  - `curl`
  - `unzip`

Install basics (Ubuntu/Debian):

```bash
sudo apt update
sudo apt install -y openjdk-21-jre-headless screen curl ufw
java -version
```

---

## Network layout example

- Proxy (Bungee/Waterfall): `25565`
- Lobby backend: `25566`
- Survival backend: `25567`

Only expose **25565** publicly.
Keep backend ports firewalled/private.

---

## 1) Create folders

```bash
mkdir -p ~/mc-network/{proxy,lobby,survival,plugins,backups}
cd ~/mc-network
```

---

## 2) Set up the proxy (BungeeCord/Waterfall)

1. Download the proxy jar into `~/mc-network/proxy`.
2. Start once to generate config files.

```bash
cd ~/mc-network/proxy
# Example (replace jar name with your actual file)
java -Xms512M -Xmx1G -jar waterfall.jar
```

Stop it after first boot.

### Configure `config.yml` (proxy)

Key points:

- Set `ip_forward: true`
- Add backend servers under `servers:`
- Set a listener host/port (usually `0.0.0.0:25565`)
- Use forced host if needed for subdomains

Example server section:

```yaml
servers:
  lobby:
    motd: "Lobby"
    address: 127.0.0.1:25566
    restricted: false
  survival:
    motd: "Survival"
    address: 127.0.0.1:25567
    restricted: false
```

---

## 3) Set up backend servers (Paper/Spigot)

Repeat for each backend (`lobby`, `survival`).

```bash
cd ~/mc-network/lobby
# place paper.jar here
java -Xms1G -Xmx3G -jar paper.jar
```

Accept EULA:

```bash
echo "eula=true" > eula.txt
```

Start again once, then stop and edit configs.

### Backend `server.properties`

Set for each backend:

```properties
server-port=25566
online-mode=false
motd=Lobby
```

For survival, use `server-port=25567`.

### Backend `spigot.yml`

```yaml
settings:
  bungeecord: true
```

> `online-mode=false` is required behind a Bungee-style proxy. Do **not** expose backend ports publicly.

---

## 4) Add Java + Bedrock bridge plugins

### On Proxy

Install these plugins in `~/mc-network/proxy/plugins`:

- **Geyser-Bungee**
- **Floodgate-Bungee**

Then restart proxy once so configs generate.

Edit Geyser config (`plugins/Geyser-Bungee/config.yml`):

- `auth-type: floodgate` (for easy Bedrock login)
- Set Bedrock listening port (default often `19132`)
- Confirm remote target is the proxy backend handling

Floodgate usually works with default generated keys/config.

### Optional compatibility plugins

Useful for mixed versions and smoother experience:

- ViaVersion (proxy/backend as needed)
- ViaBackwards
- ViaRewind

---

## 5) Open firewall ports

Public:

- TCP `25565` (Java players via proxy)
- UDP `19132` (Bedrock players via Geyser)

Keep backend ports (`25566`, `25567`, etc.) blocked externally.

Example `ufw`:

```bash
sudo ufw allow 25565/tcp
sudo ufw allow 19132/udp
sudo ufw enable
sudo ufw status
```

---

## 6) Start order

1. Start backend servers first (lobby/survival)
2. Start proxy second

Example with `screen`:

```bash
screen -S lobby
cd ~/mc-network/lobby
java -Xms1G -Xmx3G -jar paper.jar
```

Create separate sessions for survival + proxy.

---

## 7) DNS (optional but recommended)

- Create an `A` record: `play.yourdomain.com -> your_server_ip`
- Point Java users to `play.yourdomain.com:25565`
- Point Bedrock users to same host + UDP port `19132`

---

## 8) Fast production checklist

- [ ] `ip_forward: true` on proxy
- [ ] `bungeecord: true` on every backend
- [ ] `online-mode=false` on backends only
- [ ] Backend ports not publicly exposed
- [ ] Geyser + Floodgate installed and configured
- [ ] Regular backups of world folders
- [ ] Restart scripts/service files created
- [ ] Test Java and Bedrock joins before launch

---

## 9) Recommended extras

- **LuckPerms** (permissions)
- **EssentialsX** (commands, homes, warps)
- **CoreProtect** (rollback / logging)
- **spark** (performance profiling)
- **Plan** (analytics)

---

## 10) Troubleshooting quick hits

### Bedrock cannot join

- Verify UDP `19132` is open.
- Ensure Geyser is installed on proxy and running.
- Confirm `auth-type` and Floodgate pairing are correct.

### Java joins proxy but not backend

- Check backend server is online on correct local port.
- Verify proxy `config.yml` server addresses.
- Confirm backend `online-mode=false` and `bungeecord: true`.

### “IP forwarding” or UUID issues

- Re-check proxy `ip_forward: true`
- Re-check backend `spigot.yml` bungeecord setting

---

## Security notes

- Never expose backend ports publicly.
- Keep Java/plugins updated.
- Run as a non-root user.
- Make automated backups before updates.

---

If you want, this repo can also include:

- ready-to-use startup scripts
- systemd service files
- a plugin baseline pack list
- a preflight validation script for common config mistakes
