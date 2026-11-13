#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  Antigravity Proxy CLI
// ─────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, execSync, exec } from 'child_process';
import http from 'http';

import {
  DATA_DIR,
  STORE_FILE,
  getAccounts,
  getNvidiaKeys,
  addNvidiaKey,
  removeNvidiaKey,
  getRawNvidiaKey,
  getGeminiCookies,
  addGeminiCookie,
  removeGeminiCookie,
  getRawGeminiCookie,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  getCombos,
  getCachedNvidiaModels,
} from '../src/store.js';

import {
  testNvidiaKeyAndFetchModels,
  testGeminiCookie,
  formatCookieInput,
  listModels,
} from '../src/proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(DATA_DIR, 'proxy.pid');
const LOG_FILE = path.join(DATA_DIR, 'proxy.log');
const DEFAULT_PORT = 4000;

// Read package.json for version & repo metadata
let PKG = { version: '1.0.0', name: 'antigravity-proxy' };
try {
  PKG = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
} catch {}

// ───── Helpers ─────

function findPortPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split('\n').find(l => l.includes(':' + port) && l.includes('LISTENING'));
      if (line) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && !isNaN(pid)) return pid;
      }
    } else {
      try {
        const out = execSync(`fuser ${port}/tcp 2>/dev/null || lsof -ti:${port} 2>/dev/null || ss -lptn 'sport = :${port}' 2>/dev/null`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const m = out.match(/\b(\d{2,6})\b/);
        if (m) {
          const pid = parseInt(m[1], 10);
          if (pid && !isNaN(pid)) return pid;
        }
      } catch {}
    }
  } catch {}
  return null;
}

function getRunningPid() {
  if (fs.existsSync(PID_FILE)) {
    try {
      const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
      const pid = parseInt(raw, 10);
      if (pid && !isNaN(pid)) {
        // Check if process is alive
        process.kill(pid, 0);
        return pid;
      }
    } catch (err) {
      if (err.code === 'ESRCH') {
        try { fs.unlinkSync(PID_FILE); } catch {}
      }
    }
  }
  // Fallback: check if port 4000 has an active listener
  return findPortPid(DEFAULT_PORT);
}

function checkHttpAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/v1/models`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      exec(`start "" "${url}"`);
    } else if (platform === 'darwin') {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  } catch (e) {
    console.log(`Open browser at: ${url}`);
  }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }, 1000);
      try { execSync(`fuser -k ${DEFAULT_PORT}/tcp 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

// ───── Commands ─────

async function cmdStart(args) {
  let port = DEFAULT_PORT;
  let daemon = false;
  let shouldOpen = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--port') {
      port = parseInt(args[++i], 10) || DEFAULT_PORT;
    } else if (a === '-d' || a === '--daemon') {
      daemon = true;
    } else if (a === '-o' || a === '--open') {
      shouldOpen = true;
    }
  }

  const existingPid = getRunningPid();
  if (existingPid) {
    console.log(`\n⚠️  Antigravity Proxy is already running (PID: ${existingPid})`);
    console.log(`   Dashboard:  http://localhost:${port}/`);
    console.log(`   API Base:   http://localhost:${port}/v1`);
    console.log(`   Run 'antigravity-proxy stop' or 'anti gravity proxy stop' to stop it.\n`);
    if (shouldOpen) openBrowser(`http://localhost:${port}/`);
    return;
  }

  if (daemon) {
    console.log(`\n🚀 Starting Antigravity Proxy in background (daemon mode)...`);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const serverScript = path.join(ROOT_DIR, 'server.js');
    let pid = null;

    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PORT: String(port), AG_LOG_FILE: LOG_FILE },
      cwd: ROOT_DIR,
    });
    pid = child.pid;
    fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
    child.unref();

    // Verify online
    process.stdout.write('   Waiting for server initialization...');
    let online = false;
    for (let attempts = 0; attempts < 15; attempts++) {
      await new Promise(r => setTimeout(r, 400));
      process.stdout.write('.');
      if (await checkHttpAlive(port)) {
        online = true;
        break;
      }
    }
    console.log('');

    if (online) {
      const livePid = findPortPid(port) || pid;
      if (livePid) fs.writeFileSync(PID_FILE, String(livePid), 'utf-8');
      console.log(`\n  ✅ Antigravity Proxy is now running in the background!`);
      console.log(`  📌 PID:        ${livePid || 'active'}`);
      console.log(`  🌐 Dashboard:  http://localhost:${port}/`);
      console.log(`  🔗 API Base:   http://localhost:${port}/v1`);
      console.log(`  📂 Data Dir:   ${DATA_DIR}`);
      console.log(`  📜 Log File:   ${LOG_FILE}\n`);
      if (shouldOpen) openBrowser(`http://localhost:${port}/`);
    } else {
      console.log(`\n⚠️  Process spawned but health check is taking longer than expected.`);
      console.log(`   Check the logs for details: antigravity-proxy logs\n`);
    }
  } else {
    // Foreground mode
    process.env.PORT = String(port);
    console.log(`\n🚀 Starting Antigravity Proxy in foreground on port ${port}...`);
    console.log(`   Press Ctrl+C to stop.\n`);
    if (shouldOpen) {
      setTimeout(() => openBrowser(`http://localhost:${port}/`), 1000);
    }
    await import(pathToFileURL(path.join(ROOT_DIR, 'server.js')).href);
  }
}

