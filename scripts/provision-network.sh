#!/usr/bin/env bash
set -euo pipefail

NETWORK_DIR="${NETWORK_DIR:-$PWD/mc-network}"
PROXY_DIR="$NETWORK_DIR/proxy"
LOBBY_DIR="$NETWORK_DIR/lobby"
SURVIVAL_DIR="$NETWORK_DIR/survival"
BACKUP_DIR="$NETWORK_DIR/backups"

JAVA_PROXY_MEM="${JAVA_PROXY_MEM:--Xms512M -Xmx1G}"
JAVA_LOBBY_MEM="${JAVA_LOBBY_MEM:--Xms1G -Xmx3G}"
JAVA_SURVIVAL_MEM="${JAVA_SURVIVAL_MEM:--Xms1G -Xmx4G}"
PRESERVE_EXISTING_JARS="${PRESERVE_EXISTING_JARS:-0}"

PAPER_VERSION="${PAPER_VERSION:-}"
WATERFALL_VERSION="${WATERFALL_VERSION:-}"
PROXY_LISTEN_IP="${PROXY_LISTEN_IP:-192.168.88.100}"
PROXY_BIND_ADDRESS="$PROXY_LISTEN_IP"

if ! command -v java >/dev/null 2>&1; then
  echo "Java is required. Install Java 21+ first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for resolving latest Paper/Waterfall builds." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for downloading server jars/plugins." >&2
  exit 1
fi

if command -v ip >/dev/null 2>&1; then
  if ! ip -4 addr show | grep -Fq "inet ${PROXY_LISTEN_IP}/"; then
    echo "Warning: PROXY_LISTEN_IP ${PROXY_LISTEN_IP} is not configured on this host. Falling back to 0.0.0.0."
    PROXY_BIND_ADDRESS="0.0.0.0"
  fi
else
  echo "Warning: 'ip' command not found; skipping PROXY_LISTEN_IP validation."
fi

mkdir -p "$PROXY_DIR/plugins" "$LOBBY_DIR" "$SURVIVAL_DIR" "$BACKUP_DIR"

resolve_latest_build() {
  local project="$1"
  local forced_version="$2"
  python3 - "$project" "$forced_version" <<'PY'
import json
import sys
import urllib.request
import urllib.error

project = sys.argv[1]
forced_version = sys.argv[2]
base = f"https://api.papermc.io/v2/projects/{project}"

try:
    with urllib.request.urlopen(base, timeout=30) as r:
        meta = json.load(r)

    version = forced_version or meta["versions"][-1]
    with urllib.request.urlopen(f"{base}/versions/{version}", timeout=30) as r:
        ver_meta = json.load(r)

    build = ver_meta["builds"][-1]
    if project == "paper":
        jar = f"paper-{version}-{build}.jar"
    else:
        jar = f"waterfall-{version}-{build}.jar"

    print(version)
    print(build)
    print(jar)
except (urllib.error.URLError, TimeoutError, KeyError, IndexError, ValueError):
    raise SystemExit(1)
PY
}

