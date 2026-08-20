const {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket management')

    .addSubcommand(s => s.setName('close')
      .setDescription('Close the current ticket channel'))

    .addSubcommand(s => s.setName('add')
      .setDescription('Add a user to this ticket')
      .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)))

    .addSubcommand(s => s.setName('remove')
      .setDescription('Remove a user from this ticket')
      .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)))

    .addSubcommand(s => s.setName('list')
      .setDescription('List all open tickets in this server')),

  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId);
    if (!settings) return interaction.reply({ content: '❌ Bot not setup. Use `/setup` first.', flags: 64 });

    const sub     = interaction.options.getSubcommand();
    const isStaff = settings.staffRoleId && interaction.member.roles.cache.has(settings.staffRoleId);
    const isOwner = settings.ownerRoleId && interaction.member.roles.cache.has(settings.ownerRoleId);

    // ── /ticket list ──────────────────────────────────────────────────
    if (sub === 'list') {
      if (!isStaff && !isOwner) {
        return interaction.reply({ content: '❌ Only staff can list tickets.', flags: 64 });
      }
      const open = client.db.getOpenTickets(interaction.guildId);
      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(`🎫 Open Tickets (${open.length})`)
        .setTimestamp();

      if (open.length === 0) {
        embed.setDescription('No open tickets. 🎉');
      } else {
        for (const t of open.slice(0, 25)) {
          embed.addFields({
            name:  `\`${t.id}\``,
            value: `Owner: <@${t.userId}> • Channel: <#${t.channelId}> • <t:${Math.floor(t.createdAt / 1000)}:R>`,
          });
        }
        if (open.length > 25) embed.setFooter({ text: `...and ${open.length - 25} more` });
      }
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // ── All other subcommands require a ticket channel ─────────────────
    const ticket = client.db.getTicketByChannelId(interaction.guildId, interaction.channelId);
    if (!ticket) {
      return interaction.reply({ content: '❌ This channel is not a ticket.', flags: 64 });
    }

    // ── /ticket close ─────────────────────────────────────────────────
    if (sub === 'close') {
      if (!isStaff && !isOwner) {
        return interaction.reply({ content: '❌ Only staff can close tickets.', flags: 64 });
      }
      client.db.closeTicket(interaction.guildId, ticket.id);
      const embed = new EmbedBuilder()
        .setColor('#ff4444')
        .setTitle('🔒 Ticket Closed')
        .setDescription(`Closed by ${interaction.user}\nChannel will be deleted in **5 seconds**.`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }

    // ── /ticket add ───────────────────────────────────────────────────
    else if (sub === 'add') {
      if (!isStaff && !isOwner) return interaction.reply({ content: '❌ Only staff can add users.', flags: 64 });
      const user = interaction.options.getUser('user');
      await interaction.channel.permissionOverwrites.create(user, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
      });
      await interaction.reply({ content: `✅ Added ${user} to the ticket.`, flags: 64 });
    }

    // ── /ticket remove ────────────────────────────────────────────────
    else if (sub === 'remove') {
      if (!isStaff && !isOwner) return interaction.reply({ content: '❌ Only staff can remove users.', flags: 64 });
      const user = interaction.options.getUser('user');
      if (user.id === ticket.userId) {
        return interaction.reply({ content: '❌ Cannot remove the ticket creator.', flags: 64 });
      }
      await interaction.channel.permissionOverwrites.delete(user).catch(() => {});
      await interaction.reply({ content: `✅ Removed ${user} from the ticket.`, flags: 64 });
    }
  },
};

async function createSupportTicket(guild, user, client, { issue = '', pauseAI = false } = {}) {
  const settings = client.db.getGuildSettings(guild.id);
  if (!settings) throw new Error('Bot not setup.');
  const openTickets = client.db.getUserTickets(guild.id, user.id);
  if (openTickets.length >= 3) throw new Error(`You already have ${openTickets.length} open ticket(s). Please wait for them to be closed.`);

  const ticketId = `ticket-${Date.now()}`;
  const perms = [
    { id: guild.id, deny: ['ViewChannel'] },
    { id: user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
  ];
  if (settings.staffRoleId) perms.push({ id: settings.staffRoleId, allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ReadMessageHistory'] });
  if (settings.ownerRoleId) perms.push({ id: settings.ownerRoleId, allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ReadMessageHistory'] });

  const channel = await guild.channels.create({
    name: ticketId,
    type: ChannelType.GuildText,
    permissionOverwrites: perms,
  });

  const ticket = client.db.createTicket(guild.id, user.id, channel.id, { topic: issue.slice(0, 200) });
  if (pauseAI) client.db.pauseTicketAI(guild.id, channel.id);

  const fields = [{ name: 'Ticket ID', value: `\`${ticket.id}\``, inline: true }];
  if (issue) fields.push({ name: 'Original issue', value: issue.slice(0, 1000) });

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎫 Support Ticket')
    .setDescription(
      pauseAI
        ? `Created by ${user}\n\nStaff: the member asked AI support for help. AI replies are paused in this ticket.`
        : `Created by ${user}\n\nPlease describe your issue in detail and a staff member will be with you shortly.`
    )
    .addFields(fields)
    .setThumbnail(user.displayAvatarURL())
    .setTimestamp()
    .setFooter({ text: 'Chilz Support' });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
  const ping = settings.staffRoleId ? `<@&${settings.staffRoleId}>` : '';
  await channel.send({ content: ping || undefined, embeds: [embed], components: [closeRow] });
  return channel;
}

async function handleCreateTicket(interaction) {
  const client = interaction.client;
  const settings = client.db.getGuildSettings(interaction.guildId);
  if (!settings) return interaction.reply({ content: '❌ Bot not setup.', flags: 64 });
  try {
    const channel = await createSupportTicket(interaction.guild, interaction.user, client);
    await interaction.reply({ content: `✅ Your ticket has been created: ${channel}`, flags: 64 });
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, flags: 64 }).catch(() => {});
  }
}

module.exports.handleCreateTicket = handleCreateTicket;
module.exports.createSupportTicket = createSupportTicket;
