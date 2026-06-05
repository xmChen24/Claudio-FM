const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'deepseek';
const CODEX_COMMAND = process.env.CODEX_CLI_COMMAND || 'codex';
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_PROFILE = process.env.CODEX_PROFILE || '';
const CODEX_CONFIG_ARGS = splitCliArgs(process.env.CODEX_CLI_CONFIG_ARGS || '');
const CODEX_IGNORE_RULES = envFlag('CODEX_IGNORE_RULES', true);
const CODEX_SCHEMA_PATH = process.env.CODEX_OUTPUT_SCHEMA || path.join(__dirname, 'schemas', 'llm-response.schema.json');
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || '';
const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || '';
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_REASONING_EFFORT = process.env.GEMINI_REASONING_EFFORT || '';
const DEFAULT_RETRIES = Math.max(0, Number(process.env.LLM_RETRIES || 2));
const DEFAULT_RETRY_DELAY_MS = Math.max(0, Number(process.env.LLM_RETRY_DELAY_MS || 1200));

async function generateJson(prompt, options = {}) {
  const providers = providerChain(options.provider || DEFAULT_PROVIDER);
  const failures = [];

  for (const provider of providers) {
    try {
      return await callProviderWithRetry(provider, prompt, options);
    } catch (err) {
      failures.push(`${provider}: ${err.message}`);
      console.warn(`[LLM] provider ${provider} failed: ${err.message}`);
    }
  }

  throw new Error(`All LLM providers failed: ${failures.join(' | ')}`);
}

function providerChain(primary) {
  const configuredFallbacks = splitProviderList(process.env.LLM_FALLBACK_PROVIDERS);
  return [...new Set([primary, ...configuredFallbacks].filter(Boolean))];
}

function splitProviderList(value) {
  return String(value || '')
    .split(',')
    .map(provider => provider.trim())
    .filter(Boolean);
}

function splitCliArgs(value) {
  const input = String(value || '').trim();
  if (!input) return [];
  const args = [];
  let current = '';
  let quote = '';
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
}

function normalizeCliArgs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return splitCliArgs(value);
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

async function callProviderWithRetry(provider, prompt, options = {}) {
  const maxAttempts = Math.max(1, Number(options.retries ?? DEFAULT_RETRIES) + 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callProvider(provider, prompt, options);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableError(err)) break;
      const delayMs = DEFAULT_RETRY_DELAY_MS * attempt;
      console.warn(`[LLM:${provider}] retry ${attempt}/${maxAttempts - 1} after ${err.message}`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function callProvider(provider, prompt, options = {}) {
  if (provider === 'deepseek') return callDeepSeek(prompt, options);
  if (provider === 'gemini') return callGemini(prompt, options);
  if (provider === 'claude_cli') return callClaudeCli(prompt, options);
  if (provider === 'codex_cli') return callCodexCli(prompt, options);
  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

function isRetryableError(err) {
  const message = String(err?.message || '');
  return /\b(429|500|502|503|504)\b|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callDeepSeek(prompt, options = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not set');
  }

  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    baseURL: process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  const model = options.model || process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:deepseek] 调用中，model ${model}，prompt ${prompt.length} 字符…`);

  const request = {
    model,
    messages: [
      { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
  };
  if (DEEPSEEK_THINKING) request.thinking = { type: DEEPSEEK_THINKING };
  if (DEEPSEEK_REASONING_EFFORT) request.reasoning_effort = DEEPSEEK_REASONING_EFFORT;

  const completion = await withTimeout(
    client.chat.completions.create(request),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `DeepSeek request timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const parsed = parseResponse(raw);
  logParsedResponse('deepseek', elapsed, parsed, raw);
  return parsed;
}

async function callGemini(prompt, options = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set');
  }

  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    baseURL: process.env.GEMINI_BASE_URL || GEMINI_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY,
  });
  const model = options.model || process.env.GEMINI_MODEL || GEMINI_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:gemini] 调用中，model ${model}，prompt ${prompt.length} 字符…`);

  const request = {
    model,
    messages: [
      { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
  };
  if (GEMINI_REASONING_EFFORT) request.reasoning_effort = GEMINI_REASONING_EFFORT;

  const completion = await withTimeout(
    client.chat.completions.create(request),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `Gemini request timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const parsed = parseResponse(raw);
  logParsedResponse('gemini', elapsed, parsed, raw);
  return parsed;
}

async function loadOpenAI() {
  try {
    const mod = await import('openai');
    return mod.default || mod.OpenAI || mod;
  } catch (err) {
    throw new Error('OpenAI SDK not installed. Run `yarn add openai` or `npm install openai`.');
  }
}

