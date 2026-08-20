const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { isStaffMember } = require('../staffAccess');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user from this server')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the unban').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction, client) {
    const member = interaction.member;
    const settings = client.db.getGuildSettings(interaction.guildId);
    const staff = isStaffMember(member, settings) || member?.permissions?.has(PermissionFlagsBits.BanMembers);
    if (!staff) return interaction.reply({ content: 'Only staff can use `/unban`.', flags: 64 });

    const userId = interaction.options.getString('user_id', true).trim();
    if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content: 'That is not a valid Discord user ID.', flags: 64 });
    const reason = interaction.options.getString('reason') || `Unbanned by ${interaction.user.tag}`;
    try {
      await interaction.guild.members.unban(userId, reason);
      client.db.clearAutoModTempBan(interaction.guildId, userId);
      return interaction.reply({ content: `✅ <@${userId}> was unbanned.`, flags: 64 });
    } catch (err) {
      if (err.code === 10026 || /unknown ban/i.test(err.message)) return interaction.reply({ content: 'That user is not currently banned (or the ID was not found).', flags: 64 });
      console.error('[Unban]', err.message);
      return interaction.reply({ content: 'I could not complete the unban. Check my Ban Members permission and the user ID.', flags: 64 });
    }
  },
};
