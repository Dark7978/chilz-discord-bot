// ── Ban Appeal System ────────────────────────────────────────────────────────
// When the anti-scam system BANS someone (after hitting the strike limit), we DM
// them a "Submit Appeal" button. The whole flow happens in the bot's DM channel,
// so it works even though a banned user can't see the server:
//
//   1. Bot DMs the banned user  →  [Submit Appeal] button
//   2. User clicks              →  modal asks "why should we unban you?"
//   3. User submits             →  appeal posted to staff appeal channel with
//                                   [Approve] / [Deny] buttons
//   4. Staff clicks Approve     →  user is unbanned + DM'd (with a fresh invite)
//      Staff clicks Deny        →  user is DM'd that it was denied
//
// customId formats (guildId + userId travel inside the button so we don't need
// to remember any per-interaction state):
//   appeal_open:<guildId>
//   appeal_modal:<guildId>
//   appeal_approve:<guildId>:<userId>
//   appeal_deny:<guildId>:<userId>

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
} = require('discord.js');

/** DM a freshly-banned user the appeal offer. Call right after the ban. */
async function sendAppealOffer(client, guild, user, reason) {
  try {
    const embed = new EmbedBuilder()
      .setColor('#cc0000')
      .setTitle(`🔨 You were banned from ${guild.name}`)
      .setDescription(
        `You were automatically banned for repeatedly posting content flagged as **scam/spam**.\n\n` +
        `**Reason:** ${reason || 'scam / spam'}\n\n` +
        `If you believe this was a mistake, you can submit **one** appeal below and the staff team will review it.`
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`appeal_open:${guild.id}`)
        .setLabel('Submit Appeal')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📩'),
    );

    await user.send({ embeds: [embed], components: [row] });
    return true;
  } catch {
    return false;   // user has DMs closed — nothing we can do
  }
}

