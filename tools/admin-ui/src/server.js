const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { MetricsCollector } = require('./metrics/collector');
const { PluginManager } = require('./plugins.manager');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const ADMIN_UI_HOST = process.env.ADMIN_UI_HOST || '192.168.88.100';
const ADMIN_UI_PORT = Number(process.env.ADMIN_UI_PORT || 7070);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const networkDir = process.env.MC_NETWORK_DIR || path.join(repoRoot, 'mc-network');
const pluginDomainAllowlist = (process.env.PLUGIN_URL_ALLOWLIST || 'github.com,modrinth.com,cdn.modrinth.com,hangarcdn.papermc.io')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const corsAllowlist = (process.env.ADMIN_UI_CORS_ALLOWLIST || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const ipAllowlist = (process.env.ADMIN_UI_IP_ALLOWLIST || '127.0.0.1/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const sessionCookieName = process.env.ADMIN_UI_SESSION_COOKIE || 'admin_ui_session';
const secureCookie = (process.env.ADMIN_UI_SECURE_COOKIE || '0') === '1';
const sessionTtlMs = Number(process.env.ADMIN_UI_SESSION_TTL_MS || 1000 * 60 * 60 * 8);
const rateLimitWindowMs = Number(process.env.ADMIN_UI_RATE_LIMIT_WINDOW_MS || 60_000);
const rateLimitMaxRequests = Number(process.env.ADMIN_UI_RATE_LIMIT_MAX_REQUESTS || 120);
const rateLimitMaxAuthAttempts = Number(process.env.ADMIN_UI_RATE_LIMIT_MAX_AUTH_ATTEMPTS || 10);
const authSecretPath = process.env.ADMIN_UI_AUTH_FILE || path.join(repoRoot, '.secrets', 'admin-ui-auth.json');
const accessLogPath = process.env.ADMIN_UI_ACCESS_LOG || path.join(networkDir, 'backups', 'admin-ui-access.log');

const ALLOWED_SERVERS = ['proxy', 'lobby', 'survival'];
const SERVER_PORTS = {
  proxy: 25577,
  lobby: 25565,
  survival: 25566
};

const sessions = new Map();
const rateBuckets = new Map();

let authConfig = loadAuthConfig();

app.use(express.static(path.join(__dirname, '..', 'public')));

const metricsCollector = new MetricsCollector({ servers: ALLOWED_SERVERS });
const sseClients = new Set();
const pluginManager = new PluginManager({
  networkDir,
  allowedServers: ALLOWED_SERVERS,
  executeServerAction,
  allowlistedDomains: pluginDomainAllowlist
});

metricsCollector.onUpdate((event) => {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const response of sseClients) {
    response.write(payload);
  }
});
metricsCollector.start();

function nowIso() {
  return new Date().toISOString();
}

function appendAccessLog(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  fsp.mkdir(path.dirname(accessLogPath), { recursive: true })
    .then(() => fsp.appendFile(accessLogPath, line, 'utf8'))
    .catch((error) => console.error('access log write failed', error.message));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      acc[key] = decodeURIComponent(value);
    }
    return acc;
  }, {});
}

function makeSetCookie(value, maxAgeMs = sessionTtlMs) {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secureCookie) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', makeSetCookie(token));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', makeSetCookie('', 0));
}

function ipToBuffer(ip) {
  if (netIsV4(ip)) {
    return Buffer.from(ip.split('.').map((part) => Number(part)));
  }

  if (netIsV6(ip)) {
    const sections = ip.split('::');
    const left = sections[0] ? sections[0].split(':').filter(Boolean) : [];
    const right = sections[1] ? sections[1].split(':').filter(Boolean) : [];
    const missing = 8 - (left.length + right.length);
    const full = [...left, ...Array(missing).fill('0'), ...right]
      .map((part) => part.padStart(4, '0'));
    const out = Buffer.alloc(16);
    full.forEach((part, idx) => {
      out.writeUInt16BE(Number.parseInt(part, 16), idx * 2);
    });
    return out;
  }

  return null;
}

function netIsV4(ip) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip);
}

function netIsV6(ip) {
  return ip.includes(':');
}

function parseCidr(cidr) {
  const [rawIp, rawBits] = cidr.split('/');
  const ip = (rawIp || '').trim();
  const buf = ipToBuffer(ip);
  if (!buf) return null;

  const maxBits = buf.length * 8;
  const bits = rawBits ? Number.parseInt(rawBits, 10) : maxBits;
  if (!Number.isFinite(bits) || bits < 0 || bits > maxBits) {
    return null;
  }
  return { buf, bits, maxBits };
}

