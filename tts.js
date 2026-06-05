const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const CACHE_DIR = path.join(__dirname, 'cache/tts');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const VOLCENGINE_DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function audioFormatForProvider(provider, options = {}) {
  if (provider === 'kokoro') return options.format || process.env.KOKORO_RESPONSE_FORMAT || 'wav';
  if (provider === 'cosyvoice') return options.format || process.env.COSYVOICE_RESPONSE_FORMAT || 'wav';
  return options.format || process.env.VOLCENGINE_TTS_FORMAT || 'mp3';
}

function ttsVolumeGain(provider, options = {}) {
  const explicit = Number(options.volumeGain);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (options.role === 'caller') {
    const callerGain = Number(process.env.CALLER_TTS_VOLUME_GAIN || 1);
    return Number.isFinite(callerGain) && callerGain > 0 ? callerGain : 1;
  }
  const gain = Number(process.env.DJ_TTS_VOLUME_GAIN || process.env.TTS_VOLUME_GAIN || 1.3);
  return Number.isFinite(gain) && gain > 0 ? gain : 1;
}

function cachePath(text, provider = process.env.TTS_PROVIDER || 'volcengine', options = {}) {
  const voice = getVoiceForProvider(provider, options);
  const role = options.role || 'station';
  const format = audioFormatForProvider(provider, options).replace(/[^a-z0-9]/gi, '') || 'mp3';
  const gain = format === 'wav' ? ttsVolumeGain(provider, options) : 1;
  const gainKey = gain === 1 ? '' : `:wavgain=v2:${gain.toFixed(3)}`;
  return path.join(CACHE_DIR, `${md5(`${role}:${provider}:${voice}:${format}${gainKey}:${text}`)}.${format}`);
}

function synthesize(text, options = {}) {
  const provider = options.provider || process.env.TTS_PROVIDER || 'volcengine';
  const cached = cachePath(text, provider, options);
  if (fs.existsSync(cached)) {
    console.log(`[TTS] 缓存命中 → ${path.basename(cached)}`);
    return Promise.resolve(cached);
  }

  const preview = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  console.log(`[TTS] 合成中 (${provider}${options.role ? `/${options.role}` : ''})："${preview}"`);
  const startAt = Date.now();

  let promise;
  if (provider === 'volcengine') {
    promise = synthesizeVolcengine(text, cached, options);
  } else if (provider === 'fish') {
    promise = synthesizeFish(text, cached, options);
  } else if (provider === 'cosyvoice') {
    promise = synthesizeCosyVoice(text, cached, options);
  } else {
    promise = synthesizeKokoro(text, cached, options);
  }

  return promise.then(p => {
    console.log(`[TTS] 完成 (${((Date.now() - startAt) / 1000).toFixed(1)}s) → ${path.basename(p)}`);
    return p;
  });
}

function cleanupCache({
  maxAgeMs = Number(process.env.TTS_CACHE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000),
  maxFiles = Number(process.env.TTS_CACHE_MAX_FILES || 600),
} = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(CACHE_DIR)
      .filter(name => /^[a-f0-9]{32}\.(mp3|wav)$/i.test(name))
      .map(name => {
        const filePath = path.join(CACHE_DIR, name);
        const stat = fs.statSync(filePath);
        return { name, filePath, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (err) {
    console.warn('[TTS] 缓存扫描失败:', err.message);
    return { removed: 0, kept: 0, bytesRemoved: 0 };
  }

  const now = Date.now();
  let removed = 0;
  let bytesRemoved = 0;
  entries.forEach((entry, index) => {
    const tooOld = maxAgeMs > 0 && now - entry.mtimeMs > maxAgeMs;
    const tooMany = maxFiles > 0 && index >= maxFiles;
    if (!tooOld && !tooMany) return;
    try {
      fs.unlinkSync(entry.filePath);
      removed++;
      bytesRemoved += entry.size;
    } catch (err) {
      console.warn(`[TTS] 删除缓存失败 ${entry.name}:`, err.message);
    }
  });

  const kept = Math.max(0, entries.length - removed);
  if (removed) {
    console.log(`[TTS] 缓存清理 removed=${removed} kept=${kept} bytes=${bytesRemoved}`);
  }
  return { removed, kept, bytesRemoved };
}

async function warmup(options = {}) {
  const enabled = String(options.enabled ?? process.env.TTS_WARMUP_ON_START ?? '1').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'no') return { skipped: true };
  const text = options.text || process.env.TTS_WARMUP_TEXT || 'Claudio is warming the signal.';
  const startAt = Date.now();
  const filePath = await synthesize(text, { role: 'warmup' });
  return {
    skipped: false,
    file: path.basename(filePath),
    elapsedMs: Date.now() - startAt,
  };
}

function getVoiceForProvider(provider, options = {}) {
  if (provider === 'fish') return options.voiceId || process.env.FISH_VOICE_ID || '';
  if (provider === 'volcengine') return options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE || '';
  if (provider === 'cosyvoice') return options.spkId || options.voice || process.env.COSYVOICE_SPK_ID || '';
  return options.voice || process.env.KOKORO_VOICE || '';
}

function wavBufferFromPcm16(buffer, sampleRate = 22050, channels = 1) {
  const dataSize = buffer.length;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, buffer]);
}