function callClaudeCli(prompt, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startAt = Date.now();
  console.log(`[LLM:claude_cli] 调用中，prompt ${prompt.length} 字符…`);
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      const stderrPreview = stderr.trim().slice(-800);
      console.error(`[LLM:claude_cli] 超时（${Math.round(timeoutMs / 1000)}s），已终止；prompt ${prompt.length} 字符`);
      if (stderrPreview) console.error(`[LLM:claude_cli] stderr 摘要: ${stderrPreview}`);
      reject(new Error('Claude subprocess timed out'));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      stderr += d.toString();
    });

    proc.on('close', () => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      const raw = stdout.trim();
      const parsed = parseResponse(raw);
      logParsedResponse('claude_cli', elapsed, parsed, raw);
      if (!raw) console.warn('[LLM:claude_cli] 警告：返回内容为空');
      resolve(parsed);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      console.error('[LLM:claude_cli] 进程错误:', err.message);
      reject(err);
    });
  });
}

function callCodexCli(prompt, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startAt = Date.now();
  const outputPath = path.join(os.tmpdir(), `claudio-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = buildCodexArgs(outputPath, options);

  console.log(`[LLM:codex_cli] 调用中，prompt ${prompt.length} 字符，timeout ${Math.round(timeoutMs / 1000)}s，model ${codexModelForOptions(options) || 'default'}…`);
  return new Promise((resolve, reject) => {
    const proc = spawn(CODEX_COMMAND, args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(outputPath); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => {
      proc.kill();
      const stderrPreview = stderr.trim().slice(-800);
      console.error(`[LLM:codex_cli] 超时（${Math.round(timeoutMs / 1000)}s），已终止；prompt ${prompt.length} 字符`);
      if (stderrPreview) console.error(`[LLM:codex_cli] stderr 摘要: ${stderrPreview}`);
      finish(reject, new Error(`Codex subprocess timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      stderr += d.toString();
    });
    proc.stdin.on('error', err => {
      if (err.code !== 'EPIPE') console.error('[LLM:codex_cli] stdin error:', err.message);
    });
    proc.stdin.end([
      'Return only JSON that matches the provided output schema.',
      'Do not modify files, run commands, or ask follow-up questions.',
      prompt,
    ].join('\n\n'));

    proc.on('close', code => {
      if (settled) return;
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      let raw = '';
      try {
        raw = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '';
      } catch (err) {
        finish(reject, new Error(`Codex output read failed: ${err.message}`));
        return;
      }
      if (!raw) raw = stdout.trim();
      if (code !== 0 && !raw) {
        const stderrPreview = stderr.trim().slice(-1200);
        finish(reject, new Error(`Codex subprocess exited ${code}${stderrPreview ? `: ${stderrPreview}` : ''}`));
        return;
      }
      const parsed = parseResponse(raw);
      logParsedResponse('codex_cli', elapsed, parsed, raw);
      if (!raw) console.warn('[LLM:codex_cli] 警告：返回内容为空');
      finish(resolve, parsed);
    });

    proc.on('error', err => {
      console.error('[LLM:codex_cli] 进程错误:', err.message);
      finish(reject, err);
    });
  });
}

function codexModelForOptions(options = {}) {
  return options.codexModel || options.model || CODEX_MODEL;
}

function buildCodexArgs(outputPath, options = {}) {
  const model = codexModelForOptions(options);
  const profile = options.codexProfile || CODEX_PROFILE;
  const configArgs = [
    ...CODEX_CONFIG_ARGS,
    ...normalizeCliArgs(options.codexConfigArgs),
  ];
  const args = ['exec'];
  if (model) args.push('-m', model);
  if (profile) args.push('-p', profile);
  if (options.codexIgnoreRules ?? CODEX_IGNORE_RULES) args.push('--ignore-rules');
  args.push(
    ...configArgs,
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--output-schema',
    CODEX_SCHEMA_PATH,
    '-o',
    outputPath,
    '-',
  );
  return args;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title || '',
        say: parsed.say || '',
        play: Array.isArray(parsed.play) ? parsed.play : [],
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        intros: Array.isArray(parsed.intros) ? parsed.intros : [],
        reason: parsed.reason || '',
        mode: parsed.mode || '',
      };
    } catch {}
  }
  return { title: '', say: raw || 'Okay.', play: [], segments: [], intros: [], reason: '', segue: '', mode: '' };
}

function logParsedResponse(provider, elapsed, parsed, raw) {
  const firstSegment = parsed.segments?.find(s => s?.text)?.text || parsed.say || '';
  const preview = firstSegment.slice(0, 60);
  console.log(`[LLM:${provider}] 响应 (${elapsed}s) → 「${parsed.title || '无标题'}」| ${parsed.play?.length || 0} 首 | segments: ${parsed.segments?.length || 0} | "${preview}${preview.length >= 60 ? '…' : ''}"`);
  if (!raw) console.warn(`[LLM:${provider}] 警告：返回内容为空`);
}

module.exports = {
  generateJson,
  parseResponse,
  _test: {
    providerChain,
    splitProviderList,
    splitCliArgs,
    buildCodexArgs,
  },
};
