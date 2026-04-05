const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MetricsCollector } = require('./metrics/collector');

const app = express();
app.use(express.json());

const ADMIN_UI_HOST = process.env.ADMIN_UI_HOST || '192.168.88.100';
const ADMIN_UI_PORT = Number(process.env.ADMIN_UI_PORT || 7070);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const networkDir = process.env.MC_NETWORK_DIR || path.join(repoRoot, 'mc-network');

const ALLOWED_SERVERS = ['proxy', 'lobby', 'survival'];

app.use(express.static(path.join(__dirname, '..', 'public')));

const metricsCollector = new MetricsCollector({ servers: ALLOWED_SERVERS });
const sseClients = new Set();

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
  console.log(`admin-ui listening on http://${ADMIN_UI_HOST}:${ADMIN_UI_PORT}`);
});