function bufferMatchesCidr(ipBuffer, cidr) {
  if (!ipBuffer || ipBuffer.length !== cidr.buf.length) {
    return false;
  }
  const fullBytes = Math.floor(cidr.bits / 8);
  const extraBits = cidr.bits % 8;

  if (!ipBuffer.subarray(0, fullBytes).equals(cidr.buf.subarray(0, fullBytes))) {
    return false;
  }

  if (extraBits === 0) {
    return true;
  }

  const mask = 0xff << (8 - extraBits);
  return (ipBuffer[fullBytes] & mask) === (cidr.buf[fullBytes] & mask);
}

const parsedAllowedCidrs = ipAllowlist.map(parseCidr).filter(Boolean);

function normalizeIp(req) {
  const raw = req.ip || req.socket.remoteAddress || '';
  if (raw.startsWith('::ffff:')) {
    return raw.slice(7);
  }
  return raw;
}

function isAllowedIp(ip) {
  const ipBuffer = ipToBuffer(ip);
  if (!ipBuffer) return false;
  return parsedAllowedCidrs.some((cidr) => bufferMatchesCidr(ipBuffer, cidr));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function parsePasswordHash(passwordHash) {
  const [algorithm, salt, digest] = (passwordHash || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !digest) {
    return null;
  }
  return { algorithm, salt, digest };
}

function verifyPassword(password, storedHash) {
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) {
    return false;
  }
  const expected = Buffer.from(parsed.digest, 'hex');
  const actual = Buffer.from(hashPassword(password, parsed.salt), 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function loadAuthConfig() {
  const envUser = process.env.ADMIN_UI_ADMIN_USER;
  const envHash = process.env.ADMIN_UI_ADMIN_PASSWORD_HASH;

  if (envUser && envHash) {
    return { username: envUser, passwordHash: envHash };
  }

  try {
    const raw = fs.readFileSync(authSecretPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.username && parsed.passwordHash) {
      return { username: parsed.username, passwordHash: parsed.passwordHash };
    }
  } catch {
    // no-op
  }

  console.warn('admin-ui auth credentials missing: set ADMIN_UI_ADMIN_USER + ADMIN_UI_ADMIN_PASSWORD_HASH or provide ADMIN_UI_AUTH_FILE');
  return { username: null, passwordHash: null };
}

function issueSession({ username, role, ip }) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + sessionTtlMs;
  sessions.set(sessionId, { username, role, ip, csrfToken, createdAt: nowIso(), expiresAt });
  return { sessionId, csrfToken, expiresAt };
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[sessionCookieName];
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  const ip = normalizeIp(req);
  if (session.ip !== ip) {
    sessions.delete(sessionId);
    return null;
  }

  return { sessionId, ...session };
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.auth = session;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required for this action' });
  }
  return next();
}

function requireCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return next();
  }

  if (!req.auth) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const csrf = req.headers['x-csrf-token'];
  if (!csrf || csrf !== req.auth.csrfToken) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.host !== host) {
        return res.status(403).json({ error: 'Cross-site request blocked' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin header' });
    }
  }

  return next();
}

function bucketKey(req, scope = 'global') {
  return `${scope}:${normalizeIp(req)}`;
}

