/**
 * Run the engine and the UI together.
 *
 * This exists because `a & b` is not portable: on Windows npm runs scripts
 * through cmd.exe, where `&` is a sequential separator rather than "background
 * this". The engine never exits, so the UI half would simply never start.
 *
 * Deliberately dependency-free — the alternative is pulling in a process runner
 * for a twenty-line job.
 */
import { spawn } from 'node:child_process';

const TARGETS = [
  { name: 'engine', workspace: '@consensus/engine' },
  { name: 'ui', workspace: '@consensus/ui' },
];

const children = [];
let shuttingDown = false;

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const { name, workspace } of TARGETS) {
  // On Windows `npm` is a .cmd shim, which Node refuses to spawn without a
  // shell (EINVAL, since the CVE-2024-27980 fix). Pass one composed string
  // rather than an argv array so it does not also trip the unescaped-argument
  // deprecation warning — safe here because the workspace names are constants
  // in this file, never user input.
  const child =
    process.platform === 'win32'
      ? spawn(`npm run dev --workspace ${workspace}`, { stdio: 'inherit', shell: true })
      : spawn('npm', ['run', 'dev', '--workspace', workspace], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
    stopAll();
    process.exitCode = 1;
  });

  // If either half dies the other is useless on its own, so take both down
  // rather than leaving a half-running stack behind.
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${name}] exited (${signal ?? code}); stopping the other process too`);
      process.exitCode = code ?? 1;
    }
    stopAll();
  });

  children.push(child);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(signal));
}
