import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const children = [];
let stopping = false;

function start(label, args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('exit', code => {
    if (stopping) return;
    if (code && code !== 0) {
      console.error(`${label} exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250).unref();
}

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
console.log(`Arb Radar v${packageVersion} dev — PAPER ONLY`);
console.log('Starting paper radar watch + local dashboard…');
start('radar', ['dist/index.js', '--watch']);
start('dashboard', ['dist/dashboard/server.js']);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
