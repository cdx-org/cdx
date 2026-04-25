import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function execGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return String(stdout ?? '').trim();
}

export async function createScratchRepo(repoRoot) {
  await mkdir(repoRoot, { recursive: true });
  await execGit(repoRoot, ['init']);
  await execGit(repoRoot, ['config', 'user.name', 'stub']);
  await execGit(repoRoot, ['config', 'user.email', 'stub@example.com']);
  await writeFile(path.join(repoRoot, 'README.md'), 'hello\n', 'utf8');
  await execGit(repoRoot, ['add', '-A']);
  await execGit(repoRoot, ['commit', '-m', 'init']);
}
