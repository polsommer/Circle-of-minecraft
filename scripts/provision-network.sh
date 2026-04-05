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

archive_and_remove_if_present() {
  local file_path="$1"
  local base_dir="$2"
  local label="$3"
  if [[ -f "$file_path" ]]; then
    local rel_path
    rel_path="${file_path#"$base_dir"/}"
    local backup_name
    backup_name="$(echo "$rel_path" | tr '/' '_')"
    cp "$file_path" "$BACKUP_DIR/${label}-${backup_name}.bak"
    rm -f "$file_path"
    echo "Removed stale $label config: $rel_path (backup saved in $BACKUP_DIR)"
  fi
}

reset_incompatible_paper_configs() {
  local server_dir="$1"
  local server_label="$2"

  # Paper's config schema can change between releases. Older files may include
  # string values (for example "default") that newer builds can no longer parse,
  # which causes boot-time crashes before the server starts listening.
  archive_and_remove_if_present "$server_dir/config/paper-global.yml" "$server_dir" "$server_label"
  archive_and_remove_if_present "$server_dir/config/paper-world-defaults.yml" "$server_dir" "$server_label"
}

reset_incompatible_paper_configs "$LOBBY_DIR" "lobby"
reset_incompatible_paper_configs "$SURVIVAL_DIR" "survival"

