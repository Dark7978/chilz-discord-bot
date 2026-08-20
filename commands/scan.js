const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { isStaffMember } = require('../staffAccess');
const antiScam = require('../antiScam');
const ocr = require('../ocr');

// Anti-scam only sees messages as they arrive, so a server that was already
// flooded stays flooded. This walks the backlog and applies the same detector.
// Bounded on purpose: OCR is seconds per image and an interaction cannot be
// edited forever, so it reports how far it got and can simply be run again.
const MAX_RUNTIME_MS = 8 * 60_000;
const MAX_IMAGES     = 150;
const PROGRESS_EVERY = 25;

function jumpLink(message) {
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scan')
    .setDescription('Scan message history for scam posts the live filter never saw')
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
      .setDescription('Only scan this channel (default: every channel the bot can read)')
      .addChannelTypes(ChannelType.GuildText))
    .addIntegerOption(o => o
      .setName('limit')
      .setDescription('Messages to check per channel (default 200, max 1000)')
      .setMinValue(10).setMaxValue(1000)),

  async execute(interaction, client) {
    const settings = client.db.getGuildSettings(interaction.guildId) || {};
    if (!isStaffMember(interaction.member, settings)) {
      return interaction.reply({ content: '❌ Staff only.', flags: 64 });
    }

    const action  = interaction.options.getString('action') || 'report';
    const only    = interaction.options.getChannel('channel');
    const perChan = interaction.options.getInteger('limit') || 200;

    await interaction.deferReply();

    const channels = only ? [only] : [...interaction.guild.channels.cache.values()]
      .filter(c => c.type === ChannelType.GuildText);

    const me = interaction.guild.members.me;
    const readable = channels.filter(c => {
      const p = c.permissionsFor(me);
      return p?.has(PermissionFlagsBits.ViewChannel) && p?.has(PermissionFlagsBits.ReadMessageHistory);
    });

    const started = Date.now();
    const hits = [];
    const offenders = new Map();
    let scanned = 0, imagesRead = 0, deleted = 0, failedDeletes = 0, truncated = false;

    const progress = async (note) => {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🔍 Scanning history')
          .setDescription(note)
          .addFields(
            { name: 'Messages', value: `${scanned}`, inline: true },
            { name: 'Images read', value: `${imagesRead}/${MAX_IMAGES}`, inline: true },
            { name: 'Scams found', value: `${hits.length}`, inline: true },
          )],
      }).catch(() => {});
    };

    await progress(`Checking ${readable.length} channel(s)…`);

    outer:
    for (const channel of readable) {
      let before;
      let pulled = 0;

      while (pulled < perChan) {
        if (Date.now() - started > MAX_RUNTIME_MS || imagesRead >= MAX_IMAGES) {
          truncated = true;
          break outer;
        }

        const batch = await channel.messages
          .fetch({ limit: Math.min(100, perChan - pulled), ...(before && { before }) })
          .catch(() => null);
        if (!batch || batch.size === 0) break;

        pulled += batch.size;
        before = batch.last().id;

        for (const message of batch.values()) {
          if (message.author?.bot) continue;
          // The live filter never touches staff, and their announcements read
          // exactly like promos — @everyone plus a link — so a sweep that
          // skipped this check would delete the server's own posts.
          const author = message.member || interaction.guild.members.cache.get(message.author?.id);
          if (author && isStaffMember(author, settings)) continue;
          scanned++;

          const images = [...message.attachments.values()]
            .filter(a => (a.contentType || '').startsWith('image/')
              || /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.name || a.url))
            .slice(0, 2);

          // Historical scans treat everyone as an established account. New-account
          // boosts would inflate scores on a backlog where nobody is new any more,
          // and this decides whether real messages get deleted.
          let verdict = antiScam.analyze(message, false);

          if (!verdict.hit && images.length && imagesRead < MAX_IMAGES) {
            const texts = [];
            for (const img of images) {
              if (imagesRead >= MAX_IMAGES) break;
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
            // bulkDelete refuses anything older than 14 days, and a backlog is
            // mostly older than that, so these go one at a time.
            const ok = await message.delete().then(() => true).catch(() => false);
            if (ok) { deleted++; await sleep(350); } else failedDeletes++;
          }

          if (hits.length % PROGRESS_EVERY === 0) await progress(`Working through #${channel.name}…`);
        }
      }
    }

    const worst = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const sample = hits.slice(0, 10).map(h =>
      `• ${h.message.author?.tag || 'unknown'} in <#${h.message.channelId}> — ${h.verdict.reasons.slice(0, 3).join(', ')} — [jump](${jumpLink(h.message)})`);

    const embed = new EmbedBuilder()
      .setColor(hits.length ? '#e74c3c' : '#00c851')
      .setTitle(hits.length ? `🚨 ${hits.length} scam message(s) found` : '✅ No scams found')
      .addFields(
        { name: 'Channels', value: `${readable.length}`, inline: true },
        { name: 'Messages checked', value: `${scanned}`, inline: true },
        { name: 'Images read', value: `${imagesRead}`, inline: true },
      )
      .setFooter({ text: `Took ${Math.round((Date.now() - started) / 1000)}s` })
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
    if (truncated) {
      embed.addFields({ name: '⚠️ Stopped early', value: `Hit the ${MAX_IMAGES}-image or ${MAX_RUNTIME_MS / 60000}-minute cap. Run it again to continue.` });
    }

    await interaction.editReply({ embeds: [embed] });

    if (hits.length) {
      client.db.addModLog(interaction.guildId, {
        action: action === 'delete' ? 'HISTORY SCAN (deleted)' : 'HISTORY SCAN (report)',
        targetId: interaction.user.id, moderatorId: interaction.user.id,
        reason: `${hits.length} scam messages found across ${readable.length} channels; ${deleted} deleted`,
      });
    }
  },
};