function consumeRateLimit(req, { scope = 'global', max = rateLimitMaxRequests, windowMs = rateLimitWindowMs }) {
  const key = bucketKey(req, scope);
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, remaining: max - 1 };
  }

  bucket.count += 1;
  if (bucket.count > max) {
    return { limited: true, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  return { limited: false, remaining: Math.max(0, max - bucket.count) };
}

function rateLimit(scope, max) {
  return (req, res, next) => {
    const result = consumeRateLimit(req, { scope, max });
    if (result.limited) {
      return res.status(429).json({ error: 'Too many requests', retryAfterSeconds: result.retryAfter });
    }
    return next();
  };
}

function requireAllowedIp(req, res, next) {
  const ip = normalizeIp(req);
  if (!isAllowedIp(ip)) {
    appendAccessLog({ timestamp: nowIso(), ip, method: req.method, path: req.originalUrl, allowed: false, reason: 'ip-deny' });
    return res.status(403).json({ error: 'Access denied from this IP' });
  }
  return next();
}

function enforceCors(req, res, next) {
  const origin = req.headers.origin;

  if (!origin) {
    return next();
  }

  if (!corsAllowlist.includes(origin)) {
    if (req.method === 'OPTIONS') {
      return res.status(403).end();
    }
    return res.status(403).json({ error: 'CORS blocked for origin' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
}

function sanitizeServerParam(req, res, next) {
  const { name } = req.params;
  if (name && !ALLOWED_SERVERS.includes(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }
  return next();
}

function sanitizeActionParam(req, res, next) {
  const { action } = req.params;
  if (action && !['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Invalid server action' });
  }
  return next();
}

function sanitizePluginParam(req, res, next) {
  const { plugin } = req.params;
  if (plugin && !/^[A-Za-z0-9._%\-]+(?:\.jar)?$/i.test(plugin)) {
    return res.status(400).json({ error: 'Invalid plugin identifier' });
  }
  return next();
}

function sanitizePluginUrlBody(req, res, next) {
  const url = req.body && req.body.url;
  if (typeof url !== 'string' || url.length < 12 || url.length > 2048) {
    return res.status(400).json({ error: 'A valid plugin URL is required' });
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http and https URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  return next();
}

function requestAudit(req, res, next) {
  res.on('finish', () => {
    appendAccessLog({
      timestamp: nowIso(),
      ip: normalizeIp(req),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      actor: req.auth?.username || null
    });
  });
  next();
}

app.use(enforceCors);
app.use(requireAllowedIp);
app.use(rateLimit('global', rateLimitMaxRequests));
app.use(requestAudit);

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
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
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`
          )
        );
      }
    });
  });
}

function validateServer(name) {
  return ALLOWED_SERVERS.includes(name);
}

function commandCandidates(name, action) {
  const candidates = {
    start: [
      { cmd: path.join(networkDir, name, 'start.sh'), args: [] },
      { cmd: path.join(networkDir, name, 'run.sh'), args: [] },
      { cmd: path.join(networkDir, `start-${name}.sh`), args: [] },
      { cmd: path.join(networkDir, 'start-all.sh'), args: [name] }
    ],
    stop: [
      { cmd: path.join(networkDir, name, 'stop.sh'), args: [] },
      { cmd: path.join(networkDir, `stop-${name}.sh`), args: [] },
      { cmd: path.join(networkDir, 'stop-all.sh'), args: [name] }
    ],
    restart: [
      { cmd: path.join(networkDir, name, 'restart.sh'), args: [] },
      { cmd: path.join(networkDir, `restart-${name}.sh`), args: [] }
    ]
  };

  return candidates[action] || [];
}

function resolveAllowedCommand(name, action) {
  const candidates = commandCandidates(name, action);
  const match = candidates.find((candidate) => fileExists(candidate.cmd));
  if (!match) {
    throw new Error(
      `No allowlisted script found for action "${action}" on "${name}" under ${networkDir}`
    );
  }
  return match;
}

async function executeServerAction(name, action) {
  if (action === 'restart') {
    try {
      const restartCmd = resolveAllowedCommand(name, 'restart');
      return await runCommand(restartCmd.cmd, restartCmd.args);
    } catch {
      const stopCmd = resolveAllowedCommand(name, 'stop');
      const startCmd = resolveAllowedCommand(name, 'start');
      await runCommand(stopCmd.cmd, stopCmd.args);
      return runCommand(startCmd.cmd, startCmd.args);
    }
  }

  const run = resolveAllowedCommand(name, action);
  return runCommand(run.cmd, run.args);
}

async function getServerRuntime(name) {
  const pattern = `${path.join('mc-network', name)}${path.sep}`;
  try {
    const pgrepResult = await runCommand('pgrep', ['-f', pattern]);
    const pid = pgrepResult.stdout.split(/\s+/).find(Boolean);
    if (!pid) {
      return { status: 'stopped', pid: null, uptimeSeconds: null };
    }

    const uptimeResult = await runCommand('ps', ['-p', pid, '-o', 'etimes=']);
    const uptimeSeconds = Number.parseInt(uptimeResult.stdout.trim(), 10);
    return {
      status: 'running',
      pid,
      uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : null
    };
  } catch {
    return { status: 'stopped', pid: null, uptimeSeconds: null };
  }
}

function inferVersionFromPlugin(pluginName) {
  const noExt = pluginName.replace(/\.jar(?:\.disabled)?$/i, '');
  const match = noExt.match(/(?:^|[-_v])(\d+(?:\.\d+)+(?:[-_a-z0-9]+)?)$/i);
  return match ? match[1] : 'unknown';
}

function buildSyntheticPlayers(byServer) {
  const rows = [];
  for (const [server, count] of Object.entries(byServer)) {
    const total = Number(count) || 0;
    for (let i = 1; i <= total; i += 1) {
      rows.push({
        name: `${server}-player-${i}`,
        server,
        ping: 35 + i * 7
      });
    }
  }
  return rows;
}

app.post('/api/auth/login', rateLimit('auth', rateLimitMaxAuthAttempts), (req, res) => {
  const ip = normalizeIp(req);
  const username = (req.body?.username || '').toString();
  const password = (req.body?.password || '').toString();

  if (!authConfig.username || !authConfig.passwordHash) {
    return res.status(500).json({ error: 'Admin credentials are not configured' });
  }

  if (username !== authConfig.username || !verifyPassword(password, authConfig.passwordHash)) {
    appendAccessLog({ timestamp: nowIso(), ip, method: req.method, path: req.originalUrl, status: 401, user: username, reason: 'login-failed' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const session = issueSession({ username, role: 'admin', ip });
  setSessionCookie(res, session.sessionId);

  return res.json({
    ok: true,
    role: 'admin',
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString()
  });
});

app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
  sessions.delete(req.auth.sessionId);
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get('/api/auth/session', requireAuth, (req, res) => {
  return res.json({
    authenticated: true,
    role: req.auth.role,
    username: req.auth.username,
    csrfToken: req.auth.csrfToken,
    expiresAt: new Date(req.auth.expiresAt).toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'admin-ui',
    host: ADMIN_UI_HOST,
    port: ADMIN_UI_PORT,
    networkDir,
    timestamp: nowIso()
  });
});

app.use(['/api', '/ws'], requireAuth);
app.use(['/api', '/ws'], sanitizeServerParam);
app.use(['/api', '/ws'], sanitizeActionParam);
app.use(['/api', '/ws'], sanitizePluginParam);
app.use(['/api/servers', '/api/metrics', '/api/players'], requireCsrf);

app.get('/api/servers', async (req, res) => {
  try {
    const statuses = await Promise.all(
      ALLOWED_SERVERS.map(async (name) => {
        const runtime = await getServerRuntime(name);
        return {
          name,
          status: runtime.status,
          pid: runtime.pid,
          port: SERVER_PORTS[name] || null,
          uptimeSeconds: runtime.uptimeSeconds
        };
      })
    );
    res.json({ servers: statuses });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/servers/:name/plugins', async (req, res) => {
  const { name } = req.params;
  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }

  try {
    const plugins = await pluginManager.listInstalledPlugins(name);
    const enriched = plugins.map((plugin) => ({
      ...plugin,
      version: inferVersionFromPlugin(plugin.plugin)
    }));
    return res.json({ server: name, plugins: enriched });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post(
  '/api/servers/:name/plugins/upload',
  express.raw({ type: ['application/java-archive', 'application/octet-stream'], limit: '250mb' }),
  async (req, res) => {
    const { name } = req.params;
    const actor = req.auth.username;
    const filename = req.query.filename || req.headers['x-plugin-filename'];

    if (typeof filename !== 'string' || filename.length < 5 || filename.length > 128) {
      return res.status(400).json({ error: 'A valid plugin filename is required' });
    }

    if (!validateServer(name)) {
      return res.status(404).json({ error: `Unknown server: ${name}` });
    }

    try {
      const staged = await pluginManager.stageUpload({
        server: name,
        filename,
        sourceBuffer: req.body
      });

      const result = await pluginManager.applyStagedPlugin({
        actor,
        server: name,
        pluginName: staged.pluginName,
        stagedPath: staged.stagedPath
      });
      return res.json(result);
    } catch (error) {
      await pluginManager.audit({
        actor,
        action: 'upload-install',
        server: name,
        plugin: filename || '-',
        result: `error:${error.message}`
      });
      return res.status(400).json({ error: error.message });
    }
  }
);

app.post('/api/servers/:name/plugins/install-from-url', sanitizePluginUrlBody, async (req, res) => {
  const { name } = req.params;
  const actor = req.auth.username;
  const { url } = req.body || {};

  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }

  try {
    const staged = await pluginManager.stageFromUrl({ server: name, url });
    const result = await pluginManager.applyStagedPlugin({
      actor,
      server: name,
      pluginName: staged.pluginName,
      stagedPath: staged.stagedPath
    });
    return res.json(result);
  } catch (error) {
    await pluginManager.audit({
      actor,
      action: 'url-install',
      server: name,
      plugin: url || '-',
      result: `error:${error.message}`
    });
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/servers/:name/plugins/:plugin/enable', async (req, res) => {
  const { name, plugin } = req.params;
  const actor = req.auth.username;
  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }

  try {
    const result = await pluginManager.setPluginEnabled({
      actor,
      server: name,
      pluginName: plugin,
      enabled: true
    });
    return res.json(result);
  } catch (error) {
    await pluginManager.audit({ actor, action: 'enable', server: name, plugin, result: `error:${error.message}` });
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/servers/:name/plugins/:plugin/disable', async (req, res) => {
  const { name, plugin } = req.params;
  const actor = req.auth.username;
  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }

  try {
    const result = await pluginManager.setPluginEnabled({
      actor,
      server: name,
      pluginName: plugin,
      enabled: false
    });
    return res.json(result);
  } catch (error) {
    await pluginManager.audit({ actor, action: 'disable', server: name, plugin, result: `error:${error.message}` });
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/servers/:name/plugins/:plugin/reload', async (req, res) => {
  const { name, plugin } = req.params;
  const actor = req.auth.username;
  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }
  try {
    const result = await pluginManager.reloadPlugin({
      actor,
      server: name,
      pluginName: plugin
    });
    return res.json(result);
  } catch (error) {
    await pluginManager.audit({ actor, action: 'reload', server: name, plugin, result: `error:${error.message}` });
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/servers/:name/plugins/:plugin', requireAdmin, async (req, res) => {
  const { name, plugin } = req.params;
  const actor = req.auth.username;
  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }
  try {
    const result = await pluginManager.removePlugin({
      actor,
      server: name,
      pluginName: plugin
    });
    return res.json(result);
  } catch (error) {
    await pluginManager.audit({ actor, action: 'remove', server: name, plugin, result: `error:${error.message}` });
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/servers/:name/plugins/:plugin/rollback', async (req, res) => {
  const { name, plugin } = req.params;
  const actor = req.auth.username;
  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }
  try {
    const result = await pluginManager.rollbackLastChange({
      actor,
      server: name,
      pluginName: plugin
    });
    return res.json(result);
  } catch (error) {
    await pluginManager.audit({ actor, action: 'rollback', server: name, plugin, result: `error:${error.message}` });
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/servers/:name/:action(start|stop|restart)', async (req, res) => {
  const { name, action } = req.params;

  if (!validateServer(name)) {
    return res.status(404).json({ error: `Unknown server: ${name}` });
  }

  if (action === 'restart' && req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required for restart' });
  }

  try {
    const result = await executeServerAction(name, action);
    return res.json({
      ok: true,
      server: name,
      action,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      server: name,
      action,
      error: error.message
    });
  }
});

app.get('/api/metrics/timeseries', (req, res) => {
  const { server, window } = req.query;

  if (!server || !validateServer(server)) {
    return res.status(400).json({
      error: 'Query parameter "server" must be one of proxy,lobby,survival'
    });
  }

  const series = metricsCollector.getTimeseries(server, window);
  return res.json(series);
});

app.get('/api/metrics/overview', (req, res) => {
  const byServer = ALLOWED_SERVERS.reduce((acc, server) => {
    const series = metricsCollector.getTimeseries(server, '10m');
    const latest = series?.points?.[series.points.length - 1] || null;
    acc[server] = latest;
    return acc;
  }, {});

  return res.json({
    timestamp: nowIso(),
    byServer,
    totals: {
      players: Object.values(byServer).reduce((sum, item) => sum + Number(item?.players || 0), 0),
      memoryMb: Object.values(byServer).reduce((sum, item) => sum + Number(item?.memoryMb || 0), 0),
      cpuPercent: Object.values(byServer).reduce((sum, item) => sum + Number(item?.cpuPercent || 0), 0)
    }
  });
});

app.get('/api/players/online', (req, res) => {
  const byServer = metricsCollector.getPlayersByServer();
  return res.json({
    online: metricsCollector.getPlayersOnline(),
    players: buildSyntheticPlayers(byServer),
    timestamp: nowIso()
  });
});

app.get('/api/players/by-server', (req, res) => {
  return res.json({
    byServer: metricsCollector.getPlayersByServer(),
    timestamp: nowIso()
  });
});

app.get('/ws', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const initPayload = {
    online: metricsCollector.getPlayersOnline(),
    byServer: metricsCollector.getPlayersByServer(),
    timestamp: nowIso()
  };
  res.write(`event: players\ndata: ${JSON.stringify(initPayload)}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function shutdown() {
  metricsCollector.stop();
  for (const client of sseClients) {
    client.end();
  }
  sseClients.clear();
  process.exit(0);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}, 30_000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}, rateLimitWindowMs).unref();

process.on('SIGHUP', () => {
  authConfig = loadAuthConfig();
  console.log('admin-ui auth config reloaded');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(ADMIN_UI_PORT, ADMIN_UI_HOST, () => {
  pluginManager.init().catch((error) => {
    console.error('plugin manager init failed', error);
  });
  console.log(`admin-ui listening on http://${ADMIN_UI_HOST}:${ADMIN_UI_PORT}`);
});