function applyWavVolumeGain(buffer, gain = 1) {
  if (!Number.isFinite(gain) || gain <= 0 || Math.abs(gain - 1) < 0.001) return buffer;
  if (buffer.length < 44) return buffer;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return buffer;

  let fmt = null;
  let dataStart = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buffer.length) break;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataStart = chunkStart;
      dataSize = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataStart < 0 || dataSize <= 0) return buffer;

  const out = Buffer.from(buffer);
  const dataEnd = Math.min(out.length, dataStart + dataSize);
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
    for (let i = dataStart; i + 1 < dataEnd; i += 2) {
      const sample = out.readInt16LE(i);
      const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
      out.writeInt16LE(boosted, i);
    }
    return out;
  }

  if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
    for (let i = dataStart; i + 3 < dataEnd; i += 4) {
      const sample = out.readFloatLE(i);
      if (!Number.isFinite(sample)) continue;
      const boosted = Math.max(-1, Math.min(1, sample * gain));
      out.writeFloatLE(boosted, i);
    }
    return out;
  }

  return buffer;
}

function applyTtsVolumeGain(buffer, provider, options = {}) {
  const format = audioFormatForProvider(provider, options).replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (format !== 'wav') return buffer;
  const gain = ttsVolumeGain(provider, options);
  const boosted = applyWavVolumeGain(buffer, gain);
  if (boosted !== buffer) {
    console.log(`[TTS] 音量增益 ${gain.toFixed(2)}x (${options.role || 'station'})`);
  }
  return boosted;
}

function buildVolcenginePayload(text, options = {}) {
  const voiceType = options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE;
  if (!voiceType) {
    throw new Error('VOLCENGINE_TTS_VOICE_TYPE not set');
  }

  return {
    req_params: {
      text,
      speaker: voiceType,
      additions: options.additions || process.env.VOLCENGINE_TTS_ADDITIONS || JSON.stringify({
        disable_markdown_filter: true,
        enable_language_detector: true,
        enable_latex_tn: true,
        disable_default_bit_rate: true,
        max_length_to_filter_parenthesis: 0,
        cache_config: {
          text_type: 1,
          use_cache: true,
        },
      }),
      audio_params: {
        format: options.format || process.env.VOLCENGINE_TTS_FORMAT || 'mp3',
        sample_rate: Number(options.sampleRate || process.env.VOLCENGINE_TTS_SAMPLE_RATE || 24000),
      },
    },
  };
}

function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const rest = depth > 0 && start !== -1 ? text.slice(start) : '';
  return { objects, rest };
}

