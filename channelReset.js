const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { isStaffMember } = require('./staffAccess');
function authorized(member, settings) {
  return isStaffMember(member, settings) || member.permissions.has(PermissionFlagsBits.ManageChannels);
}
async function recreateChannel({ interaction, channel }) {
  if (!channel?.guild || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return { error: 'Choose a standard text or announcement channel.' };
  if ([channel.guild.rulesChannelId, channel.guild.publicUpdatesChannelId, channel.guild.systemChannelId].includes(channel.id)) return { error: 'System, rules, and public-updates channels cannot be recreated.' };
  const clone = await channel.clone({ name: channel.name, parent: channel.parentId, permissionOverwrites: channel.permissionOverwrites.cache, position: channel.position });
  const settings = interaction.client.db.getGuildSettings(channel.guild.id);
  if (settings) { for (const key of Object.keys(settings)) if (settings[key] === channel.id) settings[key] = clone.id; interaction.client.db.saveData(); }
  await interaction.reply({ content: `✅ Recreated ${channel} as ${clone}.`, flags: 64 }).catch(() => {});
  await channel.delete('Channel recreated'); return { channel: clone };
}
module.exports = { authorized, recreateChannel };
