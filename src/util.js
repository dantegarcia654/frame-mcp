import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const VERSION = '1.3.0';
export const PORT = Number(process.env.FRAME_PORT || 4747);
export const HOME = process.env.FRAME_HOME || path.join(os.homedir(), '.frame');
export const BASE = `http://127.0.0.1:${PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 8);
export const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const mkdirp = (d) => (fs.mkdirSync(d, { recursive: true }), d);

/** Run a process, collect stdout/stderr. Never rejects on non-zero exit unless `strict`. */
export function run(cmd, args, { strict = true, onStdout, onStderr, binary = false, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    const out = []; let err = '';
    let timer = timeout ? setTimeout(() => p.kill('SIGKILL'), timeout) : null;
    p.stdout.on('data', (d) => { if (onStdout) onStdout(d); else out.push(d); });
    p.stderr.on('data', (d) => { const s = d.toString(); if (onStderr) onStderr(s); err = (err + s).slice(-8000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`${cmd} could not start: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0 && strict) return reject(new Error(`${cmd} exited ${code}: ${err.slice(-1500)}`));
      resolve({ code, stdout: binary ? buf : buf.toString(), stderr: err });
    });
  });
}

export function tc(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
