require('dotenv').config();

const path = require('path');
const { execFile, spawn } = require('child_process');

const DEFAULT_KOKORO_BASE = 'http://127.0.0.1:8880';
const DEFAULT_KOKORO_READY_TIMEOUT_MS = 120000;
const DEFAULT_CLAUDIO_PORT = '8080';

const children = new Set();
let shuttingDown = false;

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function redactSensitiveText(value = '') {
  return String(value)
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)[^,\s"']+/gi, '$1[redacted]')
    .replace(/((?:SPOTIFY|VOLCENGINE|DEEPSEEK|GEMINI|OPENAI)_[A-Z0-9_]*=)[^\s]+/g, '$1[redacted]');
}

function kokoroPort(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return '8880';
  }
}

function claudioPort() {
  return String(process.env.PORT || DEFAULT_CLAUDIO_PORT);
}

function kokoroBaseUrl() {
  return (process.env.KOKORO_API_BASE || DEFAULT_KOKORO_BASE).replace(/\/+$/, '');
}

function providerIsKokoro(value) {
  return String(value || '').trim().toLowerCase() === 'kokoro';
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function findListeningPids(port) {
  if (process.platform === 'win32') {
    console.warn('[start] Automatic port cleanup is not implemented on Windows.');
    return [];
  }

  try {
    const stdout = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return [...new Set(stdout
      .split(/\s+/)
      .map(value => Number(value))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    )];
  } catch (err) {
    if (err.code === 1) return [];
    console.warn(`[start] Could not inspect port ${port}: ${err.message}`);
    return [];
  }
}

async function waitForPortFree(port, timeoutMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await findListeningPids(port);
    if (!pids.length) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

async function killPort(port, label) {
  const pids = await findListeningPids(port);
  if (!pids.length) return;

  console.warn(`[start] ${label} port ${port} is already in use by pid(s): ${pids.join(', ')}. Restarting cleanly.`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') console.warn(`[start] Failed to SIGTERM pid ${pid}: ${err.message}`);
    }
  }

  if (await waitForPortFree(port)) return;

  const stubbornPids = await findListeningPids(port);
  if (!stubbornPids.length) return;
  console.warn(`[start] ${label} port ${port} still busy; forcing pid(s): ${stubbornPids.join(', ')}.`);
  for (const pid of stubbornPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err.code !== 'ESRCH') console.warn(`[start] Failed to SIGKILL pid ${pid}: ${err.message}`);
    }
  }

  if (!(await waitForPortFree(port))) {
    throw new Error(`[start] ${label} port ${port} is still in use after cleanup.`);
  }
}

async function killClaudioPortIfNeeded() {
  if (!boolEnv('CLAUDIO_KILL_PORT_ON_START', true)) return;
  await killPort(claudioPort(), 'Claudio');
}

function spawnChild(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    ...options,
  });
  child.lastExit = null;
  child.stdoutBuffer = '';
  child.stderrBuffer = '';

  children.add(child);

  function writeRedactedOutput(stream, chunk, bufferKey) {
    child[bufferKey] += chunk.toString();
    const lines = child[bufferKey].split(/\r?\n/);
    child[bufferKey] = lines.pop() || '';
    for (const line of lines) {
      stream.write(`[${name}] ${redactSensitiveText(line)}\n`);
    }
  }

  function flushRedactedOutput(stream, bufferKey) {
    if (!child[bufferKey]) return;
    stream.write(`[${name}] ${redactSensitiveText(child[bufferKey])}`);
    child[bufferKey] = '';
  }

  child.stdout.on('data', chunk => {
    writeRedactedOutput(process.stdout, chunk, 'stdoutBuffer');
  });
  child.stderr.on('data', chunk => {
    writeRedactedOutput(process.stderr, chunk, 'stderrBuffer');
  });
  child.on('exit', (code, signal) => {
    flushRedactedOutput(process.stdout, 'stdoutBuffer');
    flushRedactedOutput(process.stderr, 'stderrBuffer');
    child.lastExit = { code, signal };
    children.delete(child);
    if (!shuttingDown && name === 'kokoro') {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      console.warn(`[${name}] exited before Claudio shutdown (${detail})`);
    }
    if (!shuttingDown && name === 'claudio') {
      shutdown(signal || code || 0);
    }
  });
  child.on('error', err => {
    children.delete(child);
    console.error(`[${name}] failed to start: ${err.message}`);
  });

  return child;
}

