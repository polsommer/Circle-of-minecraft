const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MetricsCollector } = require('./metrics/collector');
const { PluginManager } = require('./plugins.manager');

const app = express();
app.use(express.json());

const ADMIN_UI_HOST = process.env.ADMIN_UI_HOST || '192.168.88.100';
const ADMIN_UI_PORT = Number(process.env.ADMIN_UI_PORT || 7070);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const networkDir = process.env.MC_NETWORK_DIR || path.join(repoRoot, 'mc-network');
const pluginDomainAllowlist = (process.env.PLUGIN_URL_ALLOWLIST || 'github.com,modrinth.com,cdn.modrinth.com,hangarcdn.papermc.io')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const ALLOWED_SERVERS = ['proxy', 'lobby', 'survival'];

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

async function getServerStatus(name) {
  const pattern = `${path.join('mc-network', name)}${path.sep}`;
  try {
    await runCommand('pgrep', ['-f', pattern]);
    return 'running';
  } catch {
    return 'stopped';
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'admin-ui',
    host: ADMIN_UI_HOST,
    port: ADMIN_UI_PORT,
    networkDir,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/servers', async (req, res) => {
  try {
    const statuses = await Promise.all(
      ALLOWED_SERVERS.map(async (name) => ({ name, status: await getServerStatus(name) }))
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
    return res.json({ server: name, plugins });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post(
  '/api/servers/:name/plugins/upload',
  express.raw({ type: ['application/java-archive', 'application/octet-stream'], limit: '250mb' }),
  async (req, res) => {
    const { name } = req.params;
    const actor = req.headers['x-actor'] || req.ip;
    const filename = req.query.filename || req.headers['x-plugin-filename'];
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

app.post('/api/servers/:name/plugins/install-from-url', async (req, res) => {
  const { name } = req.params;
  const actor = req.headers['x-actor'] || req.ip;
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
  const actor = req.headers['x-actor'] || req.ip;
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
  const actor = req.headers['x-actor'] || req.ip;
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
  const actor = req.headers['x-actor'] || req.ip;
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

app.delete('/api/servers/:name/plugins/:plugin', async (req, res) => {
  const { name, plugin } = req.params;
  const actor = req.headers['x-actor'] || req.ip;
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
  const actor = req.headers['x-actor'] || req.ip;
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

app.get('/api/players/online', (req, res) => {
  return res.json({
    online: metricsCollector.getPlayersOnline(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/players/by-server', (req, res) => {
  return res.json({
    byServer: metricsCollector.getPlayersByServer(),
    timestamp: new Date().toISOString()
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
    timestamp: new Date().toISOString()
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

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(ADMIN_UI_PORT, ADMIN_UI_HOST, () => {
  pluginManager.init().catch((error) => {
    console.error('plugin manager init failed', error);
  });
  console.log(`admin-ui listening on http://${ADMIN_UI_HOST}:${ADMIN_UI_PORT}`);
});
