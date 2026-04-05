const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { Readable } = require('stream');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizePluginName(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Plugin name is required');
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Plugin name cannot be empty');
  }

  const base = path.basename(trimmed);
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error('Plugin name contains unsupported characters');
  }
  return base;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${code})${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}

class PluginManager {
  constructor({ networkDir, allowedServers, executeServerAction, allowlistedDomains = [] }) {
    this.networkDir = networkDir;
    this.allowedServers = new Set(allowedServers);
    this.executeServerAction = executeServerAction;
    this.allowlistedDomains = allowlistedDomains.filter(Boolean).map((domain) => domain.toLowerCase());

    this.adminDir = path.join(this.networkDir, '.admin-ui', 'plugins');
    this.stagingDir = path.join(this.adminDir, 'staging');
    this.backupDir = path.join(this.networkDir, 'backups', 'plugins');
    this.auditLogPath = path.join(this.networkDir, 'backups', 'admin-ui-audit.log');
    this.historyPath = path.join(this.backupDir, '.history.json');
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.stagingDir, { recursive: true }),
      fsp.mkdir(this.backupDir, { recursive: true }),
      fsp.mkdir(path.dirname(this.auditLogPath), { recursive: true })
    ]);
  }

  validateServer(server) {
    if (!this.allowedServers.has(server)) {
      throw new Error(`Unknown server: ${server}`);
    }
  }

  pluginsDir(server) {
    return path.join(this.networkDir, server, 'plugins');
  }

  async ensureServerPluginDir(server) {
    this.validateServer(server);
    const pluginDir = this.pluginsDir(server);
    await fsp.mkdir(pluginDir, { recursive: true });
    return pluginDir;
  }

  async listInstalledPlugins(server) {
    const pluginDir = await this.ensureServerPluginDir(server);
    const files = await fsp.readdir(pluginDir, { withFileTypes: true });

    return files
      .filter((entry) => entry.isFile() && (entry.name.endsWith('.jar') || entry.name.endsWith('.jar.disabled')))
      .map((entry) => {
        const enabled = entry.name.endsWith('.jar');
        const pluginFile = enabled ? entry.name : entry.name.slice(0, -'.disabled'.length);
        return {
          plugin: pluginFile,
          state: enabled ? 'enabled' : 'disabled',
          path: path.join(pluginDir, entry.name)
        };
      })
      .sort((a, b) => a.plugin.localeCompare(b.plugin));
  }

  async stageUpload({ server, filename, sourceBuffer }) {
    this.validateServer(server);
    if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
      throw new Error('Uploaded file is empty');
    }

    const pluginName = sanitizePluginName(filename || 'uploaded-plugin.jar');
    if (!pluginName.endsWith('.jar')) {
      throw new Error('Uploaded plugin must have a .jar filename');
    }

    const serverStageDir = path.join(this.stagingDir, server);
    await fsp.mkdir(serverStageDir, { recursive: true });

    const stageToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagedPath = path.join(serverStageDir, `${stageToken}-${pluginName}`);
    await fsp.writeFile(stagedPath, sourceBuffer);

    return this.validateStagedJar(stagedPath, pluginName);
  }

  async stageFromUrl({ server, url }) {
    this.validateServer(server);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https URLs are supported');
    }

    const host = parsed.hostname.toLowerCase();
    const hostAllowed = this.allowlistedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!hostAllowed) {
      throw new Error(`Domain ${host} is not allowlisted`);
    }

    const pluginName = sanitizePluginName(path.basename(parsed.pathname) || 'downloaded-plugin.jar');
    if (!pluginName.endsWith('.jar')) {
      throw new Error('URL must end with a .jar filename');
    }

    const serverStageDir = path.join(this.stagingDir, server);
    await fsp.mkdir(serverStageDir, { recursive: true });

    const stageToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagedPath = path.join(serverStageDir, `${stageToken}-${pluginName}`);

    const response = await fetch(parsed);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download plugin: ${response.status} ${response.statusText}`);
    }

    const out = fs.createWriteStream(stagedPath, { flags: 'wx' });
    await pipeline(Readable.fromWeb(response.body), out);

    return this.validateStagedJar(stagedPath, pluginName);
  }

  async validateStagedJar(stagedPath, pluginName) {
    const checks = await this.validateJar(stagedPath);
    return {
      stagedPath,
      pluginName,
      sha256: checks.sha256,
      checks
    };
  }

  async validateJar(jarPath) {
    const fileBuffer = await fsp.readFile(jarPath);
    if (fileBuffer.length < 256) {
      throw new Error('JAR is unexpectedly small');
    }

    const entriesRes = await runCommand('unzip', ['-Z1', jarPath]);
    const entries = entriesRes.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

    const hasManifest = entries.some((entry) => entry.toUpperCase() === 'META-INF/MANIFEST.MF');
    if (!hasManifest) {
      throw new Error('JAR validation failed: missing META-INF/MANIFEST.MF');
    }

    const signatureFiles = entries.filter((entry) => /META-INF\/.+\.(SF|RSA|DSA|EC)$/i.test(entry));
    if (!signatureFiles.length) {
      throw new Error('JAR validation failed: missing signature files in META-INF');
    }

    const manifestRes = await runCommand('unzip', ['-p', jarPath, 'META-INF/MANIFEST.MF']);
    const manifest = manifestRes.stdout;

    if (!/Manifest-Version\s*:\s*.+/i.test(manifest)) {
      throw new Error('JAR validation failed: Manifest-Version not found');
    }

    const hasPluginMarker = /Main-Class\s*:|Implementation-Title\s*:|Bundle-Name\s*:/i.test(manifest);
    if (!hasPluginMarker) {
      throw new Error('JAR validation failed: manifest missing basic plugin markers');
    }

    const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
    return {
      sha256,
      hasManifest,
      signatureFiles: signatureFiles.length,
      pluginMarker: true
    };
  }

  async applyStagedPlugin({ actor, server, pluginName, stagedPath, restartIfRequired = true }) {
    const normalizedPlugin = sanitizePluginName(pluginName);
    this.validateServer(server);
    await this.ensureServerPluginDir(server);

    const pluginDir = this.pluginsDir(server);
    const targetPath = path.join(pluginDir, normalizedPlugin);
    const disabledPath = `${targetPath}.disabled`;
    const ts = nowStamp();

    const backups = [];

    const backupBase = path.join(this.backupDir, server, normalizedPlugin);
    await fsp.mkdir(backupBase, { recursive: true });

    if (await this.pathExists(targetPath)) {
      const backupPath = path.join(backupBase, `${ts}.enabled.jar`);
      await fsp.copyFile(targetPath, backupPath);
      backups.push({ from: targetPath, backupPath, state: 'enabled' });
    }
    if (await this.pathExists(disabledPath)) {
      const backupPath = path.join(backupBase, `${ts}.disabled.jar`);
      await fsp.copyFile(disabledPath, backupPath);
      backups.push({ from: disabledPath, backupPath, state: 'disabled' });
    }

    const tempTarget = path.join(pluginDir, `.${normalizedPlugin}.${process.pid}.${Date.now()}.tmp`);
    await fsp.copyFile(stagedPath, tempTarget);
    await fsp.rename(tempTarget, targetPath);

    if (await this.pathExists(disabledPath)) {
      await fsp.rm(disabledPath, { force: true });
    }

    const restart = restartIfRequired;
    let restartResult = null;
    if (restart) {
      restartResult = await this.safeReloadOrRestart(server);
    }

    await this.recordHistory({
      ts,
      actor,
      action: 'install',
      server,
      plugin: normalizedPlugin,
      backups,
      previousState: backups.length ? 'replaced' : 'created',
      resultPath: targetPath
    });

    await this.audit({ actor, action: 'install', server, plugin: normalizedPlugin, result: 'success' });

    return {
      ok: true,
      server,
      plugin: normalizedPlugin,
      backups,
      restarted: Boolean(restartResult),
      restartMode: restartResult?.mode || null,
      restartStdout: restartResult?.stdout || ''
    };
  }

  async removePlugin({ actor, server, pluginName, restartIfRequired = true }) {
    const normalizedPlugin = sanitizePluginName(pluginName);
    this.validateServer(server);
    const pluginDir = await this.ensureServerPluginDir(server);
    const enabledPath = path.join(pluginDir, normalizedPlugin);
    const disabledPath = `${enabledPath}.disabled`;

    const existing = (await this.pathExists(enabledPath))
      ? { path: enabledPath, state: 'enabled' }
      : (await this.pathExists(disabledPath))
        ? { path: disabledPath, state: 'disabled' }
        : null;

    if (!existing) {
      throw new Error(`Plugin not found: ${normalizedPlugin}`);
    }

    const backupBase = path.join(this.backupDir, server, normalizedPlugin);
    await fsp.mkdir(backupBase, { recursive: true });
    const ts = nowStamp();
    const backupPath = path.join(backupBase, `${ts}.${existing.state}.jar`);
    await fsp.copyFile(existing.path, backupPath);
    await fsp.rm(existing.path, { force: true });

    let restartResult = null;
    if (restartIfRequired) {
      restartResult = await this.safeReloadOrRestart(server);
    }

    await this.recordHistory({
      ts,
      actor,
      action: 'remove',
      server,
      plugin: normalizedPlugin,
      backups: [{ from: existing.path, backupPath, state: existing.state }],
      previousState: existing.state,
      resultPath: null
    });

    await this.audit({ actor, action: 'remove', server, plugin: normalizedPlugin, result: 'success' });

    return {
      ok: true,
      server,
      plugin: normalizedPlugin,
      removedState: existing.state,
      backupPath,
      restarted: Boolean(restartResult),
      restartMode: restartResult?.mode || null
    };
  }

  async setPluginEnabled({ actor, server, pluginName, enabled, restartIfRequired = true }) {
    const normalizedPlugin = sanitizePluginName(pluginName);
    const pluginDir = await this.ensureServerPluginDir(server);
    const enabledPath = path.join(pluginDir, normalizedPlugin);
    const disabledPath = `${enabledPath}.disabled`;

    if (enabled) {
      if (!(await this.pathExists(disabledPath))) {
        if (await this.pathExists(enabledPath)) {
          return { ok: true, noop: true, state: 'enabled' };
        }
        throw new Error(`Plugin not found in disabled state: ${normalizedPlugin}`);
      }
      await fsp.rename(disabledPath, enabledPath);
    } else {
      if (!(await this.pathExists(enabledPath))) {
        if (await this.pathExists(disabledPath)) {
          return { ok: true, noop: true, state: 'disabled' };
        }
        throw new Error(`Plugin not found in enabled state: ${normalizedPlugin}`);
      }
      await fsp.rename(enabledPath, disabledPath);
    }

    let restartResult = null;
    if (restartIfRequired) {
      restartResult = await this.safeReloadOrRestart(server);
    }

    await this.audit({
      actor,
      action: enabled ? 'enable' : 'disable',
      server,
      plugin: normalizedPlugin,
      result: 'success'
    });

    return {
      ok: true,
      server,
      plugin: normalizedPlugin,
      state: enabled ? 'enabled' : 'disabled',
      restarted: Boolean(restartResult),
      restartMode: restartResult?.mode || null
    };
  }

  async reloadPlugin({ actor, server, pluginName }) {
    const normalizedPlugin = sanitizePluginName(pluginName);
    this.validateServer(server);

    const reloadScript = path.join(this.networkDir, server, 'reload-plugins.sh');
    if (!(await this.pathExists(reloadScript))) {
      throw new Error(`Reload is not supported for server ${server}`);
    }

    const result = await runCommand(reloadScript, [], { cwd: this.networkDir });
    await this.audit({ actor, action: 'reload', server, plugin: normalizedPlugin, result: 'success' });

    return {
      ok: true,
      server,
      plugin: normalizedPlugin,
      mode: 'reload-script',
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  async rollbackLastChange({ actor, server, pluginName, restartIfRequired = true }) {
    this.validateServer(server);
    const history = await this.readHistory();

    const idx = history
      .map((item, index) => ({ item, index }))
      .reverse()
      .find(({ item }) => item.server === server && (!pluginName || item.plugin === pluginName))?.index;

    if (idx === undefined) {
      throw new Error('No plugin change found to rollback');
    }

    const entry = history[idx];
    const pluginDir = await this.ensureServerPluginDir(server);
    const enabledPath = path.join(pluginDir, entry.plugin);
    const disabledPath = `${enabledPath}.disabled`;

    await fsp.rm(enabledPath, { force: true });
    await fsp.rm(disabledPath, { force: true });

    for (const backup of entry.backups || []) {
      const targetPath = backup.state === 'disabled' ? disabledPath : enabledPath;
      await fsp.copyFile(backup.backupPath, targetPath);
    }

    history.splice(idx, 1);
    await this.writeHistory(history);

    let restartResult = null;
    if (restartIfRequired) {
      restartResult = await this.safeReloadOrRestart(server);
    }

    await this.audit({ actor, action: 'rollback', server, plugin: entry.plugin, result: 'success' });

    return {
      ok: true,
      rolledBack: {
        action: entry.action,
        ts: entry.ts,
        plugin: entry.plugin
      },
      restarted: Boolean(restartResult),
      restartMode: restartResult?.mode || null
    };
  }

  async safeReloadOrRestart(server) {
    const reloadScript = path.join(this.networkDir, server, 'reload-plugins.sh');
    if (await this.pathExists(reloadScript)) {
      const result = await runCommand(reloadScript, [], { cwd: this.networkDir });
      return { ...result, mode: 'reload-script' };
    }

    const restart = await this.executeServerAction(server, 'restart');
    return { ...restart, mode: 'restart' };
  }

  async recordHistory(entry) {
    const history = await this.readHistory();
    history.push(entry);
    if (history.length > 200) {
      history.splice(0, history.length - 200);
    }
    await this.writeHistory(history);
  }

  async readHistory() {
    try {
      const raw = await fsp.readFile(this.historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async writeHistory(history) {
    await fsp.mkdir(path.dirname(this.historyPath), { recursive: true });
    const temp = path.join(path.dirname(this.historyPath), `.history-${process.pid}-${Date.now()}.tmp`);
    await fsp.writeFile(temp, JSON.stringify(history, null, 2));
    await fsp.rename(temp, this.historyPath);
  }

  async audit({ actor, action, server, plugin, result }) {
    const entry = {
      ts: new Date().toISOString(),
      actor: actor || 'unknown',
      action,
      server,
      plugin: plugin || '-',
      result
    };
    await fsp.mkdir(path.dirname(this.auditLogPath), { recursive: true });
    await fsp.appendFile(this.auditLogPath, JSON.stringify(entry) + os.EOL);
  }

  async pathExists(filePath) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  PluginManager
};