function shutdown(reason) {
  shuttingDown = true;
  const code = typeof reason === 'number' ? reason : 0;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  if (children.size === 0) process.exit(code);
  setTimeout(() => process.exit(code), 300).unref();
}

async function getKokoroStatus(baseUrl, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthUrl = new URL('/health', `${baseUrl}/`);
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    return {
      connected: true,
      model: body?.model || '',
      voice: body?.voice || '',
    };
  } catch {
    return { connected: false, model: '', voice: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForKokoro(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getKokoroStatus(baseUrl);
    if (status.connected) return status;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { connected: false, model: '', voice: '' };
}

async function startKokoroIfNeeded() {
  const requiredByConfig = providerIsKokoro(process.env.TTS_PROVIDER) ||
    providerIsKokoro(process.env.CALLER_TTS_PROVIDER);
  if (!requiredByConfig) return { connected: false, required: false };

  const autoStart = boolEnv('KOKORO_AUTO_START', true);
  const required = boolEnv('KOKORO_REQUIRED', true);
  const baseUrl = kokoroBaseUrl();
  const existingStatus = await getKokoroStatus(baseUrl);
  if (existingStatus.connected) {
    console.log(`[start] Kokoro TTS 已在运行: ${baseUrl}`);
    return { connected: true, baseUrl, required };
  }

  if (!autoStart) {
    const message = `[start] Kokoro TTS is configured but not reachable: ${baseUrl}`;
    if (required) throw new Error(message);
    console.warn(`${message}. Continuing without local voice synthesis.`);
    return { connected: false, baseUrl, required };
  }

  if (boolEnv('KOKORO_KILL_PORT_ON_START', true)) {
    const port = kokoroPort(baseUrl);
    const blockingPids = await findListeningPids(port);
    if (blockingPids.length) {
      console.warn(`[start] Kokoro TTS port ${port} is occupied but health check failed.`);
      await killPort(port, 'Kokoro TTS');
    }
  }

  const timeoutMs = Number(process.env.KOKORO_READY_TIMEOUT_MS || DEFAULT_KOKORO_READY_TIMEOUT_MS);
  const kokoroEnv = {
    ...process.env,
    KOKORO_PORT: process.env.KOKORO_PORT || kokoroPort(baseUrl),
  };
  const scriptPath = path.join(__dirname, 'kokoro-api.js');
  console.log(`[start] Starting Kokoro TTS sidecar: ${process.execPath} ${scriptPath} (PORT=${kokoroEnv.KOKORO_PORT})`);
  const sidecar = spawnChild('kokoro', process.execPath, [scriptPath], { env: kokoroEnv });

  const startedStatus = await waitForKokoro(baseUrl, timeoutMs);
  if (startedStatus.connected) {
    console.log(`[start] Kokoro TTS 已启动: ${baseUrl}`);
    return { connected: true, baseUrl, required };
  }

  const sidecarState = sidecar.lastExit
    ? `exited ${sidecar.lastExit.signal || sidecar.lastExit.code}`
    : `still running as pid ${sidecar.pid}`;
  const message = `[start] Kokoro TTS did not become ready within ${timeoutMs}ms (${sidecarState}).`;
  if (required) throw new Error(message);
  console.warn(`${message} Continuing without local voice synthesis.`);
  return { connected: false, baseUrl, required };
}

async function main() {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await killClaudioPortIfNeeded();
  await startKokoroIfNeeded();
  spawnChild('claudio', process.execPath, ['server.js'], {
    env: process.env,
  });
}

main().catch(err => {
  console.error('[start] failed:', redactSensitiveText(err.message));
  shutdown(1);
});
