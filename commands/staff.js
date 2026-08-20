const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

/** Post an embed to the guild's log channel, if configured. */
async function postModLog(guild, settings, embed) {
  if (!settings?.logChannelId) return;
  const ch = await guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff')
    .setDescription('Staff moderation tools')

    .addSubcommand(s => s.setName('warn')
      .setDescription('Warn a user and log it to the database')
      .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for warning')))

    .addSubcommand(s => s.setName('kick')
      .setDescription('Kick a user from the server')
      .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for kick')))

    .addSubcommand(s => s.setName('ban')
      .setDescription('Ban a user from the server')
      .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for ban')))

    .addSubcommand(s => s.setName('forceban')
      .setDescription('Ban a user by ID — works even if they\'re not in the server')
      .addStringOption(o => o.setName('user_id').setDescription('Discord user ID (right-click → Copy ID)').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for ban')))

    .addSubcommand(s => s.setName('mute')
      .setDescription('Timeout (mute) a user using Discord\'s native timeout')
      .addUserOption(o => o.setName('user').setDescription('User to mute').setRequired(true))
      .addIntegerOption(o => o.setName('duration')
        .setDescription('Duration in minutes (default: 60, max: 40 320 = 28 days)')
        .setMinValue(1).setMaxValue(40320))
      .addStringOption(o => o.setName('reason').setDescription('Reason for mute')))

    .addSubcommand(s => s.setName('unmute')
      .setDescription('Remove a timeout from a user')
      .addUserOption(o => o.setName('user').setDescription('User to unmute').setRequired(true)))

    .addSubcommand(s => s.setName('warnings')
      .setDescription('View all warnings for a user')
      .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)))

    .addSubcommand(s => s.setName('clearwarn')
      .setDescription('Clear a specific warning (or all warnings) from a user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('warn_id').setDescription('Warning ID to remove — omit to clear ALL warnings')))

    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction, client) {
    const settings  = client.db.getGuildSettings(interaction.guildId);
    const isStaff   = settings?.staffRoleId && interaction.member.roles.cache.has(settings.staffRoleId);
    const isOwner   = settings?.ownerRoleId && interaction.member.roles.cache.has(settings.ownerRoleId);

    if (!isStaff && !isOwner) {
      return interaction.reply({ content: '❌ You do not have permission to use staff commands.', flags: 64 });
    }

    await interaction.deferReply();

    const sub        = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser('user');
    const reason     = interaction.options.getString('reason') || 'No reason provided';

    // ── /staff forceban (no @mention needed — handled separately) ────────
    if (sub === 'forceban') {
      const userId     = interaction.options.getString('user_id').trim();
      const banReason  = interaction.options.getString('reason') || 'No reason provided';

      // Validate it looks like a Snowflake
      if (!/^\d{17,20}$/.test(userId)) {
        return interaction.editReply({ content: '❌ That doesn\'t look like a valid Discord user ID. Right-click a user → Copy ID.' });
      }

      // Try to fetch user info so we can show their tag in the embed
      const fetchedUser = await client.users.fetch(userId).catch(() => null);
      const displayName = fetchedUser ? `${fetchedUser.username} \`${userId}\`` : `Unknown User \`${userId}\``;
      const avatar      = fetchedUser?.displayAvatarURL() || null;

      // Check if already banned
      const existingBan = await interaction.guild.bans.fetch(userId).catch(() => null);
      if (existingBan) {
        return interaction.editReply({ content: `❌ \`${userId}\` is already banned from this server.` });
      }

      await interaction.guild.bans.create(userId, { reason: banReason, deleteMessageSeconds: 86400 }).catch(err => {
        return interaction.editReply({ content: `❌ Failed to ban: ${err.message}` });
      });

      const embed = new EmbedBuilder()
        .setColor('#cc0000')
        .setTitle('🔨 User Force-Banned')
        .setThumbnail(avatar)
        .addFields(
          { name: 'User',   value: displayName, inline: true },
          { name: 'Reason', value: banReason },
        )
        .setTimestamp()
        .setFooter({ text: `Moderator: ${interaction.user.tag}` });

      client.db.addModLog(interaction.guildId, { action: 'FORCEBAN', targetId: userId, moderatorId: interaction.user.id, reason: banReason });
      await interaction.editReply({ embeds: [embed] });
      await postModLog(interaction.guild, settings, embed);
      return;
    }

    // Fetch guild member (not needed for warnings/clearwarn lookup-only)
    const needsMember = !['warnings', 'clearwarn'].includes(sub);
    const targetMember = needsMember
      ? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
      : null;

    if (needsMember && !targetMember) {
      return interaction.editReply({ content: '❌ That user was not found in this server.' });
    }

    const embed = new EmbedBuilder()
      .setTimestamp()
      .setFooter({ text: `Moderator: ${interaction.user.tag}` });

    // ── /staff warn ───────────────────────────────────────────────────
    if (sub === 'warn') {
      const warning    = client.db.addWarning(interaction.guildId, targetUser.id, reason, interaction.user.id);
      const totalWarns = client.db.getWarnings(interaction.guildId, targetUser.id).length;

      embed.setColor('#ff9900').setTitle('⚠️ User Warned').addFields(
        { name: 'User',            value: `${targetUser} \`${targetUser.tag}\``, inline: true },
        { name: 'Total Warnings',  value: `${totalWarns}`,                       inline: true },
        { name: 'Warning ID',      value: `\`${warning.id}\``,                  inline: true },
        { name: 'Reason',          value: reason },
      );

      client.db.addModLog(interaction.guildId, { action: 'WARN', targetId: targetUser.id, moderatorId: interaction.user.id, reason });
      await interaction.editReply({ embeds: [embed] });
      await postModLog(interaction.guild, settings, embed);
      await targetUser.send(
        `⚠️ You have been **warned** in **${interaction.guild.name}**\n` +
        `**Reason:** ${reason}\n**Total warnings:** ${totalWarns}`
      ).catch(() => {});
    }

    // ── /staff kick ───────────────────────────────────────────────────
    else if (sub === 'kick') {
      await targetMember.kick(reason).catch(err => {
        return interaction.editReply({ content: `❌ Failed to kick: ${err.message}` });
      });
      embed.setColor('#ff4500').setTitle('👢 User Kicked').addFields(
        { name: 'User',   value: `${targetUser} \`${targetUser.tag}\``, inline: true },
        { name: 'Reason', value: reason },
      );
      client.db.addModLog(interaction.guildId, { action: 'KICK', targetId: targetUser.id, moderatorId: interaction.user.id, reason });
      await interaction.editReply({ embeds: [embed] });
      await postModLog(interaction.guild, settings, embed);
    }

    // ── /staff ban ────────────────────────────────────────────────────
    else if (sub === 'ban') {
      await interaction.guild.members.ban(targetUser.id, { reason, deleteMessageSeconds: 86400 }).catch(err => {
        return interaction.editReply({ content: `❌ Failed to ban: ${err.message}` });
      });
      embed.setColor('#cc0000').setTitle('🔨 User Banned').addFields(
        { name: 'User',   value: `${targetUser} \`${targetUser.tag}\``, inline: true },
        { name: 'Reason', value: reason },
      );
      client.db.addModLog(interaction.guildId, { action: 'BAN', targetId: targetUser.id, moderatorId: interaction.user.id, reason });
      await interaction.editReply({ embeds: [embed] });
      await postModLog(interaction.guild, settings, embed);
    }

    // ── /staff mute ───────────────────────────────────────────────────
    else if (sub === 'mute') {
      const minutes = interaction.options.getInteger('duration') || 60;
      await targetMember.timeout(minutes * 60_000, reason).catch(err => {
        return interaction.editReply({ content: `❌ Failed to timeout: ${err.message}` });
      });
      embed.setColor('#9b59b6').setTitle('🔇 User Muted (Timeout)').addFields(
        { name: 'User',     value: `${targetUser} \`${targetUser.tag}\``,        inline: true },
        { name: 'Duration', value: `${minutes} minute${minutes !== 1 ? 's' : ''}`, inline: true },
        { name: 'Reason',   value: reason },
      );
      client.db.addModLog(interaction.guildId, { action: 'MUTE', targetId: targetUser.id, moderatorId: interaction.user.id, reason, duration: minutes });
      await interaction.editReply({ embeds: [embed] });
      await postModLog(interaction.guild, settings, embed);
    }

    // ── /staff unmute ─────────────────────────────────────────────────
    else if (sub === 'unmute') {
      await targetMember.timeout(null).catch(err => {
        return interaction.editReply({ content: `❌ Failed to remove timeout: ${err.message}` });
      });
      embed.setColor('#2ecc71').setTitle('🔊 Timeout Removed').addFields(
        { name: 'User', value: `${targetUser} \`${targetUser.tag}\``, inline: true },
      );
      client.db.addModLog(interaction.guildId, { action: 'UNMUTE', targetId: targetUser.id, moderatorId: interaction.user.id, reason: 'Manual unmute' });
      await interaction.editReply({ embeds: [embed] });
      await postModLog(interaction.guild, settings, embed);
    }

    // ── /staff warnings ───────────────────────────────────────────────
    else if (sub === 'warnings') {
      const warns = client.db.getWarnings(interaction.guildId, targetUser.id);
      embed
        .setColor('#ff9900')
        .setTitle(`⚠️ Warnings for ${targetUser.tag}`)
        .setThumbnail(targetUser.displayAvatarURL());

      if (warns.length === 0) {
        embed.setDescription('This user has no warnings. ✅');
      } else {
        embed.setDescription(`**${warns.length}** total warning(s). Showing last 10:`);
        for (const w of warns.slice(-10)) {
          embed.addFields({
            name:  `ID \`${w.id}\``,
            value: `**Reason:** ${w.reason}\n**By:** <@${w.moderatorId}> • <t:${Math.floor(w.createdAt / 1000)}:R>`,
          });
        }
      }
      await interaction.editReply({ embeds: [embed] });
    }

    // ── /staff clearwarn ──────────────────────────────────────────────
    else if (sub === 'clearwarn') {
      const warnId = interaction.options.getString('warn_id');
      embed.setColor('#2ecc71');

      if (warnId) {
        const removed = client.db.removeWarning(interaction.guildId, targetUser.id, parseInt(warnId));
        embed.setTitle('✅ Warning Removed')
          .setDescription(removed
            ? `Warning \`${warnId}\` removed from ${targetUser}.`
            : `❌ Warning \`${warnId}\` not found for that user.`
          );
      } else {
        const count = client.db.clearWarnings(interaction.guildId, targetUser.id);
        embed.setTitle('✅ All Warnings Cleared')
          .setDescription(`Cleared **${count}** warning(s) from ${targetUser}.`);
      }
      await interaction.editReply({ embeds: [embed] });
    }
  },
};
