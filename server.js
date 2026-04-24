const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';

function initCookies() {
  if (process.env.COOKIES_DATA) {
    try {
      fs.writeFileSync(COOKIES_PATH, process.env.COOKIES_DATA, { mode: 0o600 });
      console.log('Cookies loaded from environment');
    } catch (err) {
      console.error('Failed to load cookies:', err.message);
    }
  }
}

initCookies();

app.use(express.json());
app.use(express.static('public'));

function cookiesEnabled() {
  return fs.existsSync(COOKIES_PATH);
}

function getYtDlpArgs(baseArgs) {
  if (cookiesEnabled()) {
    return [...baseArgs, '--cookies', COOKIES_PATH];
  }
  return baseArgs;
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
  
  if (record.count >= MAX_REQUESTS) {
    return false;
  }
  
  record.count++;
  return true;
}

function sanitizeUrl(url) {
  const youtubePatterns = [
    /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/,
    /^https?:\/\/(www\.)?youtube\.com\/shorts\/[\w-]+/,
    /^https?:\/\/youtu\.be\/[\w-]+/
  ];
  
  return youtubePatterns.some(pattern => pattern.test(url));
}

function execYtDlp(args, timeout = 120000) {
  const ytArgs = getYtDlpArgs(args);
  
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ytArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('Process timed out'));
    }, timeout);
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || killed) return;
      
      if (code === 0) {
        resolve(stdout);
      } else {
        const errorMsg = stderr.trim();
        
        if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('bot') || errorMsg.includes('HTTP Error 403')) {
          if (cookiesEnabled()) {
            reject(new Error('YouTube blocked request. Try updating cookies with fresh session.'));
          } else {
            reject(new Error('YouTube blocked request. Add cookies for authentication.'));
          }
        } else if (errorMsg.includes('Requested format is not available') || errorMsg.includes('no format')) {
          reject(new Error('Format not available. Trying best quality...'));
        } else if (errorMsg.includes('ffmpeg') && errorMsg.includes('not found')) {
          reject(new Error('FFmpeg not available. Please install ffmpeg.'));
        } else if (errorMsg) {
          reject(new Error(errorMsg));
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

app.post('/api/info', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    
    const { url, format } = req.body;
    
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!sanitizeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    const output = await execYtDlp([
      '--dump-single-json',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      url
    ]);
    
    const info = JSON.parse(output.trim());
    
    let formats = [];
    
    if (format === 'mp4') {
      const videoFormats = info.formats?.filter(f => f.ext === 'mp4' && f.filesize && f.height) || [];
      const uniqueQualities = new Map();
      
      videoFormats.forEach(f => {
        const quality = `${f.height}p`;
        if (!uniqueQualities.has(quality)) {
          uniqueQualities.set(quality, {
            formatId: f.format_id,
            quality: quality,
            ext: 'mp4',
            filesize: f.filesize,
            height: f.height
          });
        }
      });
      
      uniqueQualities.forEach((value) => formats.push(value));
      formats.sort((a, b) => (b.height || 0) - (a.height || 0));
      
      if (formats.length === 0) {
        videoFormats.slice(0, 8).forEach(f => {
          if (f.height) {
            formats.push({
              formatId: f.format_id,
              quality: `${f.height}p`,
              ext: 'mp4',
              filesize: f.filesize,
              height: f.height
            });
          }
        });
      }
    } else if (format === 'mp3' || format === 'wav') {
      formats = [
        { formatId: '320', quality: '320 kbps', ext: format, filesize: null, bitrate: 320 },
        { formatId: '128', quality: '128 kbps', ext: format, filesize: null, bitrate: 128 },
        { formatId: '64', quality: '64 kbps', ext: format, filesize: null, bitrate: 64 }
      ];
    }
    
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      uploader: info.uploader || info.channel || info.creator || 'Unknown',
      duration: info.duration,
      formats: formats.slice(0, 6)
    });
    
  } catch (error) {
    console.error('Error fetching video info:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch video information' });
  }
});

app.post('/api/download', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    
    const { url, formatId, quality, ext } = req.body;
    
    if (!url || !formatId) {
      return res.status(400).json({ error: 'URL and format are required' });
    }
    
    if (!sanitizeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    const tempDir = os.tmpdir();
    const uniqueId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const outputTemplate = path.join(tempDir, `v2x_${uniqueId}.%(ext)s`);
    
    let finalExt = ext || 'mp4';
    
    async function tryDownload(args, timeout) {
      await execYtDlp(args, timeout);
      
      const actualFile = outputTemplate.replace('%(ext)s', finalExt);
      
      if (!fs.existsSync(actualFile)) {
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith(`v2x_${uniqueId}`));
        if (files.length === 0) {
          throw new Error('Downloaded file not found');
        }
        return path.join(tempDir, files[0]);
      }
      return actualFile;
    }
    
    let finalPath;
    
    if (ext === 'mp3' || ext === 'wav') {
      const audioFormat = ext;
      const audioQual = formatId === '320' ? '0' : formatId === '128' ? '5' : '9';
      
      const args = [
        '-x',
        '--audio-format', audioFormat,
        '--audio-quality', audioQual,
        '--prefer-ffmpeg',
        '-o', outputTemplate,
        '--no-playlist',
        '--no-warnings',
        url
      ];
      
      try {
        finalPath = await tryDownload(args, 300000);
      } catch (err) {
        const retryArgs = [
          '-x',
          '--audio-format', audioFormat,
          '--audio-quality', '0',
          '--prefer-ffmpeg',
          '-o', outputTemplate,
          '--no-playlist',
          '--no-warnings',
          url
        ];
        try {
          finalPath = await tryDownload(retryArgs, 300000);
        } catch (retryErr) {
          const bestArgs = [
            '-f', 'bestaudio',
            '--prefer-ffmpeg',
            '-o', outputTemplate,
            '--no-playlist',
            '--no-warnings',
            url
          ];
          finalExt = 'm4a';
          finalPath = await tryDownload(bestArgs, 300000);
        }
      }
    } else {
      const args = [
        '-f', 'bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--prefer-ffmpeg',
        '-o', outputTemplate,
        '--no-playlist',
        '--no-warnings',
        url
      ];
      
      try {
        finalPath = await tryDownload(args, 300000);
      } catch (err) {
        const retryArgs = [
          '-f', 'best',
          '--prefer-ffmpeg',
          '-o', outputTemplate,
          '--no-playlist',
          '--no-warnings',
          url
        ];
        try {
          finalPath = await tryDownload(retryArgs, 300000);
        } catch (retryErr) {
          const bestVideoArgs = [
            '-f', 'bestvideo+bestaudio',
            '--prefer-ffmpeg',
            '-o', outputTemplate,
            '--no-playlist',
            '--no-warnings',
            url
          ];
          finalPath = await tryDownload(bestVideoArgs, 300000);
        }
      }
    }
    
    const stat = fs.statSync(finalPath);
    const filename = path.basename(finalPath);
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    const readStream = fs.createReadStream(finalPath);
    
    readStream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to send file' });
      }
    });
    
    res.on('close', () => {
      try {
        if (fs.existsSync(finalPath)) {
          fs.unlinkSync(finalPath);
        }
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError.message);
      }
    });
    
    readStream.pipe(res);
    
  } catch (error) {
    console.error('Error downloading video:', error.message);
    res.status(500).json({ error: error.message || 'Failed to download video' });
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});