import process from 'node:process';

export function attachDrain(
  child,
  { name = 'process', enabled = false, stdout = true } = {},
) {
  if (!enabled) return;

  if (child.stdout && stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      process.stderr.write(`[${name}] ${chunk}`);
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      process.stderr.write(`[${name}-err] ${chunk}`);
    });
  }
}

export async function stopChild(child, { signal = 'SIGTERM', timeoutMs = 5000 } = {}) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const waitForExit = timeout =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeout);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });

  try {
    child.kill(signal);
  } catch {
    return;
  }

  try {
    await waitForExit(timeoutMs);
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
    await waitForExit(1000).catch(() => {});
  }
}
