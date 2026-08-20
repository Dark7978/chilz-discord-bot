const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('antiscam')
    .setDescription('Configure the anti-scam automod (giveaway / "you won money" spam)')

    .addSubcommand(s => s.setName('status')
      .setDescription('Show current anti-scam settings'))

    .addSubcommand(s => s.setName('on')
      .setDescription('Enable the anti-scam automod'))

    .addSubcommand(s => s.setName('off')
      .setDescription('Disable the anti-scam automod'))

    .addSubcommand(s => s.setName('newdays')
      .setDescription('Accounts younger than this (days) get KICKED; older ones get timed out')
      .addIntegerOption(o => o.setName('days').setDescription('Default 7').setRequired(true).setMinValue(1).setMaxValue(365)))

    .addSubcommand(s => s.setName('timeout')
      .setDescription('Timeout length (minutes) for established accounts caught scamming')
      .addIntegerOption(o => o.setName('minutes').setDescription('Default 60').setRequired(true).setMinValue(1).setMaxValue(40320)))

    .addSubcommand(s => s.setName('alertchannel')
      .setDescription('Channel where scam catches are reported (defaults to the mod-log channel)')
      .addChannelOption(o => o.setName('channel').setDescription('Alert channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))

    .addSubcommand(s => s.setName('strikelimit')
      .setDescription('How many scam kicks before a user is auto-banned')
      .addIntegerOption(o => o.setName('strikes').setDescription('Default 3').setRequired(true).setMinValue(1).setMaxValue(20)))

    .addSubcommand(s => s.setName('appealchannel')
      .setDescription('Staff channel where ban appeals are posted for review')
      .addChannelOption(o => o.setName('channel').setDescription('Appeal review channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))

    .addSubcommand(s => s.setName('ocr')
      .setDescription('Toggle reading text inside images (catches image-only scams)')
      .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)))

    .addSubcommand(s => s.setName('strikes')
      .setDescription('View a user\'s scam strikes')
      .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)))

    .addSubcommand(s => s.setName('clearstrikes')
      .setDescription('Reset a user\'s scam strikes to zero')
      .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true)))

    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId) || client.db.initGuild(interaction.guildId);
    const isOwner  = settings?.ownerRoleId && interaction.member.roles.cache.has(settings.ownerRoleId);
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) && !isOwner) {
      return interaction.reply({ content: '❌ You need Manage Server to configure anti-scam.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'on' || sub === 'off') {
      client.db.updateGuildSettings(interaction.guildId, { antiScamEnabled: sub === 'on' });
      return interaction.reply({ content: `✅ Anti-scam automod **${sub === 'on' ? 'ENABLED' : 'DISABLED'}**.`, flags: 64 });
    }

    if (sub === 'newdays') {
      const days = interaction.options.getInteger('days');
      client.db.updateGuildSettings(interaction.guildId, { antiScamNewAccountDays: days });
      return interaction.reply({ content: `✅ Accounts younger than **${days} day(s)** (by account age or join date) will be **kicked** when caught scamming; older ones get timed out.`, flags: 64 });
    }

    if (sub === 'timeout') {
      const mins = interaction.options.getInteger('minutes');
      client.db.updateGuildSettings(interaction.guildId, { antiScamTimeoutMinutes: mins });
      return interaction.reply({ content: `✅ Established scammers will be timed out for **${mins} min**.`, flags: 64 });
    }

    if (sub === 'alertchannel') {
      const ch = interaction.options.getChannel('channel');
      client.db.updateGuildSettings(interaction.guildId, { antiScamAlertChannelId: ch.id });
      return interaction.reply({ content: `✅ Scam alerts will be posted in ${ch}.`, flags: 64 });
    }

    if (sub === 'strikelimit') {
      const n = interaction.options.getInteger('strikes');
      client.db.updateGuildSettings(interaction.guildId, { antiScamStrikeLimit: n });
      return interaction.reply({ content: `✅ Users will be **banned** after **${n}** scam strikes (kicks before that).`, flags: 64 });
    }

    if (sub === 'appealchannel') {
      const ch = interaction.options.getChannel('channel');
      client.db.updateGuildSettings(interaction.guildId, { appealChannelId: ch.id });
      return interaction.reply({ content: `✅ Ban appeals will be posted for staff review in ${ch}.`, flags: 64 });
    }

    if (sub === 'ocr') {
      const on = interaction.options.getBoolean('enabled');
      client.db.updateGuildSettings(interaction.guildId, { antiScamOcr: on });
      return interaction.reply({ content: `✅ Image text-reading (OCR) is now **${on ? 'ON' : 'OFF'}**.`, flags: 64 });
    }

    if (sub === 'strikes') {
      const u = interaction.options.getUser('user');
      const s = client.db.getStrikes(interaction.guildId, u.id);
      const limit = settings.antiScamStrikeLimit ?? 3;
      const embed = new EmbedBuilder()
        .setColor(s.count >= limit ? '#cc0000' : s.count ? '#ff9900' : '#2ecc71')
        .setTitle(`Scam strikes for ${u.tag}`)
        .setDescription(`**${s.count}/${limit}** strikes`)
        .setThumbnail(u.displayAvatarURL());
      for (const h of (s.history || []).slice(-10)) {
        embed.addFields({ name: `<t:${Math.floor(h.at/1000)}:R>`, value: h.reason || 'scam' });
      }
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (sub === 'clearstrikes') {
      const u = interaction.options.getUser('user');
      const n = client.db.clearStrikes(interaction.guildId, u.id);
      const auto = client.db.clearAutoModIncidents(interaction.guildId, u.id);
      client.autoMod?.resetUser(u.id);
      return interaction.reply({ content: `✅ Cleared **${n}** anti-scam strike(s) and **${auto}** AutoMod incident(s) from ${u}.`, flags: 64 });
    }

    // status
    const embed = new EmbedBuilder()
      .setColor(settings.antiScamEnabled === false ? '#95a5a6' : '#2ecc71')
      .setTitle('🛡️ Anti-Scam Automod')
      .setDescription('Blocks fake giveaway / "you won money" / free-nitro spam.\n' +
        '• **New accounts** → message deleted, **kicked**, and DM sent.\n' +
        '• **Older accounts** (likely hacked) → message deleted, **timed out**, staff alerted.')
      .addFields(
        { name: 'Enabled',            value: settings.antiScamEnabled === false ? '❌ No' : '✅ Yes', inline: true },
        { name: 'Image OCR',          value: settings.antiScamOcr === false ? '❌ Off' : '✅ On',      inline: true },
        { name: 'New-account cutoff', value: `${settings.antiScamNewAccountDays ?? 7} days`,          inline: true },
        { name: 'Strike limit',       value: `${settings.antiScamStrikeLimit ?? 3} kicks → ban`,      inline: true },
        { name: 'Timeout length',     value: `${settings.antiScamTimeoutMinutes ?? 60} min`,          inline: true },
        { name: '​',             value: '​',                                                inline: true },
        { name: 'Alert channel',      value: settings.antiScamAlertChannelId ? `<#${settings.antiScamAlertChannelId}>`
                                            : settings.logChannelId ? `<#${settings.logChannelId}> (mod-log)` : 'none set', inline: true },
        { name: 'Appeal channel',     value: settings.appealChannelId ? `<#${settings.appealChannelId}>` : 'none set (falls back to alert/mod-log)', inline: true },
      )
      .setFooter({ text: 'Staff, owners, and anyone with Manage Messages are never affected.' });

    return interaction.reply({ embeds: [embed], flags: 64 });
  },
};