download_if_missing() {
  local project="$1"
  local dir="$2"
  local forced_version="$3"

  mapfile -t build_info < <(resolve_latest_build "$project" "$forced_version")
  if (( ${#build_info[@]} < 3 )); then
    echo "Error: failed to resolve latest $project build metadata." >&2
    return 1
  fi
  local version="${build_info[0]}"
  local build="${build_info[1]}"
  local jar_name="${build_info[2]}"

  local jar_path="$dir/$jar_name"
  if [[ ! -f "$jar_path" ]]; then
    echo "Downloading $project $version build $build ..."
    curl -fsSL "https://api.papermc.io/v2/projects/$project/versions/$version/builds/$build/downloads/$jar_name" -o "$jar_path"
  else
    if [[ "$PRESERVE_EXISTING_JARS" == "1" ]]; then
      echo "Using existing $jar_name (PRESERVE_EXISTING_JARS=1)"
    else
      echo "Refreshing $project $version build $build ..."
      rm -f "$dir"/"${project}"-*.jar
      curl -fsSL "https://api.papermc.io/v2/projects/$project/versions/$version/builds/$build/downloads/$jar_name" -o "$jar_path"
    fi
  fi

  ln -sfn "$jar_name" "$dir/server.jar"
}

if [[ -z "$PAPER_VERSION" ]]; then
  mapfile -t waterfall_build_info < <(resolve_latest_build "waterfall" "$WATERFALL_VERSION")
  if (( ${#waterfall_build_info[@]} >= 1 )); then
    PAPER_VERSION="${waterfall_build_info[0]}"
    echo "PAPER_VERSION not set; matching backend version to Waterfall: $PAPER_VERSION"
  else
    echo "Error: failed to resolve Waterfall version for Paper version alignment." >&2
    exit 1
  fi
fi

download_if_missing "waterfall" "$PROXY_DIR" "$WATERFALL_VERSION"
download_if_missing "paper" "$LOBBY_DIR" "$PAPER_VERSION"
download_if_missing "paper" "$SURVIVAL_DIR" "$PAPER_VERSION"
rm -f "$PROXY_DIR/plugins"/Geyser-*.jar "$PROXY_DIR/plugins"/floodgate-*.jar
rm -f "$PROXY_DIR/plugins"/ViaVersion-*.jar

download_plugin_from_modrinth() {
  local project_id="$1"
  local destination="$2"
  local fallback_local_jar="$3"

  local plugin_jar
  plugin_jar="$(python3 - "$project_id" <<'PY'
import json
import sys
import urllib.request
import urllib.error

project_id = sys.argv[1]
url = f"https://api.modrinth.com/v2/project/{project_id}/version"
req = urllib.request.Request(url, headers={"User-Agent": "circle-of-minecraft/1.0"})
try:
    with urllib.request.urlopen(req, timeout=30) as response:
        versions = json.load(response)

    if not versions:
        raise SystemExit(1)

    for version in versions:
        if version.get("status") != "listed":
            continue
        for f in version.get("files", []):
            filename = f.get("filename", "")
            if filename.endswith(".jar") and f.get("url"):
                print(f"{filename}|{f['url']}")
                raise SystemExit(0)
except (urllib.error.URLError, TimeoutError, KeyError, ValueError):
    raise SystemExit(1)
raise SystemExit(1)
PY
)" || true

  if [[ -n "$plugin_jar" ]]; then
    local jar_name jar_url
    jar_name="${plugin_jar%%|*}"
    jar_url="${plugin_jar#*|}"
    echo "Downloading latest $project_id plugin: $jar_name"
    curl -fsSL "$jar_url" -o "$destination/$jar_name"
    return 0
  fi

  if [[ -f "$fallback_local_jar" ]]; then
    echo "Warning: could not resolve latest $project_id from Modrinth, using bundled $(basename "$fallback_local_jar")."
    cp "$fallback_local_jar" "$destination/"
    return 0
  fi

  echo "Error: failed to download $project_id plugin and no fallback jar found at $fallback_local_jar" >&2
  return 1
}

download_plugin_from_modrinth "geyser" "$PROXY_DIR/plugins" "$PWD/Geyser-BungeeCord.jar"
download_plugin_from_modrinth "floodgate" "$PROXY_DIR/plugins" "$PWD/floodgate-bungee.jar"
download_plugin_from_modrinth "viaversion" "$PROXY_DIR/plugins" ""

cat > "$PROXY_DIR/config.yml" <<YAML
listeners:
- query_port: 25565
  motd: '&3&lCircle of Minecraft &7| &bJava + Bedrock'
  tab_list: GLOBAL_PING
  query_enabled: false
  proxy_protocol: false
  forced_hosts:
    pvpmds.net: survival
  ping_passthrough: false
  priorities:
  - lobby
  bind_local_address: true
  host: ${PROXY_BIND_ADDRESS}:25565
  max_players: 100
  tab_size: 60
  force_default_server: false
remote_ping_cache: -1
network_compression_threshold: 256
permissions:
  default:
  - bungeecord.command.server
  - bungeecord.command.list
log_pings: true
connection_throttle_limit: 3
prevent_proxy_connections: false
timeout: 30000
player_limit: -1
ip_forward: true
groups:
  md_5:
  - admin
remote_ping_timeout: 5000
connection_throttle: 4000
log_commands: false
stats: 8f3f67ee-6de2-4d11-8a44-e37f21f687db
online_mode: true
forge_support: false
disabled_commands:
- disabledcommandhere
servers:
  lobby:
    motd: '&aMain Lobby'
    address: 127.0.0.1:25566
    restricted: false
  survival:
    motd: '&6Survival World'
    address: 127.0.0.1:25567
    restricted: false
YAML

cat > "$LOBBY_DIR/server.properties" <<'EOF_PROPS'
server-port=25566
server-ip=127.0.0.1
online-mode=false
motd=Circle Lobby
max-players=75
view-distance=8
simulation-distance=6
spawn-protection=0
allow-flight=true
EOF_PROPS

cat > "$SURVIVAL_DIR/server.properties" <<'EOF_PROPS'
server-port=25567
server-ip=127.0.0.1
online-mode=false
motd=Circle Survival
max-players=75
view-distance=10
simulation-distance=8
spawn-protection=0
EOF_PROPS

cat > "$LOBBY_DIR/spigot.yml" <<'EOF_SPIGOT'
settings:
  bungeecord: true
EOF_SPIGOT

cat > "$SURVIVAL_DIR/spigot.yml" <<'EOF_SPIGOT'
settings:
  bungeecord: true
EOF_SPIGOT

echo "eula=true" > "$LOBBY_DIR/eula.txt"
echo "eula=true" > "$SURVIVAL_DIR/eula.txt"

echo "#!/usr/bin/env bash
cd \"$PROXY_DIR\"
exec java $JAVA_PROXY_MEM -jar server.jar" > "$PROXY_DIR/run.sh"

echo "#!/usr/bin/env bash
cd \"$LOBBY_DIR\"
exec java $JAVA_LOBBY_MEM -jar server.jar nogui" > "$LOBBY_DIR/run.sh"

echo "#!/usr/bin/env bash
cd \"$SURVIVAL_DIR\"
exec java $JAVA_SURVIVAL_MEM -jar server.jar nogui" > "$SURVIVAL_DIR/run.sh"

chmod +x "$PROXY_DIR/run.sh" "$LOBBY_DIR/run.sh" "$SURVIVAL_DIR/run.sh"

cat > "$NETWORK_DIR/start-all.sh" <<'EOF_START'
#!/usr/bin/env bash
set -euo pipefail
BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for start-all.sh" >&2
  exit 1
fi

tmux new-session -d -s mc-lobby "$BASE_DIR/lobby/run.sh"
tmux new-session -d -s mc-survival "$BASE_DIR/survival/run.sh"
sleep 4
tmux new-session -d -s mc-proxy "$BASE_DIR/proxy/run.sh"

echo "Started sessions: mc-lobby, mc-survival, mc-proxy"
echo "Attach with: tmux attach -t mc-proxy"
EOF_START

cat > "$NETWORK_DIR/stop-all.sh" <<'EOF_STOP'
#!/usr/bin/env bash
set -euo pipefail
for s in mc-proxy mc-lobby mc-survival; do
  tmux kill-session -t "$s" 2>/dev/null || true
done
echo "Stopped mc-proxy, mc-lobby, mc-survival (if running)."
EOF_STOP

chmod +x "$NETWORK_DIR/start-all.sh" "$NETWORK_DIR/stop-all.sh"

echo ""
echo "Provisioning complete in: $NETWORK_DIR"
echo "1) Start lobby and survival once to generate additional files/plugins."
echo "2) Stop them, then start all with: $NETWORK_DIR/start-all.sh"
echo "3) Public ports: TCP 25565 (Java), UDP 19132 (Bedrock via Geyser)."
