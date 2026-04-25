import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

async function runGit(cwd, args) {
  const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit=${code})\n${stderr}`);
  }
  return stdout.trim();
}

test('commitAll stages checklist artifacts outside sparse-checkout roots', async t => {
  const fixture = await createRuntimeFixture(t);
  const { commitAll } = await fixture.importRuntime('git-worktree.js');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mcp-cdx-git-worktree-'));

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const repoRoot = path.join(tempRoot, 'repo');
  await mkdir(path.join(repoRoot, 'app'), { recursive: true });
  await writeFile(path.join(repoRoot, 'app', 'main.txt'), 'hello\n', 'utf8');

  await runGit(repoRoot, ['init']);
  await runGit(repoRoot, ['config', 'user.name', 'stub']);
  await runGit(repoRoot, ['config', 'user.email', 'stub@example.com']);
  await runGit(repoRoot, ['add', '-A']);
  await runGit(repoRoot, ['commit', '-m', 'init']);

  await runGit(repoRoot, ['sparse-checkout', 'init', '--cone']);
  await runGit(repoRoot, ['sparse-checkout', 'set', 'app', 'docs']);

  const artifactPath = path.join(
    repoRoot,
    '.keepdoing',
    'target-a',
    'collect-evidence',
    'cycle-001.md',
  );
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, '# artifact\n', 'utf8');

  const committed = await commitAll({ cwd: repoRoot, message: 'artifact commit' });
  assert.equal(committed, true);

  const changedFiles = await runGit(repoRoot, ['show', '--name-only', '--pretty=format:', 'HEAD']);
  assert.match(changedFiles, /\.keepdoing\/target-a\/collect-evidence\/cycle-001\.md/);
});