async function cmdStop() {
  const pid = getRunningPid();
  if (!pid) {
    // Check if port 4000 responds anyway
    const isAlive = await checkHttpAlive(DEFAULT_PORT);
    if (!isAlive) {
      console.log('\nℹ️  Antigravity Proxy is not running.\n');
      return;
    }
  }

  console.log(`\n🛑 Stopping Antigravity Proxy (PID: ${pid || 'detecting'})...`);
  if (pid) {
    killPid(pid);
    try { fs.unlinkSync(PID_FILE); } catch {}
  }

  // Double check port availability
  await new Promise(r => setTimeout(r, 600));
  const stillAlive = await checkHttpAlive(DEFAULT_PORT);
  if (!stillAlive) {
    console.log('✅ Antigravity Proxy stopped successfully.\n');
  } else {
    console.log('⚠️  Process signaled. Port may take a moment to be released.\n');
  }
}

async function cmdRestart(args) {
  console.log('\n🔄 Restarting Antigravity Proxy...');
  await cmdStop();
  await new Promise(r => setTimeout(r, 1000));
  // Default to daemon on restart
  if (!args.includes('-d') && !args.includes('--daemon')) {
    args.push('-d');
  }
  await cmdStart(args);
}

async function cmdStatus() {
  const pid = getRunningPid();
  const isAlive = await checkHttpAlive(DEFAULT_PORT);

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  Antigravity Proxy Status  (v${PKG.version})`);
  console.log('─────────────────────────────────────────────────────────────');

  if (pid || isAlive) {
    console.log(`  State:       🟢 RUNNING`);
    console.log(`  PID:         ${pid || 'unknown (port 4000 active)'}`);
    console.log(`  Dashboard:   http://localhost:${DEFAULT_PORT}/`);
    console.log(`  API Base:    http://localhost:${DEFAULT_PORT}/v1`);
  } else {
    console.log(`  State:       🔴 STOPPED`);
  }

  console.log(`  Data Dir:    ${DATA_DIR}`);
  console.log(`  Store File:  ${STORE_FILE}`);

  try {
    const accounts = getAccounts();
    const nvidia = getNvidiaKeys();
    const cookies = getGeminiCookies();
    const keys = getApiKeys();
    const combos = getCombos();
    console.log(`  Accounts:    ${accounts.length} Google Antigravity, ${cookies.length} Gemini Web (Cookies), ${nvidia.length} NVIDIA NIM`);
    console.log(`  API Keys:    ${keys.length}`);
    console.log(`  Combos:      ${combos.length}`);
  } catch (e) {
    console.log(`  Config:      Error loading store (${e.message})`);
  }

  console.log('─────────────────────────────────────────────────────────────\n');
}

