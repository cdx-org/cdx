import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskOutputTail } from '../../src/runtime/cdx-stats-server.js';

test('buildTaskOutputTail keeps compact task defaults', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    text: `line ${index + 1}`,
  }));

  const tail = buildTaskOutputTail(entries);

  assert.equal(tail.lineCount, 15);
  assert.equal(tail.totalLines, 40);
  assert.equal(tail.truncated, true);
  assert.match(tail.text, /^line 26/);
  assert.match(tail.text, /line 40$/);
});

test('buildTaskOutputTail supports larger scout and planner views', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    text: `line ${index + 1}`,
  }));

  const tail = buildTaskOutputTail(entries, {
    maxLines: 80,
    maxCharsPerLine: 360,
  });

  assert.equal(tail.lineCount, 40);
  assert.equal(tail.totalLines, 40);
  assert.equal(tail.truncated, false);
  assert.match(tail.text, /^line 1/);
  assert.match(tail.text, /line 40$/);
});
