const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { isStaffMember } = require('./staffAccess');
const windows = new Map();
const activeIncidents = new Map();
const URL_SCAM = /(free\s+nitro|nitro\s+generator|claim\s+your\s+prize|steam\s+gift|crypto\s+doubl|\bairdrop\b|bit\.ly\/|grabify|discord(?:app)?\.com\/gift)/i;
const BURST_WINDOW_MS = 8_000;
const INCIDENT_COOLDOWN_MS = 12_000;
const TEMP_BAN_MS = 24 * 60 * 60_000;

function enforcementDM(guildName, incident, action, reason, duration, inviteUrl) {
  return { embeds: [new EmbedBuilder().setColor(action === 'Kick' ? '#e67e22' : '#e74c3c').setTitle(`AutoMod: ${action}`).setDescription(`Your message in **${guildName}** was removed.`).addFields({ name: 'Incident', value: `${incident}`, inline: true }, { name: 'Reason', value: reason, inline: true }, ...(duration ? [{ name: 'Duration', value: duration, inline: true }] : []), ...(inviteUrl ? [{ name: 'Return invite', value: `[Rejoin the server](${inviteUrl})` }] : [])).addFields({ name: 'Policy', value: 'Incident 1: warning and deletion. Incident 2: kick. Incident 3 or later: 24-hour temporary ban. Permanent bans are decided by staff only.' }).setTimestamp()] };
}

async function createReturnInvite(guild) {
  const channels = [guild.systemChannel, ...guild.channels.cache.values()]
    .filter((ch, i, all) => ch && all.indexOf(ch) === i && (ch.isTextBased?.() || ch.type === 5) && ch.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite));
  for (const channel of channels) {
    try { return (await channel.createInvite({ maxUses: 1, maxAge: 7 * 24 * 60 * 60, unique: true, reason: 'AutoMod incident-2 return invite' })).url; }
    catch (err) { console.error(`[AutoMod] return invite failed in ${channel.id}:`, err.message); }
  }
  return null;
}

function bypass(message, settings, client) {
  if (!message.guild) return true;
  if (client?.user && message.author?.id === client.user.id) return true;
  if (message.author?.bot && !message.webhookId && !message.applicationId) return true;
  if (message.member && isStaffMember(message.member, settings)) return true;
  return false;
}

async function notify(message, settings, text) {
  const sent = await message.channel.send(text).catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), 12_000);
  const logId = settings.logChannelId || settings.antiScamAlertChannelId;
  if (logId) { const log = await message.guild.channels.fetch(logId).catch(() => null); await log?.send({ embeds: [new EmbedBuilder().setColor('#ff9900').setTitle('AutoMod action').setDescription(text).setTimestamp()] }).catch(() => {}); }
}

async function enforce(message, client, reason) {
  if (message.webhookId || message.applicationId) {
    await message.delete().catch(() => {});
    try {
      const hooks = await message.channel.fetchWebhooks();
      const hook = hooks.get(message.webhookId);
      if (hook) await hook.delete('AutoMod: webhook posted scam or spam');
    } catch (err) { console.error('[AutoMod] webhook delete failed:', err.message); }
    const settings = client.db.getGuildSettings(message.guild.id) || {};
    await notify(message, settings, `🪝 AutoMod removed a webhook / APP post (${reason}).`);
    return true;
  }
  const key = `${message.guild.id}:${message.author.id}`;
  if (activeIncidents.has(key)) return true;
  activeIncidents.set(key, Date.now());
  setTimeout(() => activeIncidents.delete(key), INCIDENT_COOLDOWN_MS).unref?.();
  const settings = client.db.getGuildSettings(message.guild.id) || {};
  const incident = client.db.recordAutoModIncident(message.guild.id, message.author.id);
  await message.delete().catch(() => {});
  if (incident === 1) await notify(message, settings, `⚠️ ${message.author}, spam was removed. This is AutoMod incident 1; please slow down.`);
  else if (incident === 2) {
    const inviteUrl = await createReturnInvite(message.guild);
    await message.author.send(enforcementDM(message.guild.name, incident, 'Kick', reason, null, inviteUrl)).catch(err => console.error('[AutoMod] incident-2 DM failed:', err.message));
    await message.member?.kick(`AutoMod incident 2: ${reason}`).catch(() => {});
    await notify(message, settings, `👢 ${message.author} was kicked after a second AutoMod incident.`);
  }
  else if (incident === 3) {
    const until = Date.now() + TEMP_BAN_MS;
    await message.author.send(enforcementDM(message.guild.name, incident, 'Temporary ban', reason, '24 hours')).catch(err => console.error('[AutoMod] temporary-ban DM failed:', err.message));
    await message.guild.members.ban(message.author.id, { reason: 'AutoMod incident 3: temporary 24-hour ban', deleteMessageSeconds: 0 }).catch(err => console.error('[AutoMod] temporary ban failed:', err.message));
    const g = client.db.getGuildSettings(message.guild.id); g.autoModTempBans[message.author.id] = until; client.db.saveData();
    await notify(message, settings, `🔨 ${message.author} received a temporary 24-hour ban after a third AutoMod incident.`);
  } else { const until = Date.now() + TEMP_BAN_MS; await message.author.send(enforcementDM(message.guild.name, incident, 'Temporary ban', reason, '24 hours')).catch(err => console.error('[AutoMod] temporary-ban DM failed:', err.message)); await message.guild.members.ban(message.author.id, { reason: `AutoMod incident ${incident}: temporary 24-hour ban`, deleteMessageSeconds: 0 }).catch(err => console.error('[AutoMod] temporary ban failed:', err.message)); const g = client.db.getGuildSettings(message.guild.id); g.autoModTempBans[message.author.id] = until; client.db.saveData(); await notify(message, settings, `🔨 ${message.author} received another temporary 24-hour ban after repeated incidents.`); }
  return true;
}

async function handleMessage(message, client) {
  const settings = client.db.getGuildSettings(message.guild?.id);
  if (bypass(message, settings, client)) return false;
  if (settings?.honeypotChannelId && message.channel.id === settings.honeypotChannelId) return enforce(message, client, 'honeypot bait');
  const now = Date.now(); const prior = (windows.get(message.author.id) || []).filter(t => now - t < BURST_WINDOW_MS); prior.push(now); windows.set(message.author.id, prior);
  if (prior.length >= 6) return enforce(message, client, 'rapid-message spam');
  if (URL_SCAM.test(message.content || '')) return enforce(message, client, 'scam or unwanted link');
  return false;
}

async function init(client) {
  for (const guild of client.guilds.cache.values()) {
    const settings = client.db.getGuildSettings(guild.id);
    for (const [userId, until] of Object.entries(settings?.autoModTempBans || {})) {
      const unban = async () => {
        try {
          await guild.members.unban(userId, 'AutoMod temporary ban expired');
          delete settings.autoModTempBans[userId];
          client.db.clearAutoModIncidents(guild.id, userId);
          client.db.saveData();
        } catch (err) {
          console.error('[AutoMod] auto-unban failed; state retained for retry:', err.message);
          setTimeout(unban, 5 * 60_000).unref?.();
        }
      };
      const delay = until - Date.now();
      if (delay <= 0) await unban();
      else setTimeout(unban, delay).unref?.();
    }
  }
}

function resetUser(userId) {
  windows.delete(userId);
  for (const key of activeIncidents.keys()) if (key.endsWith(`:${userId}`)) activeIncidents.delete(key);
}

module.exports = { handleMessage, init, resetUser };
