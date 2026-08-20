const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and server configuration'),

  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId);

    if (!settings?.staffRoleId) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('⚙️ Setup Required')
            .setDescription('This bot has not been configured yet. Run `/setup` to get started.')
            .setFooter({ text: 'Chilz Support Bot' }),
        ],
        flags: 64,
      });
    }

    const openTickets = client.db.getOpenTickets(interaction.guildId);
    const uptime = process.uptime();
    const uptimeStr = [
      Math.floor(uptime / 3600)  + 'h',
      Math.floor((uptime % 3600) / 60) + 'm',
      Math.floor(uptime % 60)    + 's',
    ].join(' ');

    const embed = new EmbedBuilder()
      .setColor('#00c851')
      .setTitle('✅ Chilz Bot Status')
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: '🤖 Bot',          value: client.user.tag,                       inline: true },
        { name: '📶 Ping',          value: `${client.ws.ping}ms`,                 inline: true },
        { name: '⏱️ Uptime',        value: uptimeStr,                             inline: true },

        { name: '​', value: '**── Configuration ──**', inline: false },
        { name: '🛡️ Staff Role',   value: `<@&${settings.staffRoleId}>`,          inline: true },
        { name: '👑 Owner Role',   value: `<@&${settings.ownerRoleId}>`,          inline: true },
        { name: '🏷️ Member Role',  value: settings.memberRoleId ? `<@&${settings.memberRoleId}>` : '*Not set*', inline: true },
        { name: '🎫 Ticket Channel', value: `<#${settings.ticketChannelId}>`,     inline: true },
        { name: '📋 Log Channel',  value: settings.logChannelId ? `<#${settings.logChannelId}>` : '*Not set*', inline: true },
        { name: '💬 Public Support', value: settings.publicSupportChannelId ? `<#${settings.publicSupportChannelId}>` : '*Not set*', inline: true },
        { name: '🎫 Open Tickets', value: `${openTickets.length}`,                inline: true },
      )
      .setFooter({ text: 'Chilz Support Bot' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
  },
};
