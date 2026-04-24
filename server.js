const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';

let cookiesLoaded = false;

function initCookies() {
  if (!process.env.COOKIES_DATA) {
    console.log('[INIT] No COOKIES_DATA env var set');
    return;
  }
  try {
    let raw = process.env.COOKIES_DATA;
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (decoded.includes('# Netscape HTTP Cookie File')) {
        raw = decoded;
        console.log('[INIT] Cookies decoded from base64');
      }
    } catch {}

    raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    fs.writeFileSync(COOKIES_PATH, raw, { mode: 0o600 });
    const stats = fs.statSync(COOKIES_PATH);
    const content = fs.readFileSync(COOKIES_PATH, 'utf8');

    if (!content.includes('# Netscape HTTP Cookie File')) {
      console.warn('[INIT] Cookie file missing Netscape header — cookies disabled');
      cookiesLoaded = false;
      return;
    }

    cookiesLoaded = stats.size > 500;
    console.log('[INIT] Cookies loaded:', cookiesLoaded ? `yes (${stats.size} bytes)` : 'no (too small)');
  } catch (err) {
    console.error('[INIT] Cookie error:', err.message);
    cookiesLoaded = false;
  }
}

initCookies();

app.use(express.json());
app.use(express.static('public'));

function getYtDlpArgs(baseArgs) {
  if (cookiesLoaded) {
    return [...baseArgs, '--cookies', COOKIES_PATH, '--no-playlist', '--no-warnings'];
  }
  return [...baseArgs, '--no-playlist', '--no-warnings'];
}

const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS = 10;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts) {
    if (now - data.resetTime > RATE_LIMIT_WINDOW) {
      requestCounts.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

function checkRateLimit(ip) {
  const now = Date.now();
  let record = requestCounts.get(ip);
  if (!record || now - record.resetTime > RATE_LIMIT_WINDOW) {
    requestCounts.set(ip, { count: 1, resetTime: now });
    return true;
  }
  if (record.count >= MAX_REQUESTS) return false;
  record.count++;
  return true;
}

function sanitizeUrl(url) {
  return /^https?:\/\/(www\.)?youtube\.com\/watch\?v=|^https?:\/\/(www\.)?youtube\.com\/shorts\/|^https?:\/\/youtu\.be\//.test(url);
}

function execYtDlp(args, timeout = 120000) {
  const ytArgs = getYtDlpArgs(args);
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false, killed = false;
    
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      proc.kill('SIGKILL');
      reject({ type: 'TIMEOUT', message: 'Process timed out' });
    }, timeout);
    
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    
    proc.on('close', code => {
      clearTimeout(timer);
      if (timedOut || killed) return;
      if (code === 0) resolve(stdout);
      else {
        const err = stderr.trim();
        if (err.includes('Sign in') || err.includes('bot') || err.includes('403') || err.includes('blocked')) {
          const msg = cookiesLoaded ? 'Refresh cookies needed' : 'Cookies required';
          reject({ type: 'BOT', message: msg });
        } else if (err.includes('format')) {
          reject({ type: 'FORMAT', message: 'Format not available' });
        } else if (err.includes('network') || err.includes('Connection')) {
          reject({ type: 'NETWORK', message: 'Network error' });
        } else {
          reject({ type: 'OTHER', message: err || `Code ${code}` });
        }
      }
    });
    
    proc.on('error', err => {
      clearTimeout(timer);
      reject({ type: 'NETWORK', message: err.message });
    });
  });
}

