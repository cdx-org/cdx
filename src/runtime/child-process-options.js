import process from 'node:process';

export function hiddenSpawnOptions(options = {}, { platform = process.platform } = {}) {
  const next = { ...(options ?? {}) };
  if (platform === 'win32' && next.windowsHide === undefined) {
    next.windowsHide = true;
  }
  return next;
}