async function synthesizeVolcengine(text, outPath, options = {}) {
  const apiKey = options.apiKey || process.env.VOLCENGINE_TTS_API_KEY;
  const resourceId = options.resourceId || process.env.VOLCENGINE_TTS_RESOURCE_ID;

  if (!apiKey || !resourceId) {
    throw new Error('VOLCENGINE_TTS_API_KEY or VOLCENGINE_TTS_RESOURCE_ID not set');
  }

  const endpoint = options.endpoint || process.env.VOLCENGINE_TTS_ENDPOINT || VOLCENGINE_DEFAULT_ENDPOINT;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
      'Connection': 'keep-alive',
    },
    body: JSON.stringify(buildVolcenginePayload(text, options)),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Volcengine TTS error ${res.status}: ${err}`);
  }

  const audioChunks = [];
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = extractJsonObjects(buffer);
    buffer = parsed.rest;

    for (const raw of parsed.objects) {
      const msg = JSON.parse(raw);
      if (msg.code && msg.code !== 20000000) {
        throw new Error(`Volcengine TTS response error ${msg.code}: ${msg.message || ''}`);
      }
      if (msg.data) {
        audioChunks.push(Buffer.from(msg.data, 'base64'));
      }
    }
  }

  buffer += decoder.decode();
  const parsed = extractJsonObjects(buffer);
  for (const raw of parsed.objects) {
    const msg = JSON.parse(raw);
    if (msg.code && msg.code !== 20000000) {
      throw new Error(`Volcengine TTS response error ${msg.code}: ${msg.message || ''}`);
    }
    if (msg.data) {
      audioChunks.push(Buffer.from(msg.data, 'base64'));
    }
  }

  if (!audioChunks.length) {
    throw new Error('Volcengine TTS returned no audio data');
  }

  fs.writeFileSync(outPath, Buffer.concat(audioChunks));
  return outPath;
}

function synthesizeFish(text, outPath, options = {}) {
  const apiKey = options.apiKey || process.env.FISH_API_KEY;
  const voiceId = options.voiceId || process.env.FISH_VOICE_ID;

  if (!apiKey || !voiceId) {
    return Promise.reject(new Error('FISH_API_KEY or FISH_VOICE_ID not set'));
  }

  const body = JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'mp3',
    mp3_bitrate: 128,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.fish.audio',
      path: '/v1/tts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => { err += d; });
        res.on('end', () => reject(new Error(`Fish Audio TTS error ${res.statusCode}: ${err}`)));
        return;
      }
      const out = fs.createWriteStream(outPath);
      res.pipe(out);
      out.on('finish', () => resolve(outPath));
      out.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function synthesizeKokoro(text, outPath, options = {}) {
  const baseUrl = (options.baseUrl || process.env.KOKORO_API_BASE || 'http://127.0.0.1:8880').replace(/\/+$/, '');
  const voice = options.voice || process.env.KOKORO_VOICE || 'af_heart';
  const model = options.model || process.env.KOKORO_MODEL || 'kokoro';
  const responseFormat = options.format || process.env.KOKORO_RESPONSE_FORMAT || 'wav';

  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: responseFormat,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Kokoro TTS error ${res.status}: ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, applyTtsVolumeGain(buffer, 'kokoro', options));
  return outPath;
}

async function synthesizeCosyVoice(text, outPath, options = {}) {
  const baseUrl = (options.baseUrl || process.env.COSYVOICE_API_BASE || 'http://127.0.0.1:50000').replace(/\/+$/, '');
  const mode = String(options.mode || process.env.COSYVOICE_MODE || 'sft').trim().toLowerCase();
  const spkId = options.spkId || options.voice || process.env.COSYVOICE_SPK_ID || '中文女';
  const sampleRate = Number(options.sampleRate || process.env.COSYVOICE_SAMPLE_RATE || 22050);
  const endpoint = mode === 'instruct' ? '/inference_instruct' : '/inference_sft';
  const params = new URLSearchParams({
    tts_text: text,
    spk_id: spkId,
  });
  if (mode === 'instruct') {
    params.set('instruct_text', options.instructText || process.env.COSYVOICE_INSTRUCT_TEXT || '');
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`CosyVoice TTS error ${res.status}: ${err}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (!pcm.length) throw new Error('CosyVoice TTS returned no audio data');
  const wav = wavBufferFromPcm16(pcm, sampleRate);
  fs.writeFileSync(outPath, applyTtsVolumeGain(wav, 'cosyvoice', options));
  return outPath;
}

module.exports = { synthesize, cachePath, cleanupCache, warmup };
