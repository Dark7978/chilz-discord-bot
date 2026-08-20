'use strict';

const fs      = require('fs');
const path    = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// yt-dlp binary — same directory as the bot
const YTDLP = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// ffmpeg-static's Linux binary segfaults the moment it opens an HTTPS input, so
// prefer a real build when one is on disk. scripts/setup.js fetches it.
function resolveFfmpeg() {
  const bundled = path.join(__dirname, 'ffbuild', 'bin',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  for (const candidate of [process.env.FFMPEG_PATH, bundled]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return require('ffmpeg-static');
}
const FFMPEG = resolveFfmpeg();
console.log(`[Music] FFmpeg: ${FFMPEG}`);

// Per-guild queues: guildId → queue object
const queues = new Map();

// ── Format seconds → m:ss / h:mm:ss ──────────────────────────────────────────
function fmt(sec) {
  if (!sec || sec === Infinity) return '🔴 LIVE';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function cookieFile() {
  const fromEnv = process.env.YTDLP_COOKIES;
  const fallback = path.join(__dirname, 'youtube.cookies.txt');
  if (fromEnv && require('fs').existsSync(fromEnv)) return fromEnv;
  if (require('fs').existsSync(fallback)) return fallback;
  return null;
}

function isYoutubeTarget(target) {
  return !target || /youtube\.com|youtu\.be|^ytsearch/i.test(target);
}

function ytdlpFlags(target = '') {
  const args = ['--no-warnings'];
  if (!isYoutubeTarget(target)) return args;
  args.push('--extractor-args', 'youtube:player_client=web');
  if (process.platform !== 'win32') args.push('--js-runtimes', 'deno');
  const cookies = cookieFile();
  if (cookies) args.push('--cookies', cookies);
  return args;
}

function audioFormatFor(target) {
  return isYoutubeTarget(target)
    ? '18/bestaudio[protocol=https]/best[protocol=https]/bestaudio/best'
    : 'bestaudio/best';
}

function songFromYtdlp(info, source = 'YouTube') {
  const url = info.webpage_url || info.url || info.original_url;
  if (!url) return null;
  return {
    title:     info.title || 'Unknown',
    url,
    duration:  info.duration || 0,
    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || null,
    author:    info.uploader || info.channel || info.artist || 'Unknown',
    source,
  };
}

// YouTube refuses datacenter IPs. Remember a refusal so every later search
// doesn't pay for a doomed request first.
const YT_BLOCK_TTL = 10 * 60 * 1000;
let ytBlockedUntil = 0;

function isYoutubeBlock(err) {
  if (err?.youtubeBlocked) return true;
  const text = `${err?.message || ''} ${err?.stderr || ''}`;
  return /sign in to confirm|not a bot|requires login|login_required|use --cookies/i.test(text);
}

function youtubeBlocked() {
  return Date.now() < ytBlockedUntil;
}

function wrapYtdlpError(err) {
  if (isYoutubeBlock(err)) {
    ytBlockedUntil = Date.now() + YT_BLOCK_TTL;
    console.warn('[Music] YouTube refused this host — using SoundCloud instead.');
    const blocked = new Error('YouTube is refusing requests from this host.');
    blocked.youtubeBlocked = true;
    return blocked;
  }
  return err;
}

function parseYtdlpJson(stdout, source) {
  return stdout.trim().split('\n')
    .filter(l => l.trim().startsWith('{'))
    .map(line => {
      try { return songFromYtdlp(JSON.parse(line), source); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function youtubeSearch(query, limit = 1) {
  const target = `ytsearch${limit}:${query}`;
  console.log(`[Music] YouTube search limit=${limit} query="${query}"`);
  try {
    const { stdout } = await execFileAsync(YTDLP, [
      target,
      '--dump-json',
      '--flat-playlist',
      '--no-playlist',
      ...ytdlpFlags(target),
    ], { maxBuffer: 10 * 1024 * 1024 });

    return parseYtdlpJson(stdout, 'YouTube');
  } catch (err) {
    throw wrapYtdlpError(err);
  }
}

// Label uploads on SoundCloud are 30-second previews; anything this short is
// almost certainly one of those rather than the real track.
const SC_MIN_SECONDS = 40;

// SoundCloud is mostly reuploads, so searching for a well known song returns a
// wall of remixes, bootlegs and hour-long mixes. Rank them so the version that
// actually resembles the requested track wins.
// "x", "vs" and "×" catch mashups, which name two songs and so never carry a
// give-away word like "remix".
const VARIANT_RE = /\b(remix|bootleg|edit|flip|mashup|medley|transition|nightcore|sped ?up|slowed|reverb|cover|karaoke|instrumental|acapella|parody|tribute|remake|refix|rework|vip|hardstyle|techno|dubstep|uptempo|afro ?house|live|mix|8d|x|vs)\b|×/i;
const TITLE_NOISE_RE = /\b(official|video|audio|lyrics?|hd|4k|full|remastered|free ?download|ft|feat|the|and|a)\b/g;

function titleTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(TITLE_NOISE_RE, ' ')
    .split(' ')
    .filter(t => t.length > 1);
}

function looksLikeVariant(song) {
  return VARIANT_RE.test(song?.title || '');
}

// Worth playing without looking any further: not an alternate cut, and the right
// length when we know what the right length is.
function isConfidentMatch(song, reference) {
  if (!song || looksLikeVariant(song)) return false;
  if (!reference.duration || !song.duration) return true;
  return Math.abs(song.duration - reference.duration) / reference.duration <= 0.15;
}

function rankCandidates(songs, query, reference) {
  const wanted = titleTokens(reference.name || query);
  const queryIsVariant = VARIANT_RE.test(query);
  const target = reference.duration || 0;

  return songs
    .map((s, i) => {
      const have = new Set(titleTokens(s.title));
      const hit  = wanted.filter(t => have.has(t) || titleTokens(s.author).includes(t)).length;
      let score  = wanted.length ? (hit / wanted.length) * 100 : 50;

      // Unless the request asked for a remix, treat one as the wrong track.
      if (!queryIsVariant && looksLikeVariant(s)) score -= 45;

      if (target && s.duration) {
        const off = Math.abs(s.duration - target) / target;
        score -= Math.min(off, 1) * 60;
      }

      // Words in the title that the real track doesn't have are usually remixer
      // credits or mashup partners. Small nudge only — never enough to beat a
      // genuine title match.
      const extra = [...have].filter(t => !wanted.includes(t)).length;
      score -= Math.min(extra, 8);

      return { s, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.s);
}

// Reupload titles carry junk that no music service can match — bracketed notes,
// bass-boost frequency lists, "official video". Strip it to get back to the song.
function cleanQuery(text) {
  return String(text || '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)*\s*hz\b/gi, ' ')
    .replace(/\b(re)?bass(ed|boosted)?\b|\bbass ?boost(ed)?\b/gi, ' ')
    .replace(/\b(official|music)?\s*(video|audio|lyrics?|visualizer|hd|4k|hq)\b/gi, ' ')
    .replace(/[|/]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Deezer's search is free, keyless, and reachable from hosts YouTube blocks. It
// gives the canonical artist, title and length to score candidates against, so
// remixes and "full album" uploads stop winning.
async function referenceTrack(query) {
  for (const attempt of [...new Set([query, cleanQuery(query)])].filter(Boolean)) {
    try {
      const res = await fetch(`https://api.deezer.com/search?limit=6&q=${encodeURIComponent(attempt)}`);
      if (!res.ok) continue;
      const hits = (await res.json()).data || [];
      if (!hits.length) continue;

      // Deezer's first hit is often a 12" mix or a tribute. Popularity picks the
      // original, but only trust a plain title over an obvious alternate cut.
      const best = hits
        .map(t => ({ t, score: (t.rank || 0) - (VARIANT_RE.test(t.title || '') ? 1e7 : 0) }))
        .sort((a, b) => b.score - a.score)[0].t;

      return {
        name: `${best.artist?.name || ''} ${best.title_short || best.title || ''}`.trim(),
        // If even Deezer only lists alternate cuts, its length says nothing
        // about the track being asked for.
        duration: VARIANT_RE.test(best.title || '') ? 0 : best.duration || 0,
      };
    } catch {
      // try the next phrasing
    }
  }
  return {};
}

// Every extra result is another request, so ask for a small page first and only
// pay for a deeper one when the cheap passes come up short.
const SC_WIDE = 15;

async function scFetch(phrase, size) {
  const args = [
    `scsearch${size}:${phrase}`,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--ignore-errors',
  ];
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(YTDLP, args, { maxBuffer: 20 * 1024 * 1024 }));
  } catch (err) {
    // --ignore-errors still exits non-zero. DRM'd, deleted and region-locked
    // uploads are a normal part of SoundCloud results rather than a failure —
    // an artist's official uploads are frequently all DRM protected.
    const skipped = /DRM protected|unavailable|is private|Unable to download/i.test(err.stderr || '');
    if (!err.stdout?.trim() && !skipped) throw err;
    stdout = err.stdout || '';
  }
  const songs = parseYtdlpJson(stdout, 'SoundCloud');
  const full  = songs.filter(s => !s.duration || s.duration >= SC_MIN_SECONDS);
  return full.length ? full : songs;
}

async function soundcloudSearch(query, limit = 1, targetSeconds = 0) {
  const reference = await referenceTrack(query);
  if (targetSeconds) reference.duration = targetSeconds;
  const wantsVariant = VARIANT_RE.test(query);

  // A reupload title ("(37,34,31,28Hz) ... (Rebassed By DJBC)") matches nothing,
  // so retry with the tidied title and the canonical name before giving up.
  const phrases = [...new Set([query, cleanQuery(query), reference.name].filter(Boolean))];
  const base    = Math.min(Math.max(limit * 5, 5), 25);
  const wide    = Math.min(Math.max(limit * 5, SC_WIDE), 25);

  // At most four searches: each phrasing cheaply, then one deeper pass on what
  // was actually asked for.
  const attempts = [...phrases.map(phrase => ({ phrase, size: base })),
                    { phrase: phrases[0], size: wide }];
  const tried = new Set();
  const pool  = new Map();

  for (const { phrase, size } of attempts) {
    const key = `${size}:${phrase}`;
    if (tried.has(key)) continue;
    tried.add(key);

    console.log(`[Music] SoundCloud search size=${size} query="${phrase}"`);
    for (const song of await scFetch(phrase, size)) {
      if (!pool.has(song.url)) pool.set(song.url, song);
    }
    if (!pool.size) continue;

    // Stop early only for a match worth stopping on. An edit or a wrong-length
    // upload winning means the real track is probably in a later attempt, so
    // everything found so far is ranked together rather than one page at a time.
    const ranked = rankCandidates([...pool.values()], query, reference);
    if (wantsVariant || isConfidentMatch(ranked[0], reference)) return ranked;
  }
  return pool.size ? rankCandidates([...pool.values()], query, reference) : [];
}

// Attach the runner-up versions so a bad match is one click from being fixed.
function withAlternatives(ranked, limit) {
  if (limit !== 1 || !ranked.length) return ranked.slice(0, limit);
  const [best, ...rest] = ranked;
  return [{
    ...best,
    variant: looksLikeVariant(best),
    alternatives: rest.slice(0, 3),
  }];
}

// Swap the playing track for one of the alternatives offered when it was queued.
async function playAlternative(guildId, index) {
  const queue = queues.get(guildId);
  const current = queue?.songs[0];
  const pick = current?.alternatives?.[index];
  if (!pick) return null;

  const others = current.alternatives.filter((_, i) => i !== index);
  queue.songs[0] = {
    ...pick,
    source: current.source,
    requestedBy: current.requestedBy,
    variant: looksLikeVariant(pick),
    alternatives: [...others, { ...current, alternatives: undefined, variant: undefined }],
  };
  queue.ignoreIdle = true;
  await playSong(queue);
  return queue.songs[0];
}

// oEmbed still answers from blocked hosts, so a pasted link can at least give
// us a title to search for elsewhere.
async function youtubeTitle(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.title || '').trim() || null;
  } catch {
    return null;
  }
}

// A search listing never touches YouTube's player, so results can come back on
// a host that is not allowed to fetch the audio. Confirm before trusting them.
async function youtubePlayable(url) {
  try {
    await ytdlpInfo(url);
    return true;
  } catch (err) {
    if (isYoutubeBlock(err)) return false;
    throw err;
  }
}

async function musicSearch(query, limit = 1, targetSeconds = 0) {
  if (!youtubeBlocked()) {
    try {
      const results = await youtubeSearch(query, limit);
      if (results.length && await youtubePlayable(results[0].url)) return results;
    } catch (err) {
      if (!isYoutubeBlock(err)) throw err;
    }
  }
  const ranked = await soundcloudSearch(query, limit, targetSeconds);
  if (!ranked.length) throw new Error(`Nothing playable found for "${query}". Try adding the artist name.`);
  return withAlternatives(ranked, limit);
}

async function ytdlpInfo(url) {
  try {
    const { stdout } = await execFileAsync(YTDLP, [
      url,
      '--dump-json',
      '--no-playlist',
      ...ytdlpFlags(url),
    ], { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n')[0]);
  } catch (err) {
    throw wrapYtdlpError(err);
  }
}

async function ytdlpPlaylist(url) {
  try {
    const { stdout } = await execFileAsync(YTDLP, [
      url,
      '--dump-json',
      '--flat-playlist',
      '--playlist-end', '50',
      ...ytdlpFlags(url),
    ], { maxBuffer: 10 * 1024 * 1024 });

    return parseYtdlpJson(stdout, 'YouTube');
  } catch (err) {
    throw wrapYtdlpError(err);
  }
}

/**
 * Get the direct CDN/HLS audio URL from yt-dlp (-g flag).
 * Returns immediately after URL extraction (~1s). FFmpeg then streams
 * from the CDN directly — no pipe startup delay.
 */
async function getDirectAudioUrl(url) {
  const { stdout } = await execFileAsync(YTDLP, [
    url,
    '-f', audioFormatFor(url),
    '-g',
    '--no-playlist',
    '--quiet',
    ...ytdlpFlags(url),
  ], { maxBuffer: 1024 * 1024 });
  return stdout.trim().split('\n')[0];
}

// ── Deezer URL → resolve track info via free public API ───────────────────────
async function resolveDeezer(url) {
  const trackMatch    = url.match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/i);
  const albumMatch    = url.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/i);
  const playlistMatch = url.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/i);

  async function dzFetch(endpoint) {
    const res = await fetch(`https://api.deezer.com${endpoint}`);
    const data = await res.json();
    if (data.error) throw new Error(`Deezer: ${data.error.message}`);
    return data;
  }

  async function deezerTrackToYt(artist, title, seconds = 0) {
    const results = await musicSearch(`${artist} ${title}`, 1, seconds);
    if (!results.length) throw new Error(`No match for "${artist} - ${title}"`);
    return { ...results[0], source: `Deezer → ${results[0].source}` };
  }

  if (trackMatch) {
    const data = await dzFetch(`/track/${trackMatch[1]}`);
    return [await deezerTrackToYt(data.artist.name, data.title, data.duration || 0)];
  }
  if (albumMatch) {
    const data   = await dzFetch(`/album/${albumMatch[1]}`);
    const tracks = data.tracks?.data || [];
    const songs  = [];
    for (const t of tracks.slice(0, 50)) {
      try { songs.push(await deezerTrackToYt(t.artist.name, t.title, t.duration || 0)); } catch {}
    }
    if (!songs.length) throw new Error('No tracks resolved from that Deezer album.');
    return songs;
  }
  if (playlistMatch) {
    const data   = await dzFetch(`/playlist/${playlistMatch[1]}`);
    const tracks = data.tracks?.data || [];
    const songs  = [];
    for (const t of tracks.slice(0, 50)) {
      try { songs.push(await deezerTrackToYt(t.artist.name, t.title, t.duration || 0)); } catch {}
    }
    if (!songs.length) throw new Error('No tracks resolved from that Deezer playlist.');
    return songs;
  }
  throw new Error('Unsupported Deezer URL — use a track, album, or playlist link.');
}

// ── Main search / resolve function ───────────────────────────────────────────
let spotifyAuth = { token: null, expiresAt: 0 };

async function spotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify support needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.');
  }
  if (spotifyAuth.token && Date.now() < spotifyAuth.expiresAt) return spotifyAuth.token;
  const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify credentials were rejected. Check the Client ID and Secret.');
  const data = await res.json();
  spotifyAuth = { token: data.access_token, expiresAt: Date.now() + Math.max(30, (data.expires_in || 3600) - 60) * 1000 };
  return spotifyAuth.token;
}

function unwrapSpotifyTrack(item) {
  const t = item?.track || item;
  if (!t || t.is_local || !t.name) return null;
  return t;
}

async function spotifyResolve(url) {
  const match = url.match(/(?:open\.)?spotify\.com\/(?:intl-[^/]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)|spotify:(track|album|playlist):([A-Za-z0-9]+)/i);
  if (!match) throw new Error('Unsupported Spotify URL. Use a track, album, or playlist link.');
  const type = (match[1] || match[3]).toLowerCase();
  const id = match[2] || match[4];
  const token = await spotifyToken();
  const api = async path => {
    const urls = [
      `https://api.spotify.com/v1/${path}`,
      `https://api.spotify.com/v1/${path}${path.includes('?') ? '&' : '?'}market=US`,
    ];
    let lastStatus = 0;
    let lastBody = '';
    for (const url of urls) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return res.json();
      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');
    }
    console.error(`[Music] Spotify API ${lastStatus} path=${path} body=${lastBody.slice(0, 200)}`);
    throw new Error(`Spotify metadata request failed (${lastStatus}).`);
  };
  const toSearch = async t => {
    const artist = t.artists?.[0]?.name || '';
    const query = `${artist} ${t.name || ''}`.trim();
    if (!query) return null;
    const seconds = Math.round((t.duration_ms || 0) / 1000);
    try {
      const found = await musicSearch(query, 1, seconds);
      if (!found.length) return null;
      console.log(`[Music] Spotify metadata → ${found[0].source} search "${query}" → ${found[0].url}`);
      return { ...found[0], source: `Spotify → ${found[0].source}`, spotifyQuery: query };
    } catch (err) {
      console.error(`[Music] Spotify search failed for "${query}":`, err.message);
      return null;
    }
  };
  if (type === 'track') {
    const t = await api(`tracks/${id}`);
    const s = await toSearch(t);
    if (!s) throw new Error(`No playable match for Spotify track "${t.name}".`);
    return [s];
  }
  const data = await api(`${type}s/${id}`);
  const items = (data.tracks?.items || []).slice(0, 50).map(unwrapSpotifyTrack).filter(Boolean);
  const songs = [];
  for (const t of items) {
    const s = await toSearch(t);
    if (s) songs.push(s);
  }
  if (!songs.length) throw new Error('No playable matches found for that Spotify collection.');
  return songs;
}

function extractPlayQuery(raw) {
  const text = String(raw || '').trim();
  const url = text.match(/https?:\/\/[^\s<>"'`]+|spotify:[a-z]+:[A-Za-z0-9]+/i);
  if (url) return url[0].replace(/[),.;]+$/g, '');
  return text.replace(/^\/music\s+play(?:\s+query:)?\s*/i, '').trim();
}

async function search(query, limit = 1) {
  query = extractPlayQuery(query);
  if (/spotify\.com|spotify:/i.test(query)) return spotifyResolve(query);
  if (/deezer\.com/i.test(query)) return resolveDeezer(query);
  if (/soundcloud\.com/i.test(query)) {
    const info = await ytdlpInfo(query);
    const song = songFromYtdlp(info, 'SoundCloud');
    if (!song) throw new Error('Could not resolve that SoundCloud link.');
    return [song];
  }
  if (/youtube\.com\/playlist|youtu\.be\/.*[?&]list=|list=/i.test(query) && /youtube\.com|youtu\.be/i.test(query)) {
    try {
      const songs = await ytdlpPlaylist(query);
      if (songs.length) return songs;
      throw new Error('No videos found in that YouTube playlist.');
    } catch (err) {
      if (!isYoutubeBlock(err)) throw err;
      throw new Error('YouTube is blocking this server, and playlists can only come from YouTube. Search by song name instead.');
    }
  }
  if (/youtube\.com|youtu\.be/i.test(query)) {
    if (!youtubeBlocked()) {
      try {
        const song = songFromYtdlp(await ytdlpInfo(query), 'YouTube');
        if (song) return [song];
      } catch (err) {
        if (!isYoutubeBlock(err)) throw err;
      }
    }
    const title = await youtubeTitle(query);
    if (!title) throw new Error('YouTube is blocking this server and the video title could not be read. Try searching by song name.');
    const ranked = await soundcloudSearch(title, 1);
    if (!ranked.length) throw new Error(`YouTube is blocking this server and nothing matching "${cleanQuery(title) || title}" is on SoundCloud. Try searching by song name.`);
    const [best] = withAlternatives(ranked, 1);
    console.log(`[Music] YouTube link "${title}" → SoundCloud ${best.url}`);
    return [{ ...best, source: 'YouTube → SoundCloud' }];
  }
  return musicSearch(query, limit);
}

const EQ_ORDER = ['clean', 'bass', 'vocal', 'treble', 'punch'];
const EQ_PRESETS = {
  clean: { label: 'Clean', extra: '' },
  bass:  { label: 'Bass', extra: 'equalizer=f=65:t=q:w=1.1:g=7,equalizer=f=180:t=q:w=1:g=3,equalizer=f=8000:t=q:w=1:g=-1.5,' },
  vocal: { label: 'Vocal', extra: 'equalizer=f=120:t=q:w=1:g=-3,equalizer=f=3000:t=q:w=1.1:g=4,equalizer=f=6000:t=q:w=1:g=2,' },
  treble:{ label: 'Treble', extra: 'equalizer=f=80:t=q:w=1:g=-2,equalizer=f=4000:t=q:w=1:g=2,equalizer=f=10000:t=q:w=1:g=5,' },
  punch: { label: 'Punch', extra: 'equalizer=f=80:t=q:w=1.1:g=5,equalizer=f=250:t=q:w=1:g=-1.5,equalizer=f=3500:t=q:w=1:g=3,' },
};

function audioFilter(eq) {
  const extra = EQ_PRESETS[eq]?.extra || EQ_PRESETS.clean.extra;
  return `${extra}highpass=f=40,lowpass=f=15500,acompressor=threshold=0.12:ratio=2.8:attack=15:release=220:makeup=2,dynaudnorm=f=150:g=12,aresample=48000:async=1`;
}

function cycleEq(queue) {
  const i = EQ_ORDER.indexOf(queue.eq || 'clean');
  queue.eq = EQ_ORDER[(i + 1) % EQ_ORDER.length];
  return queue.eq;
}

function applyEq(queue, name) {
  if (!EQ_PRESETS[name]) throw new Error(`Unknown EQ preset. Use: ${EQ_ORDER.join(', ')}`);
  queue.eq = name;
  return name;
}

function buildNPEmbed(queue) {
  const song = queue.songs[0];
  if (!song) return null;
  const loopLabel = { off: '➡️ Off', song: '🔂 Song', queue: '🔁 Queue' }[queue.loop];
  return new EmbedBuilder()
    .setColor('#FF5500')
    .setAuthor({ name: '🎵 Now Playing' })
    .setTitle(song.title.length > 80 ? song.title.slice(0, 77) + '…' : song.title)
    .setURL(song.url)
    .setThumbnail(song.thumbnail || null)
    .addFields(
      { name: '⏱️ Duration',     value: fmt(song.duration),                    inline: true },
      { name: '👤 Requested by', value: `<@${song.requestedBy}>`,              inline: true },
      { name: '🎧 Source',       value: song.source || 'YouTube',               inline: true },
      { name: '🔁 Loop',         value: loopLabel,                              inline: true },
      { name: '🔊 Volume',       value: `${Math.round(queue.volume * 100)}%`,   inline: true },
      { name: '🎚️ EQ',           value: EQ_PRESETS[queue.eq || 'clean'].label, inline: true },
    )
    .setFooter({ text: `${song.author || 'Unknown Artist'} · ${Math.max(0, queue.songs.length - 1)} up next` });
}

function buildControls(queue) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music_prev')   .setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setLabel('Prev'),
      new ButtonBuilder().setCustomId('music_pause')  .setEmoji(queue.paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary).setLabel(queue.paused ? 'Resume' : 'Pause'),
      new ButtonBuilder().setCustomId('music_skip')   .setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setLabel('Skip'),
      new ButtonBuilder().setCustomId('music_stop')   .setEmoji('⏹️').setStyle(ButtonStyle.Danger)   .setLabel('Stop'),
      new ButtonBuilder().setCustomId('music_queue')  .setEmoji('📋').setStyle(ButtonStyle.Secondary).setLabel('Queue'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setLabel('Shuffle'),
      new ButtonBuilder().setCustomId('music_loop')   .setEmoji('🔁').setStyle(ButtonStyle.Secondary).setLabel(`Loop: ${queue.loop}`),
      new ButtonBuilder().setCustomId('music_voldown').setEmoji('🔉').setStyle(ButtonStyle.Secondary).setLabel('-10%'),
      new ButtonBuilder().setCustomId('music_volup')  .setEmoji('🔊').setStyle(ButtonStyle.Secondary).setLabel('+10%'),
      new ButtonBuilder().setCustomId('music_eq')     .setEmoji('🎚️').setStyle(ButtonStyle.Secondary).setLabel(EQ_PRESETS[queue.eq || 'clean'].label),
    ),
  ];
}

// SoundCloud matching is imperfect, so the reply to /music play doubles as a
// version picker whenever other candidates were found.
function buildPickEmbed(song, queue, switched = false) {
  const queued = queue.songs[0] !== song && queue.playing;
  const embed = new EmbedBuilder()
    .setColor('#1DB954')
    .setTitle(switched ? '🔀 Switched version' : queued ? '✅ Added to Queue' : '▶️ Starting playback')
    .setDescription(`**[${song.title}](${song.url})**`)
    .setThumbnail(song.thumbnail || null)
    .addFields(
      { name: 'Duration', value: fmt(song.duration),                      inline: true },
      { name: 'Artist',   value: song.author || 'Unknown',                inline: true },
      { name: 'Source',   value: song.source || 'YouTube',                inline: true },
    );

  if (song.alternatives?.length) {
    embed.addFields({
      name: song.variant
        ? '⚠️ This looks like a remix or edit — try another version'
        : 'Not the version you wanted?',
      value: song.alternatives
        .map((a, i) => `**${i + 1}.** [${a.title}](${a.url}) \`${fmt(a.duration)}\``)
        .join('\n'),
    });
  }
  return embed;
}

function buildAltControls(song) {
  if (!song.alternatives?.length) return [];
  return [new ActionRowBuilder().addComponents(
    song.alternatives.map((a, i) =>
      new ButtonBuilder()
        .setCustomId(`music_alt_${i}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel(`Play ${i + 1} (${fmt(a.duration)})`)
    )
  )];
}

function buildQueueEmbed(queue) {
  const lines = queue.songs.slice(0, 15).map((s, i) =>
    i === 0
      ? `▶️ **${s.title}** \`${fmt(s.duration)}\` — <@${s.requestedBy}>`
      : `\`${i}.\` **${s.title}** \`${fmt(s.duration)}\` — <@${s.requestedBy}>`
  );
  const extra = queue.songs.length - 15;
  if (extra > 0) lines.push(`*…and ${extra} more*`);
  return new EmbedBuilder()
    .setColor('#FF5500')
    .setTitle('📋 Music Queue')
    .setDescription(lines.length ? lines.join('\n') : 'Queue is empty!')
    .setFooter({ text: `${queue.songs.length} song(s) | Loop: ${queue.loop} | Vol: ${Math.round(queue.volume * 100)}% | EQ: ${EQ_PRESETS[queue.eq || 'clean'].label}` });
}

// ── Queue management ──────────────────────────────────────────────────────────
function getQueue(guildId)  { return queues.get(guildId) || null; }

function killStream(q) {
  try { q.ytdlp?.kill('SIGKILL'); } catch {}
  try { q.ffmpeg?.kill('SIGKILL'); } catch {}
  q.ytdlp = null;
  q.ffmpeg = null;
}

function destroyQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  killStream(q);
  try { q.connection.destroy(); } catch {}
  queues.delete(guildId);
}

// ── Playback ──────────────────────────────────────────────────────────────────
async function playSong(queue) {
  if (!queue.songs.length) {
    queue.playing = false;
    setTimeout(() => {
      const q = queues.get(queue.guildId);
      if (q && !q.songs.length && !q.playing) {
        q.textChannel?.send({
          embeds: [new EmbedBuilder().setColor('#e74c3c').setDescription('📭 Queue finished — disconnecting.')],
        }).catch(() => {});
        if (q.nowPlayingMessage) q.nowPlayingMessage.delete().catch(() => {});
        destroyQueue(queue.guildId);
      }
    }, 30_000);
    return;
  }

  const song = queue.songs[0];
  queue.playing = true;
  queue.paused  = false;
  queue.ignoreIdle = true;

  try {
    killStream(queue);
    console.log(`[Music] resolving source=${song.source || 'unknown'} title="${song.title}" url=${song.url}`);
    // Pipe yt-dlp → FFmpeg. Direct googlevideo URLs from `-g` 403 in FFmpeg (missing client headers).
    const ytdlp = spawn(YTDLP, [
      song.url,
      '-f', audioFormatFor(song.url),
      '-o', '-',
      '--no-playlist',
      '--quiet',
      ...ytdlpFlags(song.url),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpeg = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-thread_queue_size', '4096',
      '-i', 'pipe:0',
      '-af', audioFilter(queue.eq || 'clean'),
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    queue.ytdlp = ytdlp;
    queue.ffmpeg = ffmpeg;
    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', err => {
      if (err.code !== 'EPIPE') console.error('[Music] FFmpeg stdin:', err.message);
    });
    ytdlp.stderr.on('data', chunk => console.error(`[Music] yt-dlp: ${chunk.toString().trim()}`));
    ytdlp.on('error', err => console.error('[Music] yt-dlp process error:', err.message));
    ffmpeg.stderr.on('data', chunk => console.error(`[Music] FFmpeg: ${chunk.toString().trim()}`));
    ffmpeg.on('error', err => console.error('[Music] FFmpeg process error:', err.message));
    ffmpeg.on('exit', (code, signal) => {
      if (code && code !== 0) console.error(`[Music] FFmpeg exited code=${code} signal=${signal || 'none'} title="${song.title}"`);
    });
    const resource  = createAudioResource(ffmpeg.stdout, {
      inputType:    StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume?.setVolume(queue.volume);
    queue.resource = resource;
    queue.player.play(resource);

    const embed      = buildNPEmbed(queue);
    const components = buildControls(queue);

    if (queue.nowPlayingMessage) {
      const edited = await queue.nowPlayingMessage.edit({ embeds: [embed], components }).catch(() => null);
      if (!edited) queue.nowPlayingMessage = null;
    }
    if (!queue.nowPlayingMessage) {
      queue.nowPlayingMessage = await queue.textChannel.send({ embeds: [embed], components }).catch(() => null);
    }
  } catch (err) {
    console.error('[Music] Stream error for', song.title, '—', err.message);
    queue.textChannel?.send({
      embeds: [new EmbedBuilder().setColor('#e74c3c').setDescription(`⚠️ Could not stream **${song.title}** — skipping.`)],
    }).catch(() => {});
    queue.songs.shift();
    await playSong(queue);
  }
}

// ── Create voice connection + queue ───────────────────────────────────────────
async function createQueue(guildId, voiceChannel, textChannel) {
  const player     = createAudioPlayer();
  const connection = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    throw new Error('Could not connect to your voice channel!');
  }

  connection.subscribe(player);

  const queue = {
    guildId, voiceChannel, textChannel,
    songs: [], history: [],
    playing: false, paused: false,
    loop: 'off', volume: 0.65, eq: 'clean', ignoreIdle: false,
    player, connection,
    resource: null, nowPlayingMessage: null, ffmpeg: null, ytdlp: null,
  };
  queues.set(guildId, queue);

  player.on(AudioPlayerStatus.Playing, () => {
    const q = queues.get(guildId);
    if (q) q.ignoreIdle = false;
    console.log(`[Music] player playing title="${q?.songs[0]?.title || 'unknown'}" source=${q?.songs[0]?.source || 'unknown'} eq=${q?.eq || 'clean'}`);
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    const q = queues.get(guildId);
    console.log(`[Music] player idle guild=${guildId} remaining=${q?.songs.length || 0} loop=${q?.loop || 'n/a'} ignoreIdle=${q?.ignoreIdle}`);
    if (!q || q.ignoreIdle) return;
    if (q.loop === 'song') return playSong(q);
    const finished = q.songs.shift();
    if (finished) q.history.push(finished);
    if (q.loop === 'queue' && !q.songs.length && q.history.length) {
      q.songs   = [...q.history];
      q.history = [];
    }
    await playSong(q);
  });

  player.on('error', err => {
    console.error('[Music] Player error:', err.message);
    const q = queues.get(guildId);
    if (!q) return;
    q.songs.shift();
    playSong(q);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (!queues.has(guildId)) return;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(guildId);
    }
  });

  return queue;
}

// ── Button handler ────────────────────────────────────────────────────────────
async function handleButton(interaction) {
  const queue = getQueue(interaction.guildId);
  if (!queue) return interaction.reply({ content: '❌ Nothing is playing!', flags: 64 });

  const memberVC = interaction.member?.voice?.channel;
  if (!memberVC || memberVC.id !== queue.voiceChannel.id) {
    return interaction.reply({ content: '❌ Join the voice channel to control music!', flags: 64 });
  }

  const id = interaction.customId;

  if (id === 'music_queue') {
    return interaction.reply({ embeds: [buildQueueEmbed(queue)], flags: 64 });
  }

  const altMatch = id.match(/^music_alt_(\d)$/);
  if (altMatch) {
    await interaction.deferUpdate();
    const picked = await playAlternative(interaction.guildId, Number(altMatch[1]));
    if (!picked) {
      await interaction.followUp({ content: '❌ That version is no longer available.', flags: 64 }).catch(() => {});
      return;
    }
    await interaction.editReply({
      embeds:     [buildPickEmbed(picked, queue, true)],
      components: buildAltControls(picked),
    }).catch(() => {});
    return;
  }

  await interaction.deferUpdate();

  switch (id) {
    case 'music_pause':
      if (queue.paused) { queue.player.unpause(); queue.paused = false; }
      else              { queue.player.pause();   queue.paused = true;  }
      break;
    case 'music_skip':
      queue.player.stop();
      return;
    case 'music_prev':
      if (!queue.history.length) {
        await interaction.followUp({ content: '❌ No previous song!', flags: 64 }).catch(() => {});
        return;
      }
      queue.songs.unshift(queue.history.pop());
      queue.player.stop();
      return;
    case 'music_stop':
      destroyQueue(interaction.guildId);
      await interaction.message.edit({
        embeds:     [new EmbedBuilder().setColor('#e74c3c').setDescription('⏹️ Music stopped. Queue cleared.')],
        components: [],
      }).catch(() => {});
      return;
    case 'music_shuffle': {
      if (queue.songs.length <= 1) return;
      const [cur, ...rest] = queue.songs;
      queue.songs = [cur, ...rest.sort(() => Math.random() - 0.5)];
      break;
    }
    case 'music_loop': {
      const modes = ['off', 'song', 'queue'];
      queue.loop  = modes[(modes.indexOf(queue.loop) + 1) % modes.length];
      break;
    }
    case 'music_eq':
      cycleEq(queue);
      console.log(`[Music] EQ set to ${queue.eq}`);
      await playSong(queue);
      return;
    case 'music_voldown':
      queue.volume = Math.max(0,   Math.round((queue.volume - 0.1) * 10) / 10);
      queue.resource?.volume?.setVolume(queue.volume);
      break;
    case 'music_volup':
      queue.volume = Math.min(1,   Math.round((queue.volume + 0.1) * 10) / 10);
      queue.resource?.volume?.setVolume(queue.volume);
      break;
  }

  const embed = buildNPEmbed(queue);
  if (embed) await interaction.message.edit({ embeds: [embed], components: buildControls(queue) }).catch(() => {});
}

module.exports = {
  getQueue, destroyQueue, createQueue,
  search, playSong, handleButton, playAlternative,
  buildNPEmbed, buildControls, buildQueueEmbed, buildPickEmbed, buildAltControls, fmt,
  applyEq, cycleEq, EQ_PRESETS, EQ_ORDER,
};
