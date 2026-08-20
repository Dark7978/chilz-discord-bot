const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { isStaffMember } = require('../staffAccess');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  data: new SlashCommandBuilder().setName('clear').setDescription('Delete messages from this channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName('amount').setDescription('Messages to delete (1-300)').setRequired(true).setMinValue(1).setMaxValue(300))
    .addUserOption(o => o.setName('user').setDescription('Optional author filter')),
  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId);
    const allowed = isStaffMember(interaction.member, settings);
    if (!allowed) return interaction.reply({ content: 'Staff only.', flags: 64 });
    await interaction.deferReply({ flags: 64 });
    const amount = interaction.options.getInteger('amount', true); const user = interaction.options.getUser('user');
    const messages = []; let before; let pages = 0;
    while (messages.length < amount && pages++ < 30) {
      const page = await Promise.race([
        interaction.channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Message history fetch timed out')), 8000)),
      ]);
      if (!page.size) break;
      for (const m of page.values()) if (!m.pinned && (!user || m.author.id === user.id)) messages.push(m);
      before = page.last().id;
    }
    let deleted = 0; let failed = 0; const cutoff = Date.now() - 14 * 24 * 60 * 60_000;
    const recent = messages.filter(m => m.createdTimestamp > cutoff);
    for (let i = 0; i < recent.length; i += 100) {
      const batch = recent.slice(i, i + 100);
      try { deleted += (await interaction.channel.bulkDelete(batch, true)).size; }
      catch (err) {
        console.error('[clear] recent bulk delete failed; falling back for this batch:', err.message);
        for (const m of batch) { try { await m.delete(); deleted++; } catch { failed++; } }
      }
    }
    for (const m of messages.filter(m => m.createdTimestamp <= cutoff)) { try { await m.delete(); deleted++; } catch { failed++; } await sleep(250); }
    return interaction.editReply({ content: `Cleared ${deleted} message(s). Failed: ${failed}. Requested: ${amount}. Pages scanned: ${pages - 1}.` });
  },
};
