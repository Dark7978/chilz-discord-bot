const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const features = require('../features');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),

  async execute(interaction, client) {
    // Only list what this server actually has, so a moderation-only server is not
    // told about commands it cannot run.
    const settings = client.db.getGuildSettings(interaction.guildId);
    const show = feature => features.has(settings, feature);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📚 Chilz Bot — Commands')
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        {
          name: '⚙️ Admin',
          value: [
            '`/setup` — Configure the bot (staff role, ticket channel, log channel, bait channel, etc.)',
            '`/status` — Show bot status and current server configuration',
          ].join('\n'),
        },
        {
          name: '🛡️ Staff (requires staff / owner role)',
          value: [
            '`/clear <amount> [@user]` — Bulk-delete up to 300 messages (optionally filter by user)',
            '`/staff warn @user [reason]` — Warn a user (saved to database)',
            '`/staff kick @user [reason]` — Kick a user',
            '`/staff ban @user [reason]` — Ban a user',
            '`/staff forceban <user_id> [reason]` — Ban someone not in the server by their ID',
            '`/staff mute @user [minutes] [reason]` — Timeout a user (Discord native)',
            '`/staff unmute @user` — Remove a timeout',
            '`/staff warnings @user` — View all warnings for a user',
            '`/staff clearwarn @user [warn_id]` — Remove a warning (or all if no ID given)',
            '`/modlogs @user` — Full moderation history for a user',
            '`/scan` — Sweep message history for scam posts the live filter never saw',
            '`/antiscam` — Anti-scam settings, strikes, and OCR toggle',
          ].join('\n'),
        },
        ...(show('tickets') ? [{
          name: '🎫 Tickets',
          value: [
            '`/ticket close` — Close the current ticket channel',
            '`/ticket add @user` — Add a user to the ticket',
            '`/ticket remove @user` — Remove a user from the ticket',
            '`/ticket list` — List all open tickets (staff only)',
          ].join('\n'),
        }] : []),
        {
          name: '👤 General',
          value: [
            '`/userinfo [@user]` — Show info about a user (account age, roles, warnings, timeout)',
            '`/help` — Show this message',
          ].join('\n'),
        },
        ...(show('music') ? [{
          name: '🎵 Music (must be in a voice channel)',
          value: [
            '`/music play <query>` — Search by name, YouTube URL, SoundCloud link, Spotify track/album/playlist, or Deezer link',
            '`/music search <query>` — See top 5 results before picking',
            '`/music skip` — Skip the current song',
            '`/music pause` / `/music resume` — Pause / resume',
            '`/music stop` — Stop and clear queue',
            '`/music queue` — Show the queue',
            '`/music np` — Show now-playing embed with controls',
            '`/music volume <1-100>` — Set volume',
            '`/music eq <Clean|Bass|Vocal|Treble|Punch>` — Equalizer (also a button on now-playing)',
            '`/music shuffle` — Shuffle the queue',
            '`/music loop` — Cycle loop: off → song → queue',
            '**Buttons on the now-playing embed:** ⏮ Prev · ⏸ Pause · ⏭ Skip · ⏹ Stop · 📋 Queue · 🔀 Shuffle · 🔁 Loop · 🔉/🔊 Volume · 🎚️ EQ',
          ].join('\n'),
        }] : []),
        {
          name: '🎫 Recreate',
          value: '`/recreate_channel` — Staff-only: recreate the current channel (separate from `/clear`).',
        },
      )
      .setFooter({ text: 'Chilz Support Bot • discord.js v14' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
  },
};
