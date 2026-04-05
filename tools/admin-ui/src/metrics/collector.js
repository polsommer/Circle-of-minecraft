const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SERVERS = ['proxy', 'lobby', 'survival'];
const DEFAULT_PORTS = {
  proxy: 25577,
  lobby: 25565,
  survival: 25566
};

const PLAYER_PATHS = [
  ['players', 'online'],
  ['players', 'count'],
  ['onlinePlayers'],
  ['playerCount'],
  ['online']
];

const TPS_PATHS = [['tps'], ['metrics', 'tps'], ['server', 'tps']];

const MEMORY_PATHS = [
  ['memory', 'usedMb'],
  ['memory', 'used'],
  ['jvm', 'memory', 'used'],
  ['heapUsedMb']
];

const CPU_PATHS = [
  ['cpu', 'processPercent'],
  ['cpu', 'process'],
  ['jvm', 'cpu', 'process'],
  ['processCpuPercent']
];

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getPathValue(source, segments) {
  let current = source;
  for (const seg of segments) {
    if (!current || typeof current !== 'object' || !(seg in current)) {
      return undefined;
    }
    current = current[seg];
  }
  return current;
}

function firstNumberFromPaths(obj, paths) {
  for (const pathSegments of paths) {
    const value = getPathValue(obj, pathSegments);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function buildMetricConfig() {
  const fromEnv = safeJsonParse(process.env.METRICS_SERVER_CONFIG || '{}');
  return DEFAULT_SERVERS.reduce((acc, name) => {
    const existing = fromEnv[name] || {};
    acc[name] = {
      host: existing.host || '127.0.0.1',
      queryPort: Number(existing.queryPort || DEFAULT_PORTS[name]),
      pluginUrl: existing.pluginUrl || null,
      rconHost: existing.rconHost || existing.host || '127.0.0.1',
      rconPort: existing.rconPort ? Number(existing.rconPort) : null,
      rconPassword: existing.rconPassword || null,
      processPattern: existing.processPattern || `${path.join('mc-network', name)}${path.sep}`
    };
    return acc;
  }, {});
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

async function fetchPluginMetrics(pluginUrl) {
  if (!pluginUrl) {
    return null;
  }
  const response = await fetch(pluginUrl, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`plugin endpoint returned ${response.status}`);
  }
  const payload = await response.json();

  return {
    source: 'plugin',
    players: firstNumberFromPaths(payload, PLAYER_PATHS),
    tps: firstNumberFromPaths(payload, TPS_PATHS),
    memoryMb: firstNumberFromPaths(payload, MEMORY_PATHS),
    cpuPercent: firstNumberFromPaths(payload, CPU_PATHS),
    raw: payload
  };
}

function writeInt32LE(buffer, value, offset) {
  buffer.writeInt32LE(value, offset);
}

function makeSessionId() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function makeQueryPacket(type, sessionId, token = 0, includePadding = false) {
  const tokenBytes = Buffer.alloc(4);
  writeInt32LE(tokenBytes, token, 0);
  const base = Buffer.alloc(includePadding ? 15 : 11);
  base[0] = 0xfe;
  base[1] = 0xfd;
  base[2] = type;
  writeInt32LE(base, sessionId, 3);
  tokenBytes.copy(base, 7);
  if (includePadding) {
    base[11] = 0x00;
    base[12] = 0x00;
    base[13] = 0x00;
    base[14] = 0x00;
  }
  return base;
}

function queryServerViaUdp(host, port, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const sessionId = makeSessionId();
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      socket.close();
      if (err) reject(err);
      else resolve(value);
    };

    socket.on('error', (error) => finish(error));

    socket.once('message', (challengeMsg) => {
      const tokenStr = challengeMsg.subarray(5).toString('utf8').replace(/\u0000/g, '').trim();
      const token = Number.parseInt(tokenStr, 10);
      if (!Number.isFinite(token)) {
        finish(new Error('invalid challenge token'));
        return;
      }

      const statPacket = makeQueryPacket(0x00, sessionId, token, true);
      socket.once('message', (statMsg) => {
        const raw = statMsg.subarray(16).toString('utf8');
        const keyValues = raw.split('\u0000');
        const fields = {};
        for (let i = 0; i < keyValues.length - 1; i += 2) {
          const key = keyValues[i];
          const value = keyValues[i + 1];
          if (!key) break;
          fields[key] = value;
        }

        const players = Number.parseInt(fields.numplayers || fields.online || '0', 10);
        finish(null, {
          source: 'query',
          players: Number.isFinite(players) ? players : null,
          tps: null,
          memoryMb: null,
          cpuPercent: null,
          raw: fields
        });
      });

      socket.send(statPacket, port, host);
    });

    socket.send(makeQueryPacket(0x09, sessionId), port, host);
    setTimeout(() => finish(new Error('query timeout')), timeoutMs);
  });
}

