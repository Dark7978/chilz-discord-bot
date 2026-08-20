'use strict';

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
const FFMPEG = require('ffmpeg-static');

// Per-guild queues: guildId → queue object
const queues = new Map();

// ── Format seconds → m:ss / h:mm:ss ──────────────────────────────────────────
function fmt(sec) {
  if (!sec || sec === Infinity) return '🔴 LIVE';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
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

async function youtubeSearch(query, limit = 1) {
  console.log(`[Music] YouTube search limit=${limit} query="${query}"`);
  const { stdout } = await execFileAsync(YTDLP, [
    `ytsearch${limit}:${query}`,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--no-playlist',
  ], { maxBuffer: 10 * 1024 * 1024 });

  return stdout.trim().split('\n')
    .filter(l => l.trim())
    .map(line => {
      try { return songFromYtdlp(JSON.parse(line), 'YouTube'); }
      catch { return null; }
    })
    .filter(Boolean);
}

async function ytdlpInfo(url) {
  const { stdout } = await execFileAsync(YTDLP, [
    url,
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
  ], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split('\n')[0]);
}

async function ytdlpPlaylist(url) {
  const { stdout } = await execFileAsync(YTDLP, [
    url,
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    '--playlist-end', '50',
  ], { maxBuffer: 10 * 1024 * 1024 });

  return stdout.trim().split('\n')
    .filter(l => l.trim())
    .map(line => {
      try { return songFromYtdlp(JSON.parse(line), 'YouTube'); }
      catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Get the direct CDN/HLS audio URL from yt-dlp (-g flag).
 * Returns immediately after URL extraction (~1s). FFmpeg then streams
 * from the CDN directly — no pipe startup delay.
 */
async function getDirectAudioUrl(url) {
  const { stdout } = await execFileAsync(YTDLP, [
    url,
    '-f', 'bestaudio/best',
    '-g',                 // print direct URL, don't download
    '--no-playlist',
    '--quiet',
    '--no-warnings',
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

  async function deezerTrackToYt(artist, title) {
    const results = await youtubeSearch(`${artist} ${title}`, 1);
    if (!results.length) throw new Error(`No YouTube match for "${artist} - ${title}"`);
    return { ...results[0], source: 'Deezer → YouTube' };
  }

  if (trackMatch) {
    const data = await dzFetch(`/track/${trackMatch[1]}`);
    return [await deezerTrackToYt(data.artist.name, data.title)];
  }
  if (albumMatch) {
    const data   = await dzFetch(`/album/${albumMatch[1]}`);
    const tracks = data.tracks?.data || [];
    const songs  = [];
    for (const t of tracks.slice(0, 50)) {
      try { songs.push(await deezerTrackToYt(t.artist.name, t.title)); } catch {}
    }
    if (!songs.length) throw new Error('No tracks resolved from that Deezer album.');
    return songs;
  }
  if (playlistMatch) {
    const data   = await dzFetch(`/playlist/${playlistMatch[1]}`);
    const tracks = data.tracks?.data || [];
    const songs  = [];
    for (const t of tracks.slice(0, 50)) {
      try { songs.push(await deezerTrackToYt(t.artist.name, t.title)); } catch {}
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
    try {
      const found = await youtubeSearch(query, 1);
      if (!found.length) return null;
      console.log(`[Music] Spotify metadata → YouTube search "${query}" → ${found[0].url}`);
      return { ...found[0], source: 'Spotify → YouTube', spotifyQuery: query };
    } catch (err) {
      console.error(`[Music] Spotify → YouTube search failed for "${query}":`, err.message);
      return null;
    }
  };
  if (type === 'track') {
    const t = await api(`tracks/${id}`);
    const s = await toSearch(t);
    if (!s) throw new Error(`No YouTube match for Spotify track "${t.name}".`);
    return [s];
  }
  const data = await api(`${type}s/${id}`);
  const items = (data.tracks?.items || []).slice(0, 50).map(unwrapSpotifyTrack).filter(Boolean);
  const songs = [];
  for (const t of items) {
    const s = await toSearch(t);
    if (s) songs.push(s);
  }
  if (!songs.length) throw new Error('No YouTube matches found for that Spotify collection.');
  return songs;
}

async function search(query, limit = 1) {
  if (/spotify\.com|spotify:/i.test(query)) return spotifyResolve(query);
  if (/soundcloud\.com/i.test(query)) throw new Error('SoundCloud is not used as a playback source. Search by song name, YouTube, Spotify, or Deezer.');
  if (/deezer\.com/i.test(query)) return resolveDeezer(query);
  if (/youtube\.com\/playlist|youtu\.be\/.*[?&]list=|list=/i.test(query) && /youtube\.com|youtu\.be/i.test(query)) {
    const songs = await ytdlpPlaylist(query);
    if (!songs.length) throw new Error('No videos found in that YouTube playlist.');
    return songs;
  }
  if (/youtube\.com|youtu\.be/i.test(query)) {
    const info = await ytdlpInfo(query);
    const song = songFromYtdlp(info, 'YouTube');
    if (!song) throw new Error('Could not resolve that YouTube URL.');
    return [song];
  }
  const results = await youtubeSearch(query, limit);
  if (!results.length) throw new Error('No results found on YouTube.');
  return results;
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
      '-f', 'bestaudio[acodec=opus]/bestaudio/best',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--extractor-args', 'youtube:player_client=android,ios,web',
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
  search, playSong, handleButton,
  applyEq, cycleEq, EQ_PRESETS, EQ_ORDER,
};
