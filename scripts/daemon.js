#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-claude-code');
const PID_FILE = join(DATA_DIR, 'daemon.pid');
const LOG_DIR = join(DATA_DIR, 'logs');
const MAIN_JS = join(__dirname, '..', 'dist', 'main.js');

function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function start() {
  ensureDirs();

  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Daemon already running (PID: ${existingPid})`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const outLog = join(LOG_DIR, `daemon-${today}.log`);

  const out = openSync(outLog, 'a');
  const err = openSync(outLog, 'a');

  const child = spawn(process.execPath, [MAIN_JS, 'start'], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: DATA_DIR,
  });

  writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  console.log(`Daemon started (PID: ${child.pid})`);
  console.log(`Log: ${outLog}`);
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log('No PID file found, daemon is not running.');
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log(`Process ${pid} is not running, cleaning up PID file.`);
    try { unlinkSync(PID_FILE); } catch {}
    return;
  }

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    console.log(`Daemon stopped (PID: ${pid})`);
  } catch (e) {
    console.error(`Failed to stop daemon (PID: ${pid}):`, e.message);
  }

  try { unlinkSync(PID_FILE); } catch {}
}

function status() {
  const pid = readPid();
  if (!pid) {
    console.log('Daemon is not running (no PID file).');
    return;
  }

  if (isProcessRunning(pid)) {
    console.log(`Daemon is running (PID: ${pid})`);
  } else {
    console.log(`Daemon is not running (stale PID: ${pid})`);
    try { unlinkSync(PID_FILE); } catch {}
  }
}

function logs(lines = 50) {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(LOG_DIR, `daemon-${today}.log`);

  if (!existsSync(logFile)) {
    console.log('No log file found for today.');
    return;
  }

  const content = readFileSync(logFile, 'utf8');
  const allLines = content.split('\n');
  const tail = allLines.slice(-lines).join('\n');
  console.log(tail);
}

const command = process.argv[2];

switch (command) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'restart':
    stop();
    setTimeout(() => start(), 1000);
    break;
  case 'status':
    status();
    break;
  case 'logs':
    logs(parseInt(process.argv[3], 10) || 50);
    break;
  default:
    console.log('Usage: node scripts/daemon.js <start|stop|restart|status|logs> [lines]');
    break;
}
