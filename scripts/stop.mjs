import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PIDS_FILE = path.join(DATA_DIR, 'vtt.pids.json');

function killTree(pid, label) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
    console.log(`Stopped ${label} (PID ${pid})`);
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(PIDS_FILE)) {
  console.log('No PID file found (data/vtt.pids.json). Nothing to stop.');
  process.exit(0);
}

try {
  const pids = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
  const stoppedServer = killTree(pids.serverPid, 'SQLite + WS Server');
  const stoppedVite = killTree(pids.vitePid, 'Vite Dev Server');
  if (!stoppedServer && !stoppedVite) {
    console.log('Processes were not running.');
  }
} catch (err) {
  console.warn('Could not parse PID file:', err);
} finally {
  fs.rmSync(PIDS_FILE, { force: true });
}