validate_jar() {
  local jar_path="$1"
  local component_name="$2"
  local required="${3:-1}"

  if [[ ! -s "$jar_path" ]]; then
    echo "Error: invalid $component_name jar at $jar_path (missing or empty)." >&2
    rm -f "$jar_path"
    if [[ "$required" == "1" ]]; then
      exit 1
    fi
    echo "Warning: optional component $component_name is invalid; continuing without it."
    return 1
  fi

  if command -v unzip >/dev/null 2>&1; then
    if ! unzip -tqq "$jar_path" >/dev/null 2>&1; then
      echo "Error: invalid $component_name jar at $jar_path (ZIP/JAR integrity check failed)." >&2
      rm -f "$jar_path"
      if [[ "$required" == "1" ]]; then
        exit 1
      fi
      echo "Warning: optional component $component_name is invalid; continuing without it."
      return 1
    fi
    return 0
  fi

  if command -v jar >/dev/null 2>&1; then
    if ! jar tf "$jar_path" >/dev/null 2>&1; then
      echo "Error: invalid $component_name jar at $jar_path (jar listing failed)." >&2
      rm -f "$jar_path"
      if [[ "$required" == "1" ]]; then
        exit 1
      fi
      echo "Warning: optional component $component_name is invalid; continuing without it."
      return 1
    fi
    return 0
  fi

  if command -v file >/dev/null 2>&1; then
    local file_desc
    file_desc="$(file -b "$jar_path" | tr '[:upper:]' '[:lower:]')"
    if [[ "$file_desc" != *zip* && "$file_desc" != *jar* ]]; then
      echo "Error: invalid $component_name jar at $jar_path (unexpected type: $file_desc)." >&2
      rm -f "$jar_path"
      if [[ "$required" == "1" ]]; then
        exit 1
      fi
      echo "Warning: optional component $component_name is invalid; continuing without it."
      return 1
    fi
    return 0
  fi

  echo "Warning: could not validate $component_name jar at $jar_path (no unzip/jar/file command available)."
  return 0
}

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

  mapfile -t build_info < <(resolve_latest_build "$project" "$forced_version") || true
  if (( ${#build_info[@]} < 3 )); then
    local existing_jar=""
    existing_jar="$(find "$dir" -maxdepth 1 -type f -name "${project}-*.jar" | sort | tail -n 1 || true)"
    if [[ -n "$existing_jar" ]]; then
      local existing_jar_name
      existing_jar_name="$(basename "$existing_jar")"
      echo "Warning: failed to resolve latest $project metadata; using existing $existing_jar_name."
      ln -sfn "$existing_jar_name" "$dir/server.jar"
      return 0
    fi
    echo "Error: failed to resolve latest $project build metadata and no local ${project}-*.jar is available in $dir." >&2
    return 1
  fi
  local version="${build_info[0]}"
  local build="${build_info[1]}"
  local jar_name="${build_info[2]}"

  local jar_path="$dir/$jar_name"
  if [[ ! -f "$jar_path" ]]; then
    echo "Downloading $project $version build $build ..."
    curl -fsSL "https://api.papermc.io/v2/projects/$project/versions/$version/builds/$build/downloads/$jar_name" -o "$jar_path"
    validate_jar "$jar_path" "$project"
  else
    if [[ "$PRESERVE_EXISTING_JARS" == "1" ]]; then
      echo "Using existing $jar_name (PRESERVE_EXISTING_JARS=1)"
    else
      echo "Refreshing $project $version build $build ..."
      rm -f "$dir"/"${project}"-*.jar
      curl -fsSL "https://api.papermc.io/v2/projects/$project/versions/$version/builds/$build/downloads/$jar_name" -o "$jar_path"
      validate_jar "$jar_path" "$project"
    fi
  fi

  ln -sfn "$jar_name" "$dir/server.jar"
}

if [[ -z "$PAPER_VERSION" ]]; then
  mapfile -t waterfall_build_info < <(resolve_latest_build "waterfall" "$WATERFALL_VERSION") || true
  if (( ${#waterfall_build_info[@]} >= 1 )); then
    PAPER_VERSION="${waterfall_build_info[0]}"
    echo "PAPER_VERSION not set; matching backend version to Waterfall: $PAPER_VERSION"
  else
    echo "Warning: failed to resolve Waterfall version for Paper alignment; resolving Paper version independently."
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
  local required="${4:-1}"
  local loader_targets="${5:-}"
  local target_game_version="${6:-}"

  local plugin_jar
  plugin_jar="$(python3 - "$project_id" "$loader_targets" "$target_game_version" <<'PY'
import json
import sys
import urllib.request
import urllib.error

project_id = sys.argv[1]
target_loaders = [loader.strip().lower() for loader in sys.argv[2].split(",") if loader.strip()]
target_game_version = sys.argv[3].strip()
url = f"https://api.modrinth.com/v2/project/{project_id}/version"
req = urllib.request.Request(url, headers={"User-Agent": "circle-of-minecraft/1.0"})
try:
    with urllib.request.urlopen(req, timeout=30) as response:
        versions = json.load(response)

    if not versions:
        raise SystemExit(1)

    stable_candidates = []
    fallback_candidates = []

    for version in versions:
        if version.get("status") != "listed":
            continue

        version_loaders = [loader.lower() for loader in version.get("loaders", []) if isinstance(loader, str)]
        if target_loaders and not any(loader in version_loaders for loader in target_loaders):
            continue

        game_versions = [v for v in version.get("game_versions", []) if isinstance(v, str)]
        if target_game_version and target_game_version not in game_versions:
            continue

        primary_file = None
        backup_file = None
        for file_info in version.get("files", []):
            filename = file_info.get("filename", "")
            file_url = file_info.get("url")
            if not (filename.endswith(".jar") and file_url):
                continue
            if file_info.get("primary") and primary_file is None:
                primary_file = file_info
            if backup_file is None:
                backup_file = file_info

        chosen_file = primary_file or backup_file
        if not chosen_file:
            continue

        selected_loader = ""
        if target_loaders:
            for loader in target_loaders:
                if loader in version_loaders:
                    selected_loader = loader
                    break
        if not selected_loader and version_loaders:
            selected_loader = version_loaders[0]

        selected_game_version = target_game_version if target_game_version else (game_versions[0] if game_versions else "")
        version_type = (version.get("version_type") or "").lower()
        candidate = (
            chosen_file["filename"],
            chosen_file["url"],
            selected_loader,
            selected_game_version,
            version_type or "unknown",
        )
        if version_type == "release":
            stable_candidates.append(candidate)
        else:
            fallback_candidates.append(candidate)

    picked = stable_candidates[0] if stable_candidates else (fallback_candidates[0] if fallback_candidates else None)
    if picked:
        print("|".join(picked))
        raise SystemExit(0)
except (urllib.error.URLError, TimeoutError, KeyError, ValueError):
    raise SystemExit(1)
raise SystemExit(1)
PY
)" || true

  if [[ -n "$plugin_jar" ]]; then
    local jar_name jar_url selected_loader selected_game_version selected_channel
    IFS='|' read -r jar_name jar_url selected_loader selected_game_version selected_channel <<< "$plugin_jar"
    echo "Downloading $project_id plugin: loader=${selected_loader:-unknown}, game=${selected_game_version:-any}, channel=${selected_channel:-unknown}, file=$jar_name"
    curl -fsSL "$jar_url" -o "$destination/$jar_name"
    validate_jar "$destination/$jar_name" "$project_id" "$required"
    return 0
  fi

  if [[ -n "$fallback_local_jar" && -f "$fallback_local_jar" ]]; then
    local fallback_name
    fallback_name="$(basename "$fallback_local_jar")"
    echo "Warning: could not resolve compatible $project_id artifact from Modrinth (loaders=${loader_targets:-any}, game=${target_game_version:-any}); using bundled $fallback_name."
    cp "$fallback_local_jar" "$destination/"
    validate_jar "$destination/$fallback_name" "$project_id" "$required"
    return 0
  fi

  if [[ "$required" == "1" ]]; then
    echo "Error: failed to download $project_id plugin and no fallback jar found at $fallback_local_jar" >&2
    return 1
  fi

  echo "Warning: failed to download optional plugin $project_id; continuing without it."
  return 0
}

download_plugin_from_modrinth "geyser" "$PROXY_DIR/plugins" "$PWD/Geyser-BungeeCord.jar" 1 "bungeecord,waterfall,velocity" "$PAPER_VERSION"
download_plugin_from_modrinth "floodgate" "$PROXY_DIR/plugins" "$PWD/floodgate-bungee.jar" 1 "bungeecord,waterfall,velocity" "$PAPER_VERSION"
download_plugin_from_modrinth "viaversion" "$PROXY_DIR/plugins" "" 0 "bungeecord,waterfall,velocity" "$PAPER_VERSION"

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
BACKEND_START_TIMEOUT="${BACKEND_START_TIMEOUT:-240}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for start-all.sh" >&2
  exit 1
fi

ensure_session_absent() {
  local session_name="$1"
  if tmux has-session -t "$session_name" 2>/dev/null; then
    echo "Session $session_name already exists; replacing it."
    tmux kill-session -t "$session_name"
  fi
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local name="$3"
  local session_name="$4"
  local log_file="${5:-}"
  local timeout_seconds="${6:-$BACKEND_START_TIMEOUT}"
  local elapsed=0

  while ! (echo >"/dev/tcp/$host/$port") >/dev/null 2>&1; do
    if ! tmux has-session -t "$session_name" 2>/dev/null; then
      echo "$name session ($session_name) exited before opening $host:$port." >&2
      if [[ -n "$log_file" && -f "$log_file" ]]; then
        echo "Last log lines from $log_file:" >&2
        tail -n 120 "$log_file" >&2 || true
      fi
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    if (( elapsed >= timeout_seconds )); then
      echo "Timed out waiting for $name on $host:$port after ${timeout_seconds}s." >&2
      echo "Last $session_name logs:" >&2
      tmux capture-pane -p -S -120 -t "$session_name" 2>/dev/null || true
      return 1
    fi
  done
}

ensure_session_absent mc-lobby
ensure_session_absent mc-survival
ensure_session_absent mc-proxy

tmux new-session -d -s mc-lobby "$BASE_DIR/lobby/run.sh"
tmux new-session -d -s mc-survival "$BASE_DIR/survival/run.sh"
wait_for_port 127.0.0.1 25566 "lobby backend" "mc-lobby" "$BASE_DIR/lobby/logs/latest.log"
wait_for_port 127.0.0.1 25567 "survival backend" "mc-survival" "$BASE_DIR/survival/logs/latest.log"
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
