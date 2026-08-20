require('dotenv').config();

const {
  Client, GatewayIntentBits, Collection,
  EmbedBuilder,
} = require('discord.js');

const Database   = require('./database');
const music      = require('./musicManager');
const antiScam   = require('./antiScam');
const autoMod    = require('./autoMod');
const banAppeal  = require('./banAppeal');
const aiSupport  = require('./aiSupport');
const fs        = require('path'), path = require('path');
const ticketCommand = require('./commands/ticket');
const { isStaffMember } = require('./staffAccess');
const fsLib     = require('fs');

// ── Global error shield ───────────────────────────────────────────────────────
process.on('unhandledRejection', err => console.error('[UnhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[UncaughtException]',  err));

// ── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
client.db       = new Database();
client.autoMod  = autoMod;

// Load commands
const commandsPath = path.join(__dirname, 'commands');
for (const file of fsLib.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(commandsPath, file));
  if (cmd.data && cmd.execute) client.commands.set(cmd.data.name, cmd);
}

// ── Ready ────────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✓ Bot logged in as ${client.user.tag}`);
  client.user.setActivity('Chilz Support', { type: 3 }); // Watching

  try {
    const cmds = client.commands.map(c => c.data.toJSON());
    await client.application.commands.set(cmds);
    console.log(`✓ Registered ${cmds.length} slash commands`);
  } catch (err) {
    console.error('[Cmd Register]', err);
  }

  // Re-arm any AI-support channel mutes that outlived the last restart
  aiSupport.init(client);
  autoMod.init(client).catch(err => console.error('[AutoMod] restore failed:', err));
});

// ── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Ban appeals (DM buttons/modal + staff approve/deny) ──────────────────────
  try {
    if (await banAppeal.route(interaction, client)) return;
  } catch (err) {
    console.error('[BanAppeal]', err);
  }

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction, client);
    } catch (err) {
      console.error(`[Cmd Error] /${interaction.commandName}:`, err);
      const msg = { content: '❌ An error occurred.', flags: 64 };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
      else                                              await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  // ── Modals ──────────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    return;
  }

  // ── Buttons ──────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_close_approve' || interaction.customId === 'ticket_close_reject') {
      const settings = client.db.getGuildSettings(interaction.guildId);
      const staff = isStaffMember(interaction.member, settings) || interaction.member.permissions.has('BanMembers');
      if (!staff) return interaction.reply({ content: 'Only staff can review close requests.', flags: 64 });
      const ticket = client.db.getTicketByChannelId(interaction.guildId, interaction.channelId);
      if (!ticket || ticket.closed) return interaction.reply({ content: 'This ticket is already closed or unavailable.', flags: 64 });
      if (interaction.customId === 'ticket_close_reject') { client.db.clearTicketCloseRequest(interaction.guildId, interaction.channelId); await interaction.reply('The close request was declined; this ticket remains open.'); return; }
      client.db.closeTicket(interaction.guildId, ticket.id); client.db.clearTicketCloseRequest(interaction.guildId, interaction.channelId);
      await interaction.reply('Close approved. This ticket will be deleted in 5 seconds.');
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
      return;
    }
    // AI support thread controls
    if (interaction.customId.startsWith('ai_')) {
      if (await aiSupport.handleButton(interaction, client)) return;
    }

    // Music control buttons
    if (interaction.customId.startsWith('music_')) {
      return music.handleButton(interaction);
    }


    // Ticket: create
    if (interaction.customId === 'create_ticket') {
      return ticketCommand.handleCreateTicket(interaction);
    }

    // Ticket: close (button inside ticket channel)
    if (interaction.customId === 'close_ticket') {
      const settings = client.db.getGuildSettings(interaction.guildId);
      if (!settings?.staffRoleId) {
        return interaction.reply({ content: '❌ Bot not setup. Use `/setup` first.', flags: 64 });
      }
      const ticket = client.db.getTicketByChannelId(interaction.guildId, interaction.channelId);
      if (!ticket) return interaction.reply({ content: '❌ This is not a ticket channel.', flags: 64 });

      const isStaff = isStaffMember(interaction.member, settings);
      const isOwner = settings.ownerRoleId && interaction.member.roles.cache.has(settings.ownerRoleId);
      if (!isStaff && !isOwner) {
        return interaction.reply({ content: '❌ Only staff can close tickets.', flags: 64 });
      }

      client.db.closeTicket(interaction.guildId, ticket.id);
      const embed = new EmbedBuilder()
        .setColor('#ff4444').setTitle('🔒 Ticket Closed')
        .setDescription(`Closed by ${interaction.user}\nThis channel deletes in **5 seconds**.`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
      return;
    }
  }

});

// ── Messages — anti-scam automod ─────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  const handled = await autoMod.handleMessage(message, client).catch(err => { console.error('[AutoMod]', err); return false; });
  if (handled) return;
  antiScam.handleMessage(message, client);

  // AI support channel — anti-scam runs first so scams never reach the model
  aiSupport.handleMessage(message, client);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!oldState.channel) return;
  const guildId = newState.guild.id;
  const musicQueue = music.getQueue(guildId);
  if (musicQueue && oldState.channel.id === musicQueue.voiceChannel.id) {
    const humans = oldState.channel.members.filter(m => !m.user.bot).size;
    if (humans === 0) {
      setTimeout(() => {
        const q = music.getQueue(guildId);
        if (q && q.voiceChannel.members.filter(m => !m.user.bot).size === 0) {
          q.textChannel?.send({ embeds: [new EmbedBuilder().setColor('#e74c3c').setDescription('Everyone left — disconnecting.')] }).catch(() => {});
          if (q.nowPlayingMessage) q.nowPlayingMessage.delete().catch(() => {});
          music.destroyQueue(guildId);
        }
      }, 10_000);
    }
  }
});

// ── Guild join ────────────────────────────────────────────────────────────────
client.on('guildCreate', (guild) => {
  console.log(`[Join] ${guild.name} (${guild.id})`);
  client.db.initGuild(guild.id);
});

client.login(process.env.DISCORD_TOKEN);
