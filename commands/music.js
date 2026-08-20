'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const music = require('../musicManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('🎵 Music player — YouTube, SoundCloud, Spotify metadata, Deezer, playlists')
    // ── play ────────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('play')
      .setDescription('Play a song — search by name, YouTube, SoundCloud, Spotify, or Deezer')
      .addStringOption(o => o
        .setName('query')
        .setDescription('Song name, YouTube URL, SoundCloud link, Spotify link, or Deezer link')
        .setRequired(true)
      )
    )
    // ── search ──────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('search')
      .setDescription('Search for a song and see the top 5 results')
      .addStringOption(o => o.setName('query').setDescription('Search query').setRequired(true))
    )
    // ── skip ────────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('skip')   .setDescription('Skip the current song'))
    // ── pause ───────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('pause')  .setDescription('Pause playback'))
    // ── resume ──────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('resume') .setDescription('Resume playback'))
    // ── stop ────────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('stop')   .setDescription('Stop music and clear the queue'))
    // ── queue ───────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('queue')  .setDescription('Show the music queue'))
    // ── nowplaying ──────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('np')     .setDescription('Show the current song with controls'))
    // ── volume ──────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('volume')
      .setDescription('Set the volume (1 – 100)')
      .addIntegerOption(o => o
        .setName('level').setDescription('1 – 100').setRequired(true)
        .setMinValue(1).setMaxValue(100)
      )
    )
    // ── shuffle ─────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('shuffle').setDescription('Shuffle the queue'))
    // ── loop ────────────────────────────────────────────────────────────────
    .addSubcommand(s => s.setName('loop')   .setDescription('Cycle loop: off → song → queue → off'))
    .addSubcommand(s => s
      .setName('eq')
      .setDescription('Set the equalizer preset (Clean, Bass, Vocal, Treble, Punch)')
      .addStringOption(o => o
        .setName('preset')
        .setDescription('EQ preset')
        .setRequired(true)
        .addChoices(
          { name: 'Clean', value: 'clean' },
          { name: 'Bass', value: 'bass' },
          { name: 'Vocal', value: 'vocal' },
          { name: 'Treble', value: 'treble' },
          { name: 'Punch', value: 'punch' },
        )
      )
    ),

  // ── execute ────────────────────────────────────────────────────────────────
  async execute(interaction, client) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── /music play ──────────────────────────────────────────────────────────
    if (sub === 'play') {
      const query    = interaction.options.getString('query');
      const memberVC = interaction.member.voice?.channel;

      if (!memberVC) {
        return interaction.reply({ content: '❌ You need to join a voice channel first!', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      try {
        const songs = await music.search(query);
        songs.forEach(s => { s.requestedBy = interaction.user.id; });

        let queue    = music.getQueue(guildId);
        const isNew  = !queue;

        if (!queue) {
          queue = await music.createQueue(guildId, memberVC, interaction.channel);
        } else if (queue.voiceChannel.id !== memberVC.id) {
          return interaction.editReply({ content: '❌ I\'m already playing in a different voice channel!' });
        }

        const wasEmpty = !queue.songs.length;
        queue.songs.push(...songs);

        // ── Playlist confirmation ─────────────────────────────────────────
        if (songs.length > 1) {
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor('#1DB954')
              .setDescription(`✅ Added **${songs.length} songs** from playlist to the queue!`)
              .setFooter({ text: `${queue.songs.length} total in queue` })],
          });
        } else {
          // ── Single song: queued vs. starting, with a version picker ────
          await interaction.editReply({
            embeds:     [music.buildPickEmbed(songs[0], queue)],
            components: music.buildAltControls(songs[0]),
          });
        }

        // ── Begin playing if queue was empty ──────────────────────────────
        if (wasEmpty || !queue.playing) {
          await music.playSong(queue);
        }
      } catch (err) {
        console.error('[music/play]', err);
        await interaction.editReply({ content: `❌ ${err.message}` });
      }
      return;
    }

    // ── /music search ────────────────────────────────────────────────────────
    if (sub === 'search') {
      const query    = interaction.options.getString('query');
      const memberVC = interaction.member.voice?.channel;

      if (!memberVC) {
        return interaction.reply({ content: '❌ Join a voice channel, then use `/music play <URL>` to play a result.', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      try {
        const results = await music.search(query, 5);
        const lines   = results.map((r, i) =>
          `\`${i + 1}.\` **[${r.title}](${r.url})** \`${music.fmt(r.duration)}\` — ${r.author}`
        );
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor('#FF5500')
            .setTitle(`🔍 Results for "${query}"`)
            .setDescription(lines.join('\n') + '\n\n*Copy a URL above and use `/music play <url>` to play it!*')],
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ ${err.message}` });
      }
      return;
    }

    // ── Commands that need an active queue ───────────────────────────────────
    const queue    = music.getQueue(guildId);
    if (!queue) return interaction.reply({ content: '❌ Nothing is playing right now!', flags: 64 });

    const memberVC = interaction.member.voice?.channel;
    if (!memberVC || memberVC.id !== queue.voiceChannel.id) {
      return interaction.reply({ content: '❌ You need to be in the same voice channel to control music!', flags: 64 });
    }

    switch (sub) {

      // ── skip ──────────────────────────────────────────────────────────────
      case 'skip':
        queue.player.stop();
        await interaction.reply({ content: '⏭️ Skipped!', flags: 64 });
        break;

      // ── pause ─────────────────────────────────────────────────────────────
      case 'pause':
        if (queue.paused) return interaction.reply({ content: '❌ Already paused!', flags: 64 });
        queue.player.pause();
        queue.paused = true;
        await interaction.reply({ content: '⏸️ Paused.', flags: 64 });
        if (queue.nowPlayingMessage) {
          const e = music.buildNPEmbed(queue);
          if (e) queue.nowPlayingMessage.edit({ embeds: [e], components: music.buildControls(queue) }).catch(() => {});
        }
        break;

      // ── resume ────────────────────────────────────────────────────────────
      case 'resume':
        if (!queue.paused) return interaction.reply({ content: '❌ Not paused!', flags: 64 });
        queue.player.unpause();
        queue.paused = false;
        await interaction.reply({ content: '▶️ Resumed!', flags: 64 });
        if (queue.nowPlayingMessage) {
          const e = music.buildNPEmbed(queue);
          if (e) queue.nowPlayingMessage.edit({ embeds: [e], components: music.buildControls(queue) }).catch(() => {});
        }
        break;

      // ── stop ──────────────────────────────────────────────────────────────
      case 'stop':
        if (queue.nowPlayingMessage) {
          queue.nowPlayingMessage.edit({
            embeds:     [new EmbedBuilder().setColor('#e74c3c').setDescription('⏹️ Music stopped. Queue cleared.')],
            components: [],
          }).catch(() => {});
        }
        music.destroyQueue(guildId);
        await interaction.reply({ content: '⏹️ Stopped and cleared the queue!', flags: 64 });
        break;

      // ── queue ─────────────────────────────────────────────────────────────
      case 'queue':
        await interaction.reply({ embeds: [music.buildQueueEmbed(queue)], flags: 64 });
        break;

      // ── np ────────────────────────────────────────────────────────────────
      case 'np': {
        const embed = music.buildNPEmbed(queue);
        if (!embed) return interaction.reply({ content: '❌ Nothing is playing!', flags: 64 });
        await interaction.reply({ embeds: [embed], components: music.buildControls(queue) });
        break;
      }

      // ── volume ────────────────────────────────────────────────────────────
      case 'volume': {
        const level  = interaction.options.getInteger('level');
        queue.volume = level / 100;
        queue.resource?.volume?.setVolume(queue.volume);
        await interaction.reply({ content: `🔊 Volume set to **${level}%**`, flags: 64 });
        if (queue.nowPlayingMessage) {
          const e = music.buildNPEmbed(queue);
          if (e) queue.nowPlayingMessage.edit({ embeds: [e], components: music.buildControls(queue) }).catch(() => {});
        }
        break;
      }

      // ── shuffle ───────────────────────────────────────────────────────────
      case 'shuffle': {
        if (queue.songs.length <= 1) {
          return interaction.reply({ content: '❌ Need at least 2 songs to shuffle!', flags: 64 });
        }
        const [cur, ...rest] = queue.songs;
        queue.songs = [cur, ...rest.sort(() => Math.random() - 0.5)];
        await interaction.reply({ content: '🔀 Queue shuffled!', flags: 64 });
        break;
      }

      // ── loop ──────────────────────────────────────────────────────────────
      case 'loop': {
        const modes = ['off', 'song', 'queue'];
        queue.loop  = modes[(modes.indexOf(queue.loop) + 1) % modes.length];
        const icons = { off: '➡️', song: '🔂', queue: '🔁' };
        await interaction.reply({ content: `${icons[queue.loop]} Loop mode: **${queue.loop}**`, flags: 64 });
        if (queue.nowPlayingMessage) {
          const e = music.buildNPEmbed(queue);
          if (e) queue.nowPlayingMessage.edit({ embeds: [e], components: music.buildControls(queue) }).catch(() => {});
        }
        break;
      }

      case 'eq': {
        const preset = interaction.options.getString('preset');
        music.applyEq(queue, preset);
        await music.playSong(queue);
        await interaction.reply({ content: `🎚️ EQ set to **${music.EQ_PRESETS[preset].label}**. Current song restarts with the new mix.`, flags: 64 });
        break;
      }
    }
  },
};
