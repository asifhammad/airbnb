import { spawn } from 'node:child_process';

function startProcess(name, entry) {
  const child = spawn(process.execPath, [entry], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (buf) => {
    process.stdout.write(`[${name}] ${buf}`);
  });

  child.stderr.on('data', (buf) => {
    process.stderr.write(`[${name}] ${buf}`);
  });

  child.on('error', (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
  });

  return child;
}

const api = startProcess('api', 'src/index.js');
const worker = startProcess('worker', 'src/workers/scraper-worker.js');

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping api + worker...`);

  const timeout = setTimeout(() => {
    if (!api.killed) api.kill('SIGKILL');
    if (!worker.killed) worker.kill('SIGKILL');
    process.exit(1);
  }, 10_000);

  let exits = 0;
  const onExit = () => {
    exits += 1;
    if (exits >= 2) {
      clearTimeout(timeout);
      process.exit(0);
    }
  };

  api.once('exit', onExit);
  worker.once('exit', onExit);

  if (!api.killed) api.kill('SIGTERM');
  if (!worker.killed) worker.kill('SIGTERM');
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

api.on('exit', (code, signal) => {
  if (shuttingDown) return;
  console.error(`[api] exited unexpectedly (code=${code}, signal=${signal})`);
  shutdown('api_exit');
});

worker.on('exit', (code, signal) => {
  if (shuttingDown) return;
  console.error(`[worker] exited unexpectedly (code=${code}, signal=${signal})`);
  shutdown('worker_exit');
});

