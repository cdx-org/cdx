import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadPromptTemplate, renderPromptTemplate } from './prompt-templates.js';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractJsonCandidate(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number.parseInt(max, 10) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

function cliOverrideValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function buildCliOverrides(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const entries = Object.entries(config).filter(([key]) => typeof key === 'string' && key.trim());
  const args = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    args.push('-c', `${key}=${cliOverrideValue(value)}`);
  }
  return args;
}

const JUDGE_PROMPT_TEMPLATE = loadPromptTemplate(
  'judge',
  `You are the Supervisor Judge for parallel Codex workers.
Your job: decide the best option and provide concrete next steps for the worker.

Global goal:
{{goal}}

Question:
{{question}}

Options:
{{options}}

Constraints:
{{constraints}}

Desired output:
{{desired}}

Recent worker context (raw, may be partial):
--- recent_text_begin ---
{{recentText}}
--- recent_text_end ---

Recent events (most recent last):
{{recentEvents}}

Return ONLY valid JSON matching the provided output schema.
Make the decision decisive. Keep message_for_agent actionable and short.`,
);

function buildJudgePrompt({ ask, context, goal }) {
  const question = typeof ask?.question === 'string' ? ask.question.trim() : '';
  const desired = typeof ask?.desired_output === 'string' ? ask.desired_output.trim() : '';
  const constraints = Array.isArray(ask?.constraints) ? ask.constraints.filter(Boolean) : [];
  const options = Array.isArray(ask?.options) ? ask.options : [];

  const formattedOptions = options.length
    ? options
        .map(opt => {
          const id = typeof opt?.id === 'string' ? opt.id : 'unknown';
          const summary = typeof opt?.summary === 'string' ? opt.summary : '';
          return `- ${id}: ${summary}`.trim();
        })
        .join('\n')
    : '(none provided)';

  const formattedConstraints = constraints.length ? `- ${constraints.join('\n- ')}` : '(none)';

  const recentText =
    typeof context?.recentText === 'string' && context.recentText.trim()
      ? context.recentText.slice(-12_000)
      : '';

  const recentEvents = Array.isArray(context?.recentEvents) ? context.recentEvents.slice(-80) : [];

  return renderPromptTemplate(JUDGE_PROMPT_TEMPLATE, {
    goal: goal ?? '(unknown)',
    question: question || '(missing question)',
    options: formattedOptions,
    constraints: formattedConstraints,
    desired: desired || '(not specified)',
    recentText: recentText || '(no recent text)',
    recentEvents: JSON.stringify(recentEvents, null, 2),
  });
}

export class JudgeService {
  constructor({
    log = () => {},
    maxConcurrency = 2,
    timeoutMs = 60_000,
    codexBin = process.env.CDX_JUDGE_CODEX_BIN ?? 'codex',
    model = null,
    effort = null,
    config = null,
  } = {}) {
    this.log = log;
    this.timeoutMs = Math.max(5_000, Number.parseInt(timeoutMs, 10) || 60_000);
    this.codexBin = codexBin;
    this.model = typeof model === 'string' && model.trim() ? model.trim() : null;
    this.effort = typeof effort === 'string' && effort.trim() ? effort.trim() : null;
    this.config = config && typeof config === 'object' && !Array.isArray(config) ? config : null;
    this.semaphore = new Semaphore(maxConcurrency);
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    this.schemaPath = path.join(moduleDir, 'judge-output-schema.json');
  }

  async judge({ askId, ask, context, goal, cwd }) {
    await this.semaphore.acquire();
    try {
      return await this.#runJudge({ askId, ask, context, goal, cwd });
    } finally {
      this.semaphore.release();
    }
  }

  async #runJudge({ askId, ask, context, goal, cwd }) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-judge-'));
    const outputPath = path.join(tempRoot, 'last-message.json');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      '-c',
      'mcp_servers={}',
      '-c',
      'disable_response_storage=true',
      ...buildCliOverrides(this.config),
      '--output-schema',
      this.schemaPath,
      '--output-last-message',
      outputPath,
    ];
    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.effort) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(this.effort)}`);
    }
    if (cwd) {
      args.push('--cd', cwd);
    }

    const prompt = buildJudgePrompt({ ask, context, goal });
    const start = Date.now();
    this.log(`[judge ${askId}] spawn: ${this.codexBin} ${args.join(' ')}`);

    const child = spawn(this.codexBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.end(`${prompt}\n`);

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += String(chunk ?? '');
    });

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, this.timeoutMs);
    if (timeout.unref) timeout.unref();

    const code = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(timeout);

    const elapsedMs = Date.now() - start;
    this.log(`[judge ${askId}] done: exit=${code} elapsedMs=${elapsedMs}`);

    try {
      const raw = await import('node:fs/promises').then(fs => fs.readFile(outputPath, 'utf8'));
      const candidate = extractJsonCandidate(raw) ?? raw.trim();
      const parsed = JSON.parse(candidate);
      if (!isObject(parsed) || typeof parsed.message_for_agent !== 'string' || !isObject(parsed.decision)) {
        throw new Error('Judge output missing required fields');
      }
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'judge_parse_failed');
      const tail = stderr.trim().slice(-2000);
      return {
        decision: {
          option_id: 'UNKNOWN',
          rationale: `Judge failed: ${message}`,
          next_steps: [
            'Re-state options with explicit pros/cons and constraints.',
            'Call router.ask again with structured options.',
          ],
          risks: tail ? [`stderr: ${tail}`] : [],
          confidence: 0.0,
        },
        message_for_agent:
          'I could not produce a reliable decision. Please re-issue router.ask with clear option ids and summaries.',
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