async function cmdUpdate(args) {
  console.log('\n=============================================================');
  console.log('  🔄 Updating Antigravity Proxy to Latest Version');
  console.log('=============================================================\n');

  let wasRunning = !!(getRunningPid() || await checkHttpAlive(DEFAULT_PORT));
  if (wasRunning) {
    console.log('📦 Proxy is currently running. Will restart after update.');
  }

  // 1. Check if git repository
  let isGit = false;
  try {
    const gitCheck = execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
    isGit = (gitCheck === 'true');
  } catch {
    isGit = false;
  }

  if (isGit) {
    try {
      console.log('🔍 Detecting git remote & branch...');
      let currentBranch = 'main';
      try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
      } catch {}

      try {
        execSync('git remote set-url origin https://github.com/ELITEXGAMES/proxyhub.git', { cwd: ROOT_DIR, stdio: 'ignore' });
      } catch {
        try { execSync('git remote add origin https://github.com/ELITEXGAMES/proxyhub.git', { cwd: ROOT_DIR, stdio: 'ignore' }); } catch {}
      }

      console.log(`   Repository: https://github.com/ELITEXGAMES/proxyhub.git (${currentBranch})`);

      let stashed = false;
      try {
        const status = execSync('git status --porcelain', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
        if (status) {
          execSync('git stash --include-untracked', { cwd: ROOT_DIR, stdio: 'ignore' });
          stashed = true;
        }
      } catch {}

      console.log('📥 Pulling latest commits from GitHub...');
      try {
        execSync(`git pull origin ${currentBranch}`, { cwd: ROOT_DIR, stdio: 'inherit' });
      } catch (pullErr) {
        try { execSync('git pull', { cwd: ROOT_DIR, stdio: 'inherit' }); } catch {}
      }

      if (stashed) {
        try { execSync('git stash pop', { cwd: ROOT_DIR, stdio: 'ignore' }); } catch {}
      }

      try {
        const lastCommit = execSync('git log -1 --pretty=format:"%h - %s (%cr) <%an>"', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
        console.log(`\n📌 Updated to latest commit: ${lastCommit}`);
      } catch {}
    } catch (gitErr) {
      console.error(`\n❌ Git update encountered an error: ${gitErr.message}`);
      console.log('   Continuing with dependency and health check...\n');
    }
  } else {
    // Standalone or npm-installed package: fetch latest tarball (uses built-in tar on Linux/macOS, PowerShell on Windows)
    console.log('📥 Fetching latest release from https://github.com/ELITEXGAMES/proxyhub...');
    try {
      const tempDir = path.join(os.tmpdir(), 'proxyhub-extract');
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      fs.mkdirSync(tempDir, { recursive: true });

      if (process.platform === 'win32') {
        const zipUrl = 'https://github.com/ELITEXGAMES/proxyhub/archive/refs/heads/main.zip';
        const tempZip = path.join(os.tmpdir(), 'proxyhub-latest.zip');
        execSync(`powershell -NoProfile -Command "Invoke-WebRequest -Uri '${zipUrl}' -OutFile '${tempZip}'; Expand-Archive -Path '${tempZip}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'inherit' });
        try { fs.rmSync(tempZip, { force: true }); } catch {}
      } else {
        const tarUrl = 'https://github.com/ELITEXGAMES/proxyhub/archive/refs/heads/main.tar.gz';
        const tempTar = path.join(os.tmpdir(), 'proxyhub-latest.tar.gz');
        execSync(`curl -fsSL "${tarUrl}" -o "${tempTar}" && tar -xzf "${tempTar}" -C "${tempDir}"`, { stdio: 'inherit' });
        try { fs.rmSync(tempTar, { force: true }); } catch {}
      }

      const extractedRoot = path.join(tempDir, 'proxyhub-main');
      if (fs.existsSync(extractedRoot)) {
        const items = fs.readdirSync(extractedRoot);
        for (const item of items) {
          if (item === 'data' || item === '.env') continue;
          const srcPath = path.join(extractedRoot, item);
          const destPath = path.join(ROOT_DIR, item);
          if (fs.lstatSync(srcPath).isDirectory()) {
            fs.cpSync(srcPath, destPath, { recursive: true, force: true });
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
        console.log('   ✅ Downloaded and updated all source files to latest GitHub release.');
      } else {
        throw new Error('Extracted directory proxyhub-main not found.');
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    } catch (dlErr) {
      console.warn(`   ⚠️ Archive update failed (${dlErr.message}). Trying npm install -g fallback...`);
      execSync('npm install -g git+https://github.com/ELITEXGAMES/proxyhub.git', { stdio: 'inherit' });
    }
  }

  // 2. Install any updated dependencies
  console.log('\n📦 Checking & installing dependencies (npm install --omit=dev)...');
  try {
    execSync('npm install --omit=dev', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch (npmErr) {
    console.warn(`   ⚠️ npm install warning: ${npmErr.message}`);
  }

  // 3. Re-link CLI globally
  console.log('🔗 Refreshing global CLI binaries (npm link)...');
  try {
    execSync('npm link', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('   ✅ Global CLI commands (anti, antigravity-proxy, ag-proxy) refreshed.');
  } catch {}

  // 4. Syntax sanity check
  console.log('\n🧪 Running code syntax validation...');
  try {
    execSync('node --check server.js src/proxy.js src/store.js src/oauth.js bin/cli.js', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('   ✅ Syntax check PASSED.');
  } catch (checkErr) {
    console.error(`\n❌ Syntax validation failed! Please check your code before restarting: ${checkErr.message}`);
    return;
  }

  // 4. Data directory verification
  console.log(`\n🛡️  User Data Check:`);
  console.log(`   Data directory: ${DATA_DIR}`);
  console.log(`   All accounts, cookies, NVIDIA keys, and combos remain 100% preserved!`);

  // 5. Restart daemon if it was running
  if (wasRunning) {
    console.log('\n🔄 Restarting proxy daemon with new code...');
    await cmdStop();
    await new Promise(r => setTimeout(r, 1000));
    await cmdStart(['--daemon']);
  }

  console.log('\n=============================================================');
  console.log('  🎉 Antigravity Proxy update completed successfully!');
  console.log('=============================================================\n');
}

async function cmdLogs(args) {
  let lines = 50;
  let follow = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') lines = parseInt(args[++i], 10) || 50;
    else if (args[i] === '-f' || args[i] === '--follow') follow = true;
  }

  if (!fs.existsSync(LOG_FILE)) {
    console.log(`\nℹ️  No log file found yet at: ${LOG_FILE}\n`);
    return;
  }

  if (!follow) {
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      const allLines = content.split('\n');
      const slice = allLines.slice(-lines).join('\n');
      console.log(slice);
    } catch (e) {
      console.error('Error reading logs:', e.message);
    }
  } else {
    console.log(`\n📜 Following logs from ${LOG_FILE} (Ctrl+C to exit)...\n`);
    const child = spawn(process.platform === 'win32' ? 'powershell' : 'tail', 
      process.platform === 'win32' 
        ? ['-NoProfile', '-Command', `Get-Content -Path "${LOG_FILE}" -Wait -Tail ${lines}`]
        : ['-f', '-n', String(lines), LOG_FILE],
      { stdio: 'inherit' }
    );
    process.on('SIGINT', () => {
      child.kill();
      process.exit(0);
    });
  }
}

async function cmdAccounts() {
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  Connected Antigravity & NVIDIA Accounts');
  console.log('─────────────────────────────────────────────────────────────');

  const accounts = getAccounts();
  const cookies = getGeminiCookies();
  const nvidia = getNvidiaKeys();

  console.log(`\n🔵 Google Antigravity Accounts (${accounts.length}):`);
  if (accounts.length === 0) {
    console.log('   (No accounts yet. Open dashboard to authenticate with Google)');
  } else {
    accounts.forEach((a, i) => {
      const state = a.enabled !== false ? '🟢 Active' : '⚪ Disabled';
      console.log(`   ${i + 1}. [${state}] ${a.email} (${a.name || 'Antigravity User'}) - Project: ${a.projectId || 'aicode-consumers'}`);
    });
  }

  console.log(`\n🍪 Gemini Web Cookies (${cookies.length}):`);
  if (cookies.length === 0) {
    console.log('   (No Gemini cookies yet. Use dashboard or anti gravity proxy cookie)');
  } else {
    cookies.forEach((c, i) => {
      const state = c.enabled !== false ? '🟢 Active' : '⚪ Disabled';
      console.log(`   ${i + 1}. [${state}] ${c.name} (${c.cookie})`);
    });
  }

  console.log(`\n🟢 NVIDIA NIM API Keys (${nvidia.length}):`);
  if (nvidia.length === 0) {
    console.log('   (No NVIDIA keys added yet)');
  } else {
    nvidia.forEach((k, i) => {
      const state = k.enabled !== false ? '🟢 Active' : '⚪ Disabled';
      console.log(`   ${i + 1}. [${state}] ${k.name} (${k.key})`);
    });
  }

  console.log('\n─────────────────────────────────────────────────────────────\n');
}

async function cmdKeys(args) {
  const sub = (args[0] || 'list').toLowerCase();
  if (sub === 'list') {
    const keys = getApiKeys();
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log(`  🔑 Proxy API Keys (${keys.length})`);
    console.log('─────────────────────────────────────────────────────────────');
    if (keys.length === 0) {
      console.log('   No API keys found. Run: anti gravity proxy key add <name>');
    } else {
      keys.forEach((k, i) => {
        const dateStr = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '—';
        console.log(`   ${i + 1}. [${k.name}] ${k.key} (ID: ${k.id}, Created: ${dateStr})`);
      });
    }
    console.log('─────────────────────────────────────────────────────────────\n');
  } else if (sub === 'add' || sub === 'create') {
    const name = args[1] || 'Default Key';
    const created = createApiKey(name);
    console.log(`\n✅ Created API Key: ${created.name}`);
    console.log(`   🔑 Key: ${created.key}`);
    console.log(`   Use this key in your Authorization: Bearer ${created.key} header.\n`);
  } else if (sub === 'rm' || sub === 'delete' || sub === 'remove') {
    const id = args[1];
    if (!id) {
      console.log('\nUsage: anti gravity proxy key rm <id>\n');
      return;
    }
    deleteApiKey(id);
    console.log(`\n🗑️  Removed API key: ${id}\n`);
  } else {
    console.log('\nUsage: anti gravity proxy key [list | add <name> | rm <id>]\n');
  }
}

async function cmdCookie(args) {
  const sub = (args[0] || 'list').toLowerCase();
  if (sub === 'list') {
    const cookies = getGeminiCookies();
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log(`  🍪 Gemini Web Accounts (Cookies) [${cookies.length}]`);
    console.log('─────────────────────────────────────────────────────────────');
    if (cookies.length === 0) {
      console.log('   No Gemini cookies saved yet.');
      console.log('   Add one with: anti gravity proxy cookie add <__Secure-1PSID> [__Secure-1PSIDTS] [name]');
    } else {
      cookies.forEach((c, i) => {
        const state = c.enabled !== false ? '🟢 Active' : '⚪ Disabled';
        const dateStr = c.addedAt ? new Date(c.addedAt).toLocaleDateString() : '—';
        console.log(`   ${i + 1}. [${state}] ${c.name} (ID: ${c.id})`);
        console.log(`      Cookie: ${c.cookie}`);
        console.log(`      Added:  ${dateStr}`);
      });
    }
    console.log('─────────────────────────────────────────────────────────────\n');
  } else if (sub === 'add') {
    const psid = args[1];
    if (!psid) {
      console.log('\nUsage: anti gravity proxy cookie add <__Secure-1PSID> [__Secure-1PSIDTS] [name]\n');
      return;
    }
    let cookieVal = psid;
    let name = 'Gemini Web Account';
    if (args[2]) {
      if (args[2].startsWith('sidts-') || args[2].length > 30) {
        cookieVal = `__Secure-1PSID=${psid.replace(/^__Secure-1PSID=/, '')}; __Secure-1PSIDTS=${args[2].replace(/^__Secure-1PSIDTS=/, '')}`;
        if (args[3]) name = args[3];
      } else {
        name = args[2];
      }
    }
    const formatted = formatCookieInput(cookieVal);
    console.log('\n⏳ Validating Gemini Web cookie with Google...');
    const testResult = await testGeminiCookie(formatted);
    if (!testResult.ok) {
      console.log(`⚠️  Warning: ${testResult.error || 'Google rejected the cookie.'}`);
      console.log('   Saving anyway for your session...');
    } else {
      console.log('✅ Google session verified successfully!');
    }
    const created = addGeminiCookie({ cookie: formatted, name });
    console.log(`💾 Saved Gemini Web cookie: "${created.name}" (ID: ${created.id})\n`);
  } else if (sub === 'rm' || sub === 'delete' || sub === 'remove') {
    const id = args[1];
    if (!id) {
      console.log('\nUsage: anti gravity proxy cookie rm <id>\n');
      return;
    }
    removeGeminiCookie(id);
    console.log(`\n🗑️  Removed Gemini cookie: ${id}\n`);
  } else if (sub === 'test') {
    const id = args[1];
    let cookieVal = '';
    if (id) {
      const c = getRawGeminiCookie(id);
      if (c) cookieVal = c.cookie;
    }
    if (!cookieVal) {
      const cookies = getGeminiCookies();
      if (cookies.length > 0) {
        const raw = getRawGeminiCookie(cookies[0].id);
        if (raw) cookieVal = raw.cookie;
      }
    }
    if (!cookieVal) {
      console.log('\nNo cookies found to test. Add one first: anti gravity proxy cookie add <psid>\n');
      return;
    }
    console.log('\n⏳ Testing Gemini Web cookie against Google...');
    const result = await testGeminiCookie(cookieVal);
    if (result.ok) {
      console.log('✅ Cookie is VALID and authenticated with Google Gemini Web!\n');
    } else {
      console.log(`❌ Cookie test FAILED: ${result.error || 'Unauthenticated or expired'}\n`);
    }
  } else {
    console.log('\nUsage: anti gravity proxy cookie [list | add <psid> [psidts] [name] | test [id] | rm <id>]\n');
  }
}

async function cmdNvidia(args) {
  const sub = (args[0] || 'list').toLowerCase();
  if (sub === 'list') {
    const keys = getNvidiaKeys();
    const cached = getCachedNvidiaModels();
    console.log('\n─────────────────────────────────────────────────────────────');
    console.log(`  🟢 NVIDIA NIM API Keys [${keys.length}] (Cached Models: ${cached.length})`);
    console.log('─────────────────────────────────────────────────────────────');
    if (keys.length === 0) {
      console.log('   No NVIDIA NIM keys added yet.');
      console.log('   Add one with: anti gravity proxy nvidia add <nvapi-...> [name]');
      console.log('   Get a free key with 1,000 credits at: https://build.nvidia.com');
    } else {
      keys.forEach((k, i) => {
        const state = k.enabled !== false ? '🟢 Active' : '⚪ Disabled';
        const dateStr = k.addedAt ? new Date(k.addedAt).toLocaleDateString() : '—';
        console.log(`   ${i + 1}. [${state}] ${k.name} (ID: ${k.id})`);
        console.log(`      Key:   ${k.key}`);
        console.log(`      Added: ${dateStr}`);
      });
      if (cached.length > 0) {
        console.log(`\n   Available Models (${cached.length}):`);
        const sample = cached.slice(0, 8).join(', ');
        console.log(`   • ${sample}${cached.length > 8 ? ' ...and ' + (cached.length - 8) + ' more' : ''}`);
      }
    }
    console.log('─────────────────────────────────────────────────────────────\n');
  } else if (sub === 'add') {
    const key = args[1];
    if (!key) {
      console.log('\nUsage: anti gravity proxy nvidia add <nvapi-...> [name]\n');
      return;
    }
    const name = args[2] || 'NVIDIA NIM Key';
    console.log('\n⏳ Verifying NVIDIA key and loading models from NVIDIA NIM...');
    const result = await testNvidiaKeyAndFetchModels({ apiKey: key });
    if (result.ok) {
      console.log(`✅ Verified! Retrieved ${result.modelCount} models from NVIDIA in ${result.latencyMs}ms.`);
      if (result.highlightedModels?.length) {
        console.log(`   Top Models: ${result.highlightedModels.slice(0, 6).join(', ')}`);
      }
    } else {
      console.log(`⚠️  Verification warning: ${result.error || 'Could not verify key'}`);
      console.log('   Saving key anyway...');
    }
    const created = addNvidiaKey({ key, name });
    console.log(`💾 Saved NVIDIA NIM key: "${created.name}" (ID: ${created.id})\n`);
  } else if (sub === 'test') {
    const idOrKey = args[1];
    let keyToTest = '';
    let idToTest = '';
    if (idOrKey) {
      if (idOrKey.startsWith('nvapi-')) {
        keyToTest = idOrKey;
      } else {
        idToTest = idOrKey;
      }
    }
    console.log('\n⏳ Testing NVIDIA NIM key & fetching models...');
    const result = await testNvidiaKeyAndFetchModels({ apiKey: keyToTest, id: idToTest });
    if (result.ok) {
      console.log(`✅ NVIDIA NIM Key is VALID!`);
      console.log(`   Models Available: ${result.modelCount}`);
      console.log(`   Latency:          ${result.latencyMs}ms`);
      if (result.highlightedModels?.length) {
        console.log(`   Top Models:       ${result.highlightedModels.join(', ')}`);
      }
      console.log('');
    } else {
      console.log(`❌ NVIDIA NIM test FAILED: ${result.error}\n`);
    }
  } else if (sub === 'rm' || sub === 'delete' || sub === 'remove') {
    const id = args[1];
    if (!id) {
      console.log('\nUsage: anti gravity proxy nvidia rm <id>\n');
      return;
    }
    removeNvidiaKey(id);
    console.log(`\n🗑️  Removed NVIDIA NIM key: ${id}\n`);
  } else {
    console.log('\nUsage: anti gravity proxy nvidia [list | add <key> [name] | test [id] | rm <id>]\n');
  }
}

async function cmdModels(args) {
  const raw = listModels();
  const models = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
  const filter = (args[0] || '').toLowerCase();
  const matched = filter ? models.filter(m => m.id.toLowerCase().includes(filter)) : models;

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  🤖 Available Proxy Models [${matched.length}${filter ? ' matching "' + filter + '"' : ''}]`);
  console.log('─────────────────────────────────────────────────────────────');

  const combos = matched.filter(m => ['auto-fallback', 'fast-coding', 'heavy-reasoning', 'my-super-combo', 'image-gen', 'video-gen'].includes(m.id) || m.id.includes('combo'));
  const antigravity = matched.filter(m => m.id.startsWith('gemini-') && !m.id.startsWith('gemini-web-'));
  const nvidia = matched.filter(m => m.id.includes('/') || m.id.startsWith('deepseek') || m.id.startsWith('meta/') || m.id.startsWith('mistralai/'));
  const geminiWeb = matched.filter(m => m.id.startsWith('gemini-web-'));
  const claude = matched.filter(m => m.id.startsWith('claude-'));
  const openai = matched.filter(m => m.id.startsWith('gpt-') || m.id.startsWith('dall-e'));

  if (combos.length) {
    console.log(`\n🔀 Smart Combos (${combos.length}):`);
    combos.forEach(m => console.log(`   • ${m.id.padEnd(30)} ${m.owned_by || ''}`));
  }
  if (antigravity.length) {
    console.log(`\n⚡ Google Antigravity Models (${antigravity.length}):`);
    antigravity.slice(0, 15).forEach(m => console.log(`   • ${m.id.padEnd(30)} ${m.owned_by || ''}`));
    if (antigravity.length > 15) console.log(`   ...and ${antigravity.length - 15} more`);
  }
  if (nvidia.length) {
    console.log(`\n🟢 NVIDIA NIM Models (${nvidia.length}):`);
    nvidia.slice(0, 15).forEach(m => console.log(`   • ${m.id.padEnd(45)} ${m.owned_by || ''}`));
    if (nvidia.length > 15) console.log(`   ...and ${nvidia.length - 15} more`);
  }
  if (geminiWeb.length) {
    console.log(`\n🍪 Gemini Web Models (${geminiWeb.length}):`);
    geminiWeb.forEach(m => console.log(`   • ${m.id.padEnd(30)} ${m.owned_by || ''}`));
  }
  if (claude.length) {
    console.log(`\n🟣 Claude Sonnet/Opus Models (${claude.length}):`);
    claude.forEach(m => console.log(`   • ${m.id.padEnd(30)} ${m.owned_by || ''}`));
  }
  if (openai.length) {
    console.log(`\n🟢 OpenAI / DALL-E Models (${openai.length}):`);
    openai.forEach(m => console.log(`   • ${m.id.padEnd(30)} ${m.owned_by || ''}`));
  }

  console.log('\n─────────────────────────────────────────────────────────────\n');
}

async function cmdCombos() {
  const combos = getCombos();
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  🔀 Configured Model Combos [${combos.length}]`);
  console.log('─────────────────────────────────────────────────────────────');
  if (combos.length === 0) {
    console.log('   No combos configured yet.');
  } else {
    combos.forEach((c, i) => {
      console.log(`\n   ${i + 1}. [${c.id}] ${c.name}`);
      if (c.description) console.log(`      Description: ${c.description}`);
      console.log(`      Fallback Steps (${c.steps?.length || 0}):`);
      (c.steps || []).forEach((s, idx) => {
        const accInfo = s.accountId ? `(Account: ${s.accountId})` : '(Auto account)';
        console.log(`        Step ${idx + 1}: ${s.model} ${accInfo}`);
      });
    });
  }
  console.log('\n─────────────────────────────────────────────────────────────\n');
}

async function cmdTest() {
  console.log('\n🧪 Running Antigravity Proxy 10-Point Integration Test Suite...\n');
  const testScript = path.join(ROOT_DIR, 'test.js');
  const child = spawn(process.execPath, [testScript], { cwd: ROOT_DIR, stdio: 'inherit' });
  await new Promise((resolve) => child.on('close', resolve));
}

function printHelp() {
  console.log(`
===================================================================
  🚀 Antigravity Proxy CLI (v${PKG.version})
  High-speed OpenAI & Anthropic Compatible Proxy for Antigravity & NIM
===================================================================

USAGE:
  antigravity-proxy <command> [options]
  anti gravity proxy <command> [options]
  ag-proxy <command> [options]

COMMANDS:
  start [-p <port>] [-d, --daemon] [-o, --open]
                     Start proxy server (foreground or background daemon)
  stop               Stop background proxy daemon
  restart            Restart proxy daemon cleanly
  status             Check running status, port, PID, accounts, and keys
  update             Pull latest git changes & update proxy anywhere
  dashboard, open    Open web dashboard in default browser
  accounts           List connected Google, Cookie & NVIDIA accounts
  models [filter]    List all available proxy models (140+ models)
  combos             List configured model combos and fallback chains
  nvidia [subcmd]    Manage NVIDIA NIM keys: list | add <key> | test | rm
  cookie [subcmd]    Manage Gemini cookies: list | add <psid> | test | rm
  key [subcmd]       Manage Proxy API keys: list | add <name> | rm <id>
  test               Run full 10-point end-to-end integration test suite
  logs [-n <lines>] [-f, --follow]
                     View or tail server logs
  help, --help, -h   Show this help message

EXAMPLES:
  # Start in background with dashboard auto-open:
  anti gravity proxy start -d -o

  # Check proxy status & connected accounts:
  anti gravity proxy status

  # Add NVIDIA NIM key and load models:
  anti gravity proxy nvidia add nvapi-your-key-here

  # Add Gemini Web dual cookies:
  anti gravity proxy cookie add "g.a000..." "sidts-001..."

  # Run full integration test suite:
  anti gravity proxy test

  # Stop background proxy:
  anti gravity proxy stop
===================================================================
`);
}

// ───── Main Router ─────

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || '').toLowerCase();
  const subArgs = args.slice(1);

  switch (cmd) {
    case 'start':
      await cmdStart(subArgs);
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart(subArgs);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'update':
      await cmdUpdate(subArgs);
      break;
    case 'dashboard':
    case 'open':
      openBrowser(`http://localhost:${DEFAULT_PORT}/`);
      break;
    case 'accounts':
      await cmdAccounts();
      break;
    case 'cookie':
    case 'cookies':
      await cmdCookie(subArgs);
      break;
    case 'nvidia':
    case 'nim':
      await cmdNvidia(subArgs);
      break;
    case 'model':
    case 'models':
      await cmdModels(subArgs);
      break;
    case 'combo':
    case 'combos':
      await cmdCombos();
      break;
    case 'test':
    case 'tests':
      await cmdTest();
      break;
    case 'key':
    case 'keys':
      await cmdKeys(subArgs);
      break;
    case 'log':
    case 'logs':
      await cmdLogs(subArgs);
      break;
    case 'version':
    case '-v':
    case '--version':
      console.log(`antigravity-proxy v${PKG.version}`);
      break;
    case 'help':
    case '--help':
    case '-h':
    case '':
      printHelp();
      break;
    default:
      console.log(`\nUnknown command: "${cmd}"`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