function makeRconPacket(requestId, type, body) {
  const bodyBuffer = Buffer.from(body, 'utf8');
  const length = bodyBuffer.length + 10;
  const packet = Buffer.alloc(length + 4);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(requestId, 4);
  packet.writeInt32LE(type, 8);
  bodyBuffer.copy(packet, 12);
  packet.writeInt16LE(0, packet.length - 2);
  return packet;
}

function readRconPacket(buffer) {
  const length = buffer.readInt32LE(0);
  const requestId = buffer.readInt32LE(4);
  const type = buffer.readInt32LE(8);
  const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
  return { length, requestId, type, body };
}

function queryPlayersViaRcon(host, port, password, timeoutMs = 1500) {
  if (!host || !port || !password) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const authId = 100;
    const cmdId = 101;
    const bufferState = { data: Buffer.alloc(0) };
    let authed = false;

    const cleanup = (err, value) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs, () => cleanup(new Error('rcon timeout')));
    socket.on('error', (error) => cleanup(error));

    socket.on('data', (chunk) => {
      bufferState.data = Buffer.concat([bufferState.data, chunk]);
      while (bufferState.data.length >= 4) {
        const len = bufferState.data.readInt32LE(0);
        if (bufferState.data.length < len + 4) {
          return;
        }

        const packet = readRconPacket(bufferState.data.subarray(0, len + 4));
        bufferState.data = bufferState.data.subarray(len + 4);

        if (!authed && packet.requestId === authId) {
          authed = true;
          socket.write(makeRconPacket(cmdId, 2, 'list'));
        } else if (authed && packet.requestId === cmdId) {
          const match = packet.body.match(/(?:There are|Players online:)\s*(\d+)/i);
          const players = match ? Number.parseInt(match[1], 10) : null;
          cleanup(null, {
            source: 'rcon',
            players: Number.isFinite(players) ? players : null,
            tps: null,
            memoryMb: null,
            cpuPercent: null,
            raw: { list: packet.body }
          });
          return;
        }
      }
    });

    socket.connect(port, host, () => {
      socket.write(makeRconPacket(authId, 3, password));
    });
  });
}

