const {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const features = require('../features');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure Chilz for your server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('staff_role').setDescription('Staff / moderator role').setRequired(true))
    .addRoleOption(o => o.setName('owner_role').setDescription('Owner / admin role').setRequired(true))
    .addStringOption(o => o.setName('profile').setDescription('Which parts of the bot this server uses').addChoices(
      { name: 'everything (music, tickets, AI, moderation)', value: 'full' },
      { name: 'moderation only (AutoMod + anti-scam)',       value: 'moderation' },
    ).setRequired(false))
    .addChannelOption(o => o.setName('ticket_channel').setDescription('Channel to post the ticket panel — not needed for moderation only').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('log_channel').setDescription('Mod-log channel for staff actions').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addRoleOption(o => o.setName('member_role').setDescription('Default member role').setRequired(false))
    .addChannelOption(o => o.setName('public_support_channel').setDescription('Public support / help channel').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('bait_channel').setDescription('Optional honeypot channel; messages trigger review and a warning').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('ai_support_channel').setDescription('Optional channel where the AI answers support questions').addChannelTypes(ChannelType.GuildText).setRequired(false)),

  async execute(interaction, client) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Only administrators can run `/setup`.', flags: 64 });
    }

    await interaction.deferReply({ ephemeral: true });

    const staffRole    = interaction.options.getRole('staff_role');
    const ownerRole    = interaction.options.getRole('owner_role');
    const memberRole   = interaction.options.getRole('member_role');
    const ticketCh     = interaction.options.getChannel('ticket_channel');
    const logCh        = interaction.options.getChannel('log_channel');
    const publicCh     = interaction.options.getChannel('public_support_channel');
    const baitCh       = interaction.options.getChannel('bait_channel');
    const aiCh         = interaction.options.getChannel('ai_support_channel');
    const prev         = client.db.getGuildSettings(interaction.guildId) || {};
    const profile      = interaction.options.getString('profile') || features.profileOf(prev);
    const wantsTickets = features.has({ profile }, 'tickets');

    client.db.updateGuildSettings(interaction.guildId, {
      staffRoleId:           staffRole.id,
      ownerRoleId:           ownerRole.id,
      memberRoleId:          memberRole?.id  || null,
      ticketChannelId:       ticketCh?.id    || prev.ticketChannelId || null,
      logChannelId:          logCh?.id       || null,
      publicSupportChannelId:publicCh?.id    || null,
      honeypotChannelId:      baitCh?.id      || null,
      aiSupportChannelId:     aiCh?.id || prev.aiSupportChannelId || null,
      profile,
    });

    // The command list is per-guild, so a profile change has to be pushed now or
    // the server keeps showing whatever it had until the next restart.
    if (features.profileOf(prev) !== profile) {
      const payloads = client.commands.map(c => c.data.toJSON());
      await interaction.guild.commands.set(features.commandsFor({ profile }, payloads))
        .catch(err => console.error('[Setup] command refresh failed:', err.message));
    }

    // ── Post ticket panel ─────────────────────────────────────────────
    if (wantsTickets && ticketCh) {
      const ticketEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎫 Support Tickets')
        .setDescription(
          'Need help from staff? Click **Create Ticket** below to open a private support channel.\n\n' +
          'Our team will respond as soon as possible.'
        )
        .setThumbnail(interaction.guild.iconURL())
        .setFooter({ text: 'Chilz Support System' });

      const ticketRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('create_ticket')
          .setLabel('Create Ticket')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎫'),
      );

      await ticketCh.send({ embeds: [ticketEmbed], components: [ticketRow] });
    }

    // ── Confirmation ──────────────────────────────────────────────────
    const confirmEmbed = new EmbedBuilder()
      .setColor('#00c851')
      .setTitle('✅ Setup Complete')
      .addFields(
        { name: '🧩 Profile',      value: profile === 'moderation' ? 'Moderation only' : 'Everything', inline: true },
        { name: '🛡️ Staff Role',   value: `${staffRole}`,                         inline: true },
        { name: '👑 Owner Role',   value: `${ownerRole}`,                         inline: true },
        { name: '🏷️ Member Role',  value: memberRole    ? `${memberRole}` : '*Not set*',  inline: true },
        { name: '📋 Log Channel',  value: logCh         ? `${logCh}` : '*Not set*',      inline: true },
        { name: '🪤 Bait Channel', value: baitCh ? `${baitCh}` : '*Not set*', inline: true },
        ...(wantsTickets ? [
          { name: '🎫 Ticket Channel', value: ticketCh ? `${ticketCh}` : '*Not set*', inline: true },
          { name: '💬 Public Support', value: publicCh ? `${publicCh}` : '*Not set*', inline: true },
          { name: '🤖 AI Support', value: (aiCh || prev.aiSupportChannelId) ? `${aiCh || `<#${prev.aiSupportChannelId}>`}` : '*Not set*', inline: true },
        ] : [
          { name: 'Turned off here', value: 'Music, tickets and AI support are not registered in this server.' },
        ]),
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [confirmEmbed] });
  },
};