app.post('/api/info', async (req, res) => {
  if (!checkRateLimit(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  const { url, format } = req.body;
  if (!url || !sanitizeUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  
  try {
    const out = await execYtDlp(['--dump-single-json', '--no-download', '--geo-bypass', url]);
    const info = JSON.parse(out.trim());
    
    let formats = [];
    if (format === 'mp4') {
      const vids = (info.formats || []).filter(f =>
        (f.ext === 'mp4' || f.video_ext === 'mp4') &&
        f.height &&
        f.vcodec &&
        f.vcodec !== 'none'
      );
      const heights = [...new Set(vids.map(f => f.height))].sort((a, b) => b - a);
      console.log('[INFO] Heights:', heights.join(', '));
      formats = heights.slice(0, 6).map(h => {
        const f = vids.find(x => x.height === h);
        return {
          formatId: f.format_id,
          quality: `${h}p`,
          ext: 'mp4',
          filesize: f.filesize || f.filesize_approx || null,
          height: h,
          needsMerge: !f.acodec || f.acodec === 'none'
        };
      });
    } else if (format === 'mp3' || format === 'wav') {
      formats = [
        { formatId: '320', quality: '320 kbps', ext: format },
        { formatId: '128', quality: '128 kbps', ext: format },
        { formatId: '64', quality: '64 kbps', ext: format }
      ];
    }
    
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      uploader: info.uploader || info.channel || 'Unknown',
      duration: info.duration,
      formats
    });
  } catch (e) {
    console.error('[INFO] Error:', e.message);
    res.status(500).json({ error: e.type === 'BOT' ? e.message : 'Failed to fetch video info' });
  }
});

function buildMp4Attempts(url, out, formatId) {
  return [
    ['-f', `${formatId}+bestaudio/best[ext=mp4]/best`, '--merge-output-format', 'mp4', '--prefer-ffmpeg', '-o', out, '--geo-bypass', url],
    ['-f', 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]', '--merge-output-format', 'mp4', '--prefer-ffmpeg', '-o', out, '--geo-bypass', url],
    ['-f', 'best[ext=mp4]/best', '--prefer-ffmpeg', '-o', out, '--geo-bypass', url],
    ['-f', 'best', '--prefer-ffmpeg', '-o', out, '--geo-bypass', url],
  ];
}

function buildAudioAttempts(url, out, fmt, qual) {
  return [
    ['-x', '--audio-format', fmt, '--audio-quality', qual, '--prefer-ffmpeg', '-o', out, '--geo-bypass', url],
    ['-x', '--audio-format', fmt, '--audio-quality', '0', '--prefer-ffmpeg', '-o', out, '--geo-bypass', url],
    ['-f', 'bestaudio', '--prefer-ffmpeg', '-o', out.replace('%(ext)s', 'm4a'), '--geo-bypass', url]
  ];
}

app.post('/api/download', async (req, res) => {
  if (!checkRateLimit(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  const { url, formatId, ext } = req.body;
  if (!url || !formatId || !sanitizeUrl(url)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  
  const tmp = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const out = path.join(tmp, `v2x_${id}.%(ext)s`);
  
  let finalExt = ext || 'mp4';
  let finalPath;
  let lastError;
  
  async function download(attempts) {
    for (let i = 0; i < attempts.length; i++) {
      console.log('[DL] Attempt', i + 1, attempts[i].slice(0, 3).join(' '));
      try {
        await execYtDlp(attempts[i], 300000);

        const expectedPath = path.join(tmp, `v2x_${id}.${finalExt}`);
        let resolved = false;
        for (let w = 0; w < 10; w++) {
          await new Promise(r => setTimeout(r, 300));
          if (fs.existsSync(expectedPath) && fs.statSync(expectedPath).size > 0) {
            finalPath = expectedPath;
            resolved = true;
            break;
          }
          const files = fs.readdirSync(tmp).filter(f => f.startsWith(`v2x_${id}`));
          if (files.length) {
            const candidate = path.join(tmp, files[0]);
            if (fs.statSync(candidate).size > 0) {
              finalPath = candidate;
              finalExt = files[0].match(/\.(\w+)$/)?.[1] || finalExt;
              resolved = true;
              break;
            }
          }
        }
        if (resolved) break;
      } catch (e) {
        lastError = e;
        console.log('[DL] Failed:', e.type, e.message);
        if (e.type === 'BOT' || e.type === 'FFMPEG') throw e;
      }
    }
    if (!finalPath) throw lastError || new Error('Download failed');
  }
  
  try {
    if (ext === 'mp3' || ext === 'wav') {
      const qual = formatId === '320' ? '0' : formatId === '128' ? '5' : '9';
      await download(buildAudioAttempts(url, out, ext, qual));
      finalExt = ext;
    } else {
      await download(buildMp4Attempts(url, out, formatId));
    }
    
    const stat = fs.statSync(finalPath);
    console.log('[DL] Success:', path.basename(finalPath), `(${stat.size} bytes)`);
    
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(finalPath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    const stream = fs.createReadStream(finalPath);
    stream.on('error', e => console.error('[DL] Stream error:', e.message));
    res.on('close', () => { try { fs.unlinkSync(finalPath); } catch {} });
    stream.pipe(res);
  } catch (e) {
    console.error('[DL] Error:', e.message);

    try {
      const leftover = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`v2x_${id}`));
      for (const f of leftover) {
        fs.unlinkSync(path.join(os.tmpdir(), f));
      }
    } catch {}

    res.status(500).json({ error: e.type === 'BOT' ? e.message : 'Download failed' });
  }
});

app.use((err, req, res, next) => {
  console.error('[SERVER] Error:', err);
  res.status(500).json({ error: 'Server error' });
});

process.on('SIGTERM', () => process.exit(0));

app.listen(PORT, () => console.log(`[SERVER] Port ${PORT}`));