async function getPidForPattern(pattern) {
  try {
    const result = await runCommand('pgrep', ['-f', pattern]);
    const first = result.stdout.split(/\s+/).find(Boolean);
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

async function readProcfsCpuMemory(pid) {
  if (!pid) {
    return null;
  }

  const statusPath = `/proc/${pid}/status`;
  if (!fs.existsSync(statusPath)) {
    return null;
  }

  const status = fs.readFileSync(statusPath, 'utf8');
  const vmRssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  const memoryMb = vmRssMatch ? Number(vmRssMatch[1]) / 1024 : null;

  try {
    const output = await runCommand('ps', ['-p', String(pid), '-o', '%cpu=']);
    const cpuPercent = Number.parseFloat(output.stdout);
    return {
      source: 'procfs',
      players: null,
      tps: null,
      memoryMb,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
      raw: { pid }
    };
  } catch {
    return {
      source: 'procfs',
      players: null,
      tps: null,
      memoryMb,
      cpuPercent: null,
      raw: { pid }
    };
  }
}

function mergeMetrics(primary, fallback) {
  if (!primary && !fallback) {
    return null;
  }
  if (!primary) return fallback;
  if (!fallback) return primary;

  return {
    source: `${primary.source}+${fallback.source}`,
    players: primary.players ?? fallback.players ?? null,
    tps: primary.tps ?? fallback.tps ?? null,
    memoryMb: primary.memoryMb ?? fallback.memoryMb ?? null,
    cpuPercent: primary.cpuPercent ?? fallback.cpuPercent ?? null,
    raw: { primary: primary.raw, fallback: fallback.raw }
  };
}

function parseWindowMs(windowValue) {
  if (!windowValue) return 15 * 60 * 1000;
  const match = String(windowValue).trim().match(/^(\d+)([smhd])$/i);
  if (!match) {
    return 15 * 60 * 1000;
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return value * multiplier;
}

class MetricsCollector {
  constructor(options = {}) {
    this.servers = options.servers || DEFAULT_SERVERS;
    this.config = options.config || buildMetricConfig();
    this.pollMs = clamp(Number(options.pollMs || process.env.METRICS_POLL_INTERVAL_MS || 3000), 2000, 5000);
    this.maxWindowMs = 24 * 60 * 60 * 1000;
    this.history = new Map();
    this.listeners = new Set();
    this.timer = null;

    this.servers.forEach((name) => this.history.set(name, []));
  }

  async collectForServer(name) {
    const cfg = this.config[name] || {};
    let metric = null;

    try {
      metric = await fetchPluginMetrics(cfg.pluginUrl);
    } catch {
      metric = null;
    }

    if (!metric) {
      try {
        metric = await queryServerViaUdp(cfg.host, cfg.queryPort);
      } catch {
        metric = null;
      }
    }

    if (!metric) {
      try {
        metric = await queryPlayersViaRcon(cfg.rconHost, cfg.rconPort, cfg.rconPassword);
      } catch {
        metric = null;
      }
    }

    const pid = await getPidForPattern(cfg.processPattern || name);
    const procMetric = await readProcfsCpuMemory(pid);
    const merged = mergeMetrics(metric, procMetric) || {
      source: 'unavailable',
      players: 0,
      tps: null,
      memoryMb: null,
      cpuPercent: null,
      raw: null
    };

    return {
      server: name,
      timestamp: new Date().toISOString(),
      players: merged.players ?? 0,
      tps: merged.tps,
      memoryMb: merged.memoryMb,
      cpuPercent: merged.cpuPercent,
      source: merged.source
    };
  }

  trimHistory(server) {
    const cutoff = Date.now() - this.maxWindowMs;
    const entries = this.history.get(server) || [];
    this.history.set(
      server,
      entries.filter((entry) => new Date(entry.timestamp).getTime() >= cutoff)
    );
  }

  emitUpdate(update) {
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        // Ignore subscriber failures.
      }
    }
  }

  async pollOnce() {
    const results = await Promise.all(this.servers.map((server) => this.collectForServer(server)));

    for (const metric of results) {
      const entries = this.history.get(metric.server) || [];
      entries.push(metric);
      this.history.set(metric.server, entries);
      this.trimHistory(metric.server);
      this.emitUpdate({ type: 'metric', data: metric });
    }

    const byServer = this.getPlayersByServer();
    const online = Object.values(byServer).reduce((sum, count) => sum + count, 0);
    this.emitUpdate({ type: 'players', data: { online, byServer, timestamp: new Date().toISOString() } });
  }

  start() {
    if (this.timer) return;
    this.pollOnce().catch(() => {
      // Keep service available even if initial metrics collection fails.
    });
    this.timer = setInterval(() => {
      this.pollOnce().catch(() => {
        // Keep polling even on intermittent failures.
      });
    }, this.pollMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onUpdate(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getPlayersByServer() {
    return this.servers.reduce((acc, server) => {
      const entries = this.history.get(server) || [];
      const latest = entries[entries.length - 1];
      acc[server] = latest ? Number(latest.players || 0) : 0;
      return acc;
    }, {});
  }

  getPlayersOnline() {
    const byServer = this.getPlayersByServer();
    return Object.values(byServer).reduce((sum, value) => sum + value, 0);
  }

  getTimeseries(server, windowValue) {
    if (!this.history.has(server)) {
      return null;
    }
    const now = Date.now();
    const windowMs = clamp(parseWindowMs(windowValue), 60000, this.maxWindowMs);
    const cutoff = now - windowMs;
    const points = (this.history.get(server) || []).filter(
      (entry) => new Date(entry.timestamp).getTime() >= cutoff
    );
    return { server, windowMs, points };
  }
}

module.exports = {
  MetricsCollector,
  parseWindowMs,
  buildMetricConfig
};
