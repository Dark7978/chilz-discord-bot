const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const ACTION_EMOJIS = {
  WARN:   '⚠️',
  KICK:   '👢',
  BAN:    '🔨',
  MUTE:   '🔇',
  UNMUTE: '🔊',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modlogs')
    .setDescription('View moderation history for a user')
    .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId);
    const isStaff  = settings?.staffRoleId && interaction.member.roles.cache.has(settings.staffRoleId);
    const isOwner  = settings?.ownerRoleId && interaction.member.roles.cache.has(settings.ownerRoleId);

    if (!isStaff && !isOwner) {
      return interaction.reply({ content: '❌ You do not have permission to view mod logs.', flags: 64 });
    }

    const target = interaction.options.getUser('user');
    const logs   = client.db.getModLogs(interaction.guildId, target.id);

    const embed = new EmbedBuilder()
      .setColor('#ff6b6b')
      .setTitle(`📋 Mod Logs — ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setTimestamp()
      .setFooter({ text: `User ID: ${target.id}` });

    if (logs.length === 0) {
      embed.setDescription('No moderation history found for this user. ✅');
    } else {
      embed.setDescription(`**${logs.length}** total action(s). Showing last 10:`);
      for (const log of logs.slice(-10).reverse()) {
        const emoji = ACTION_EMOJIS[log.action] || '🔹';
        const dura  = log.duration ? ` (${log.duration}m)` : '';
        embed.addFields({
          name:  `${emoji} ${log.action}${dura} — <t:${Math.floor(log.createdAt / 1000)}:R>`,
          value: `**Reason:** ${log.reason}\n**By:** <@${log.moderatorId}>`,
        });
      }
    }

    await interaction.reply({ embeds: [embed], flags: 64 });
  },
};
