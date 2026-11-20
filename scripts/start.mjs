import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const PIDS_FILE = path.join(DATA_DIR, 'vtt.pids.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (fs.existsSync(PIDS_FILE)) {
  try {
    const existing = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
    if (isAlive(existing.serverPid) || isAlive(existing.vitePid)) {
      console.log('Arena VTT is already running:');
      if (isAlive(existing.serverPid)) {
        console.log(`  SQLite/WS Server PID ${existing.serverPid} (http://localhost:3001)`);
      }
      if (isAlive(existing.vitePid)) {
        console.log(`  Vite Dev Server  PID ${existing.vitePid} (http://localhost:5173)`);
      }
      console.log('Run "npm stop" first to restart.');
      process.exit(0);
    }
  } catch {
    // Ignore corrupt pid file
  }
}

function spawnDetached(command, args, logName) {
  const logPath = path.join(DATA_DIR, logName);
  const outFd = fs.openSync(logPath, 'a');
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', outFd, outFd],
  });
  child.unref();
  return child.pid;
}

const serverPid = spawnDetached('npx', ['tsx', 'server/index.ts'], 'server.log');
const vitePid = spawnDetached('npx', ['vite'], 'vite.log');

fs.writeFileSync(
  PIDS_FILE,
  JSON.stringify(
    {
      serverPid,
      vitePid,
      startedAt: new Date().toISOString(),
    },
    null,
    2
  )
);

async function waitForUrl(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const [serverReady, viteReady] = await Promise.all([
  waitForUrl('http://localhost:3001/api/health'),
  waitForUrl('http://localhost:5173/'),
]);

console.log('Arena VTT started:');
console.log(
  `  SQLite + WS Server: http://localhost:3001 (${serverReady ? 'ready' : 'starting'}) [PID ${serverPid}]`
);
console.log(
  `  Vite Dev Server:    http://localhost:5173 (${viteReady ? 'ready' : 'starting'}) [PID ${vitePid}]`
);
console.log('Logs: data/server.log, data/vite.log');