/** User clicked "Submit Appeal" in their DM → open the modal. */
async function handleOpenButton(interaction, client) {
  const guildId = interaction.customId.split(':')[1];
  const appeal  = client.db.getAppeal(guildId, interaction.user.id);

  if (!appeal) {
    return interaction.reply({ content: '❌ No ban record found for you (it may have expired).', flags: 64 });
  }
  if (appeal.status === 'pending') {
    return interaction.reply({ content: '⏳ You already have an appeal awaiting staff review.', flags: 64 });
  }
  if (appeal.status === 'approved') {
    return interaction.reply({ content: '✅ Your appeal was already approved — you can rejoin.', flags: 64 });
  }
  if (appeal.status === 'denied') {
    return interaction.reply({ content: '❌ Your appeal was already reviewed and denied.', flags: 64 });
  }

  const modal = new ModalBuilder()
    .setCustomId(`appeal_modal:${guildId}`)
    .setTitle('Ban Appeal');

  const input = new TextInputBuilder()
    .setCustomId('appeal_reason')
    .setLabel('Why should you be unbanned?')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(15)
    .setMaxLength(900)
    .setPlaceholder('Explain what happened. Be honest — staff can see what was posted.')
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

/** User submitted the appeal modal → post it to the staff appeal channel. */
async function handleModalSubmit(interaction, client) {
  const guildId = interaction.customId.split(':')[1];
  const guild   = await client.guilds.fetch(guildId).catch(() => null);
  const appeal  = client.db.getAppeal(guildId, interaction.user.id);

  if (!guild || !appeal) {
    return interaction.reply({ content: '❌ Could not find your ban record.', flags: 64 });
  }
  if (appeal.status === 'pending') {
    return interaction.reply({ content: '⏳ Your appeal is already awaiting review.', flags: 64 });
  }

  const text = interaction.fields.getTextInputValue('appeal_reason');
  client.db.updateAppeal(guildId, interaction.user.id, {
    status: 'pending', appealText: text, appealedAt: Date.now(),
  });

  const settings = client.db.getGuildSettings(guildId);
  const chId = settings?.appealChannelId || settings?.antiScamAlertChannelId || settings?.logChannelId;
  const ch   = chId ? await guild.channels.fetch(chId).catch(() => null) : null;

  if (!ch) {
    // No review channel configured — still record it, but tell the user.
    return interaction.reply({
      content: '✅ Appeal submitted. (Note: staff have not set an appeal channel yet, so review may be delayed.)',
      flags: 64,
    });
  }

  const embed = new EmbedBuilder()
    .setColor('#f1c40f')
    .setTitle('📩 New Ban Appeal')
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      { name: 'User',       value: `${interaction.user} \`${interaction.user.tag}\` (${interaction.user.id})` },
      { name: 'Ban reason', value: appeal.banReason || 'scam / spam' },
      { name: 'Appeal',     value: text.slice(0, 1000) },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal_approve:${guildId}:${interaction.user.id}`)
      .setLabel('Approve (Unban)').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`appeal_deny:${guildId}:${interaction.user.id}`)
      .setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('⛔'),
  );

  await ch.send({ embeds: [embed], components: [row] }).catch(() => {});
  await interaction.reply({ content: '✅ Your appeal was submitted to the staff team. You will be notified of the decision.', flags: 64 });
}

/** Staff clicked Approve or Deny in the appeal channel. */
async function handleDecisionButton(interaction, client) {
  const [action, guildId, userId] = interaction.customId.split(':');
  const guild = interaction.guild;

  // Permission gate — staff role, owner role, or Ban Members.
  const settings = client.db.getGuildSettings(guildId);
  const isStaff  = settings?.staffRoleId && interaction.member.roles.cache.has(settings.staffRoleId);
  const isOwner  = settings?.ownerRoleId && interaction.member.roles.cache.has(settings.ownerRoleId);
  const canBan   = interaction.member.permissions.has(PermissionFlagsBits.BanMembers);
  if (!isStaff && !isOwner && !canBan) {
    return interaction.reply({ content: '❌ Only staff can decide appeals.', flags: 64 });
  }

  const appeal = client.db.getAppeal(guildId, userId);
  if (!appeal) {
    return interaction.reply({ content: '❌ Appeal record not found.', flags: 64 });
  }
  if (appeal.status === 'approved' || appeal.status === 'denied') {
    return interaction.reply({ content: `❌ Already ${appeal.status} by <@${appeal.resolvedBy}>.`, flags: 64 });
  }

  const user = await client.users.fetch(userId).catch(() => null);

  if (action === 'appeal_approve') {
    await guild.bans.remove(userId, `Appeal approved by ${interaction.user.tag}`).catch(() => {});
    client.db.updateAppeal(guildId, userId, { status: 'approved', resolvedAt: Date.now(), resolvedBy: interaction.user.id });
    client.db.clearStrikes(guildId, userId);

    // Try to DM a fresh invite so they can actually return.
    let inviteUrl = null;
    try {
      const channel = guild.systemChannel
        || guild.channels.cache.find(c => c.isTextBased?.() && c.permissionsFor(guild.members.me).has('CreateInstantInvite'));
      if (channel) {
        const inv = await channel.createInvite({ maxAge: 86400, maxUses: 1, unique: true, reason: 'Ban appeal approved' });
        inviteUrl = inv.url;
      }
    } catch {}

    if (user) await user.send(
      `✅ Your ban appeal for **${guild.name}** was **approved**. You have been unbanned.` +
      (inviteUrl ? `\n\nRejoin here (link expires in 24h): ${inviteUrl}` : '')
    ).catch(() => {});

    await interaction.update({
      embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#2ecc71')
        .setTitle('✅ Appeal Approved').setFooter({ text: `Approved by ${interaction.user.tag}` })],
      components: [],
    }).catch(() => {});

  } else {
    client.db.updateAppeal(guildId, userId, { status: 'denied', resolvedAt: Date.now(), resolvedBy: interaction.user.id });

    if (user) await user.send(
      `❌ Your ban appeal for **${guild.name}** was **denied**. The ban stands.`
    ).catch(() => {});

    await interaction.update({
      embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#e74c3c')
        .setTitle('⛔ Appeal Denied').setFooter({ text: `Denied by ${interaction.user.tag}` })],
      components: [],
    }).catch(() => {});
  }
}

/** Router used by bot.js — returns true if it handled the interaction. */
async function route(interaction, client) {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('appeal_open:'))    { await handleOpenButton(interaction, client);     return true; }
    if (interaction.customId.startsWith('appeal_approve:')) { await handleDecisionButton(interaction, client); return true; }
    if (interaction.customId.startsWith('appeal_deny:'))    { await handleDecisionButton(interaction, client); return true; }
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('appeal_modal:')) {
    await handleModalSubmit(interaction, client); return true;
  }
  return false;
}

module.exports = { sendAppealOffer, route };
