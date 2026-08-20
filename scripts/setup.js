'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const envExample = path.join(root, '.env.example');
const envFile = path.join(root, '.env');
const isWin = process.platform === 'win32';
const dest = path.join(root, isWin ? 'yt-dlp.exe' : 'yt-dlp');
const url = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function download(from, to) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(to);
    const go = (link) => {
      https.get(link, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          go(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed (${res.statusCode})`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };
    go(from);
  });
}

// The ffmpeg-static package ships a Linux binary that segfaults as soon as it
// opens an HTTPS input, so fetch a real build. The Windows one is fine.
async function installFfmpeg() {
  if (isWin || process.arch !== 'x64') return;

  const ffbuild = path.join(root, 'ffbuild');
  if (fs.existsSync(path.join(ffbuild, 'bin', 'ffmpeg'))) {
    console.log('FFmpeg build is already in the project folder.');
    return;
  }

  const archive = path.join(root, 'ffmpeg.tar.xz');
  try {
    console.log('Downloading FFmpeg (~123 MB, for reliable streaming)...');
    await download('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz', archive);
    fs.mkdirSync(ffbuild, { recursive: true });
    execFileSync('tar', ['-xf', archive, '-C', ffbuild, '--strip-components=1']);
    console.log('Saved ffbuild/bin/ffmpeg');
  } catch (err) {
    console.warn(`Could not install FFmpeg (${err.message}) — falling back to the bundled one.`);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function main() {
  if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
    console.log('Created .env from .env.example — add your Discord bot token.');
  } else {
    console.log('.env already exists, leaving it alone.');
  }

  if (fs.existsSync(dest)) {
    console.log('yt-dlp is already in the project folder.');
  } else {
    console.log('Downloading yt-dlp (needed for music)...');
    await download(url, dest);
    if (!isWin) fs.chmodSync(dest, 0o755);
    console.log('Saved', path.basename(dest));
  }

  await installFfmpeg();

  console.log('\nNext:');
  console.log('  1. Put DISCORD_TOKEN in .env');
  console.log('  2. npm start');
  console.log('  3. In Discord, run /setup');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
