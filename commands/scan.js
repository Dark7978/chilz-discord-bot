const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { isStaffMember } = require('../staffAccess');
const antiScam = require('../antiScam');
const ocr = require('../ocr');

const PROGRESS_EVERY_MS = 12_000;

function jumpLink(message) {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function forumThreads(forum) {
  const out = [];
  try {
    const active = await forum.threads.fetchActive();
    out.push(...active.threads.values());
  } catch { /* no access */ }

  let before;
  for (let page = 0; page < 50; page++) {
    try {
      const archived = await forum.threads.fetchArchived({ limit: 100, ...(before && { before }) });
      const threads = [...archived.threads.values()];
      if (!threads.length) break;
      out.push(...threads);
      before = threads[threads.length - 1].id;
      if (threads.length < 100 || archived.hasMore === false) break;
    } catch {
      break;
    }
  }
  return out;
}

async function listScanTargets(guild, only) {
  if (only) {
    if (only.type === ChannelType.GuildForum) return forumThreads(only);
    return [only];
  }
  const list = [];
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) list.push(c);
    if (c.isThread?.()) list.push(c);
    if (c.type === ChannelType.GuildForum) list.push(...await forumThreads(c));
  }
  const seen = new Set();
  return list.filter(c => {
    if (!c || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scan')
    .setDescription('Scan every readable message for scam posts the live filter never saw')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(o => o
      .setName('action')
      .setDescription('Report what was found, or delete it too')
      .addChoices(
        { name: 'report only (default)', value: 'report' },
        { name: 'delete the scam messages', value: 'delete' },
      ))
    .addChannelOption(o => o
      .setName('channel')
      .setDescription('Only scan this channel (default: every channel and thread the bot can read)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.PublicThread)),

  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId) || {};
    if (!isStaffMember(interaction.member, settings)) {
      return interaction.reply({ content: '❌ Staff only.', flags: 64 });
    }

    const action = interaction.options.getString('action') || 'report';
    const only   = interaction.options.getChannel('channel');

    await interaction.deferReply();

    // Old messages do not include member/roles. Without this, staff announcements
    // look like @everyone + a link and get deleted.
    await interaction.guild.members.fetch().catch(err =>
      console.error('[Scan] member fetch failed:', err.message));

    const channels = await listScanTargets(interaction.guild, only);
    const me = interaction.guild.members.me;
    const readable = channels.filter(c => {
      const p = c.permissionsFor(me);
      return p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.ReadMessageHistory);
    });

    const started = Date.now();
    const hits = [];
    const offenders = new Map();
    let scanned = 0, skippedStaff = 0, imagesRead = 0, deleted = 0, failedDeletes = 0;
    let lastProgress = 0;
    let replyLive = true;

    const progressEmbed = (title, note) => new EmbedBuilder()
      .setColor('#5865F2').setTitle(title)
      .setDescription(note)
      .addFields(
        { name: 'Places', value: `${readable.length}`, inline: true },
        { name: 'Messages', value: `${scanned}`, inline: true },
        { name: 'Images read', value: `${imagesRead}`, inline: true },
        { name: 'Staff skipped', value: `${skippedStaff}`, inline: true },
        { name: 'Scams found', value: `${hits.length}`, inline: true },
      );

    const progress = async (note) => {
      const now = Date.now();
      if (now - lastProgress < PROGRESS_EVERY_MS && scanned > 0) return;
      lastProgress = now;
      const payload = { embeds: [progressEmbed('🔍 Scanning history', note)] };
      if (!replyLive) {
        await interaction.channel.send(payload).catch(() => {});
        return;
      }
      try {
        await interaction.editReply(payload);
      } catch {
        replyLive = false;
        await interaction.channel.send(payload).catch(() => {});
      }
    };

    await progress(`Checking ${readable.length} channel(s) and thread(s)… this can take a while.`);

    for (const channel of readable) {
      let before;
      while (true) {
        const batch = await channel.messages
          .fetch({ limit: 100, ...(before && { before }) })
          .catch(() => null);
        if (!batch || batch.size === 0) break;

        before = batch.last().id;

        for (const message of batch.values()) {
          if (antiScam.skipIncoming(message, client)) continue;

          const author = message.member
            || interaction.guild.members.cache.get(message.author?.id);
          if (author && isStaffMember(author, settings)) {
            skippedStaff++;
            continue;
          }
          scanned++;

          const images = antiScam.imageUrlsFrom(message, 3).map(url => ({ url }));
          let verdict = antiScam.analyze(message, false);

          if (!verdict.hit && images.length) {
            const texts = [];
            for (const img of images) {
              imagesRead++;
              texts.push(await ocr.readImage(img.url));
            }
            const ocrText = texts.join('\n').trim();
            if (ocrText) {
              verdict = antiScam.analyze(message, false, ocrText);
              if (verdict.hit) verdict.reasons.push('OCR: scam text in image');
            }
          }

          if (!verdict.hit) continue;

          hits.push({ message, verdict });
          const tag = message.author?.tag || message.author?.id || 'unknown';
          offenders.set(tag, (offenders.get(tag) || 0) + 1);

          if (action === 'delete') {
            const ok = await message.delete().then(() => true).catch(() => false);
            if (ok) { deleted++; await sleep(350); } else failedDeletes++;
          }
        }

        await progress(`Working through ${channel.name ? `#${channel.name}` : channel.id}…`);
        if (batch.size < 100) break;
      }
    }

    const worst = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sample = hits.slice(0, 10).map(h =>
      `• ${h.message.author?.tag || 'unknown'} in <#${h.message.channelId}> — ${h.verdict.reasons.slice(0, 3).join(', ')} — [jump](${jumpLink(h.message)})`);

    const embed = new EmbedBuilder()
      .setColor(hits.length ? '#e74c3c' : '#00c851')
      .setTitle(hits.length ? `🚨 ${hits.length} scam message(s) found` : '✅ No scams found')
      .addFields(
        { name: 'Places checked', value: `${readable.length}`, inline: true },
        { name: 'Messages checked', value: `${scanned}`, inline: true },
        { name: 'Images read', value: `${imagesRead}`, inline: true },
        { name: 'Staff skipped', value: `${skippedStaff}`, inline: true },
      )
      .setFooter({ text: `Took ${Math.round((Date.now() - started) / 1000)}s — full history` })
      .setTimestamp();

    if (action === 'delete') {
      embed.addFields({ name: 'Deleted', value: `${deleted}${failedDeletes ? ` (${failedDeletes} failed)` : ''}`, inline: true });
    } else if (hits.length) {
      embed.addFields({ name: 'Nothing was deleted', value: 'Re-run with `action: delete the scam messages` to remove them.' });
    }

    if (worst.length) {
      embed.addFields({ name: 'Posters', value: worst.map(([tag, n]) => `\`${tag}\` — ${n}`).join('\n').slice(0, 1024) });
    }
    if (sample.length) {
      embed.addFields({ name: 'Examples', value: sample.join('\n').slice(0, 1024) });
    }

    const done = { embeds: [embed] };
    if (replyLive) await interaction.editReply(done).catch(() => interaction.channel.send(done).catch(() => {}));
    else await interaction.channel.send(done).catch(() => {});

    if (hits.length) {
      client.db.addModLog(interaction.guildId, {
        action: action === 'delete' ? 'HISTORY SCAN (deleted)' : 'HISTORY SCAN (report)',
        targetId: interaction.user.id, moderatorId: interaction.user.id,
        reason: `${hits.length} scam messages found across ${readable.length} places; ${deleted} deleted; ${skippedStaff} staff skipped`,
      });
    }
  },
};
