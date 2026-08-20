'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

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

  console.log('\nNext:');
  console.log('  1. Put DISCORD_TOKEN in .env');
  console.log('  2. npm start');
  console.log('  3. In Discord, run /setup');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
