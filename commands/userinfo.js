const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Show information about a user')
    .addUserOption(o => o.setName('user').setDescription('User to inspect (defaults to yourself)')),

  async execute(interaction, client) {
    const target  = interaction.options.getUser('user') || interaction.user;
    const member  = await interaction.guild.members.fetch(target.id).catch(() => null);
    const warns   = client.db.getWarnings(interaction.guildId, target.id);

    const embed = new EmbedBuilder()
      .setColor(member?.displayHexColor || '#5865F2')
      .setTitle(target.username + (target.bot ? ' 🤖' : ''))
      .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: '🪪 User',           value: `${target} \`${target.id}\``,                                 inline: false },
        { name: '📅 Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:F>`,       inline: true  },
      );

    if (member) {
      const roles = member.roles.cache
        .filter(r => r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `${r}`)
        .join(' ');

      embed.addFields(
        { name: '📥 Joined Server',  value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`,        inline: true  },
        { name: '🎭 Nickname',        value: member.nickname || '*None*',                                  inline: true  },
        { name: `🏷️ Roles (${member.roles.cache.size - 1})`,
          value: roles.slice(0, 1024) || '*None*',                                                          inline: false },
        { name: '⚠️ Warnings',        value: `${warns.length}`,                                           inline: true  },
      );

      if (member.isCommunicationDisabled()) {
        embed.addFields({
          name: '🔇 Timed Out Until',
          value: `<t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:R>`,
          inline: true,
        });
      }

      if (member.premiumSinceTimestamp) {
        embed.addFields({
          name: '💎 Boosting Since',
          value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>`,
          inline: true,
        });
      }
    }

    embed
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
  },
};
