// ── Anti-Scam Automod ──────────────────────────────────────────────────────
// Detects the common "fake Twitter/X giveaway — you won money, click here" scam
// (and related free-nitro / airdrop / steam-gift spam) and reacts based on how
// old the poster's account / membership is:
//
//   • NEW accounts  → delete message, KICK, and DM them why.
//   • OLD accounts  → delete message, TIMEOUT (likely compromised), alert staff.
//
// Nothing here touches staff/owner or bots.

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { hasStaffRole } = require('./staffAccess');
const ocr = require('./ocr');
const banAppeal = require('./banAppeal');

// ── Text normalization ───────────────────────────────────────────────────────
// Scammers dodge filters with homoglyphs (Сyrillic "с"), spacing ("n i t r o"),
// and leetspeak ("fr€€ n1tro"). OCR also produces noisy text. We fold all of it
// down to a clean lowercase ASCII string before matching.

const HOMOGLYPHS = {
  'а':'a','ѕ':'s','с':'c','е':'e','о':'o','р':'p','х':'x','у':'y','і':'i','ј':'j','к':'k','н':'h','м':'m','т':'t','в':'b','г':'r',
  'α':'a','ο':'o','ρ':'p','ѵ':'v','ⅼ':'l','ｏ':'o','０':'0','１':'1',
};
const LEET = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b','9':'g','$':'s','@':'a','€':'e','!':'i','|':'i' };

function normalize(raw = '') {
  let s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')            // strip accents
    .replace(/[​-‍﻿­]/g, '') // zero-width / soft hyphen
    .toLowerCase();
  s = s.replace(/[Ѐ-ӿͰ-Ͽ＀-￯Ⰰ-ⷿ]/g, ch => HOMOGLYPHS[ch] || ch);
  // Polish ą/ć/ę/ń/ó/ś/ź/ż fold away with the accent strip above, but ł is a
  // single code point with no combining form, so it survives NFKD untouched.
  s = s.replace(/\u0142/g, 'l');
  return s.replace(/\s+/g, ' ').trim();
}

// A leetspeak-folded copy for keyword matching (kept separate so we don't wreck
// numbers like "$500" in the original — this one is only used for word hits).
function deLeet(s = '') { return s.replace(/[013457890$@€!|]/g, c => LEET[c] || c); }

// ── Scam categories ──────────────────────────────────────────────────────────
// Each category is a set of patterns + a weight. Matching *distinct* categories
// is what builds confidence, so a scam that mixes "casino + giveaway + link"
// scores far higher than a single stray word.

// Polish patterns below are written against accent-folded text (normalize() turns
// ą/ę/ś/ł into a/e/s/l), so they read as "wygrales", not "wygrałeś". They are kept
// deliberately narrow: this bot also runs in a Polish community server, where a
// false positive deletes a real message and kicks a real member. Everyday words on
// their own ("gratulacje", "prezent", "darmowe") only count in a scam-shaped phrase.
const CATEGORIES = [
  { name: 'nitro-gift', weight: 4, patterns: [
    /free\s*nitro/, /nitro\s*(gift|giveaway|code|generator|for\s*free)/, /claim.{0,15}nitro/,
    /gift(ed)?\s*you.{0,15}nitro/, /discord\s*nitro\s*(free|gift)/, /(1|3|12)\s*months?\s*(of\s*)?nitro/,
    /darmowe?\s*nitro/, /nitro\s*(za\s*)?darmo/, /odbierz.{0,15}nitro/, /(kod|kody)\s*na\s*nitro/,
  ]},
  { name: 'celebrity-casino', weight: 4, patterns: [
    /mr\.?\s*beast/, /beast\s*games/, /(crypto|cryptocurrency)\s*casino/, /promo\s*code/,
    /withdrawal\s*success/, /rakeback/, /\bvip[\s-]*club\b/, /activate.{0,10}(code|bonus)/,
    /enter.{0,15}(promo\s*)?code/, /(deposit|register).{0,15}bonus/, /receive\s*your\s*\$?\d/,
    /(andrew\s*tate|kick\.com|stake\.com|csgo\w*\.\w+)/, /exclusive\s*(bonus|offer|reward)/,
    /kod\s*promocyjny/, /kasyno\s*(online|krypto)/, /(bonus|premia)\s*(powitalny|bez\s*depozytu)/,
    /darmowe\s*(spiny|zakrety)/, /wyplata\s*(udana|zrealizowana)/, /uzyj\s*kodu/,
  ]},
  { name: 'crypto', weight: 4, patterns: [
    /air\s*drop/, /(btc|eth|usdt|bitcoin|ethereum|solana|dogecoin)\b.{0,25}(free|giveaway|double|reward|claim|bonus)/,
    /double\s*your\s*(crypto|btc|eth|money|deposit|investment)/, /connect\s*your\s*wallet/,
    /(seed|recovery)\s*phrase/, /metamask|walletconnect|trust\s*wallet/, /guaranteed\s*(profit|returns?)/,
    /turn\s*\$?\d+.{0,10}(into|to)\s*\$?\d+/, /investment\s*(group|expert|opportunity)/,
    /(kryptowalut|bitcoin|ethereum)\w*.{0,25}(darmo|zarob|podwoj|nagrod|bonus)/,
    /podwoj\s*(swoje\s*)?(pieniadze|srodki|inwestycje)/, /polacz\s*(swoj\s*)?portfel/,
    /fraza\s*(seed|odzyskiwania)/, /gwarantowany\s*(zysk|zwrot)/, /(inwestuj|inwestycja)\s*bez\s*ryzyka/,
    /zamien\s*\d+\s*(zl|pln).{0,10}(na|w)\s*\d+/,
  ]},
  { name: 'giveaway', weight: 3, patterns: [
    /\bgiveaway\b/, /you('?ve| have)?\s*won/, /\byou\s*win\b/, /congratulations?.{0,20}(winner|won|selected)/,
    /claim\s*(your\s*)?(prize|reward|gift|winnings)/, /first\s*\d+\s*(people|users|members)/,
    /who('?s| is)?\s*first/, /\$\d{2,}\s*(usd|giveaway|prize|reward|cash)/, /limited\s*(time|spots?)/,
    // "wygrales" on its own is ordinary gaming banter, so it only counts when a
    // prize or a claim instruction follows it.
    /\brozdanie\b/, /gratulacje.{0,25}(wygral|nagrod|zwyciez|wybran)/,
    /wygrala?[sz]\b.{0,40}(nagrod|odbierz|kliknij|link|iphone|bitcoin|\d{2,}\s*(zl|pln|usd|euro))/,
    /odbierz\s*(swoj[aą]?\s*)?(nagrod|prezent|wygran)/, /zwyciezc[aey]\s*(losowania|konkursu)/,
    /pierwsz\w*\s*\d+\s*(osob|osoby|uzytkownik)/, /ograniczona\s*(liczba|oferta)/,
  ]},
  { name: 'steam', weight: 3, patterns: [
    /steam\s*(gift|community|nitro|trade)/, /stea[mr]n?community/, /steam.{0,10}(login|sign\s*in)/,
    /trade\s*offer/, /free\s*(game|games|skins?|cs\d*\s*skins?)/,
    /darmowe\s*(skiny|klucze)/, /oferta\s*wymiany/, /zaloguj\s*sie\s*przez\s*steam/,
  ]},
  { name: 'malware-game', weight: 4, patterns: [
    /(try|test|play|check\s*out)\s*(out\s*)?my\s*(new\s*)?game/, /playtest|beta\s*test/, /game\s*i\s*(made|created|developed)/,
    /can\s*you\s*(test|try)\s*(my|this)/, /feedback\s*on\s*my\s*game/, /(download|install).{0,15}(dropbox|drive\.google|mediafire|mega\.nz|\.zip|\.rar|\.exe)/,
    /beta\s*(access|key|invite)/, /help\s*me\s*test/,
    /(sprawdz|przetestuj|zagraj\s*w)\s*(moja|moje|nowa)\s*(gre|gra|gierk)/,
    /gr[aey]\s*ktor[aą]\s*(zrobilem|stworzylem|napisalem)/, /pomoz\s*mi\s*(ja\s*)?przetestowac/,
    /(pobierz|zainstaluj).{0,15}(mega\.nz|mediafire|dysk|\.zip|\.rar|\.exe)/,
  ]},
  { name: 'phishing-login', weight: 4, patterns: [
    /verify\s*your\s*(account|identity)/, /(login|log\s*in|sign\s*in)\s*to\s*(claim|verify|continue)/,
    /you('?ve| have)?\s*been\s*(reported|banned)/, /appeal\s*your\s*(ban|report)/, /account\s*(will\s*be\s*)?(suspended|deleted|terminated)/,
    /discord\s*(staff|team|support|moderation)\b.{0,30}(report|verify|ban|violat)/, /confirm\s*your\s*(email|password|identity)/,
    /scan\s*(the\s*)?qr/, /qr\s*code.{0,15}(claim|verify|login|nitro)/,
    /zweryfikuj\s*(swoje\s*)?(konto|tozsamosc)/, /twoje\s*konto\s*(zostalo|bedzie)\s*(zablokowane|zbanowane|usuniete|zawieszone)/,
    /zaloguj\s*sie\s*(aby|zeby)\s*(odebrac|potwierdzic|kontynuowac)/,
    /potwierdz\s*(swoj|swoje)\s*(email|haslo|dane|tozsamosc)/, /zeskanuj\s*kod\s*qr/,
    /zostales\s*(zglosz|zbanowan)/, /napisz\s*do\s*(administracji|moderacji)\s*discorda/,
  ]},
  { name: 'adult-bait', weight: 3, patterns: [
    /\bonlyfans\b/, /leaked?\s*(nudes?|content|onlyfans)/, /\bnudes?\b/, /18\s*\+.{0,15}(content|server|leaked)/,
    /teen\s*(porn|leak|content)/, /e-?girl.{0,10}(pics?|nudes?)/, /my\s*(private\s*)?(pics?|content)/,
    /nagie\s*(zdjecia|fotki)/, /wyciek\w*\s*(zdjecia|nagrania|tresci)/,
    /moje\s*(prywatne\s*)?(zdjecia|fotki|nagrania)/, /(sexting|erotyczne)\s*(zdjecia|czat)/,
  ]},
  { name: 'job-scam', weight: 3, patterns: [
    /(hiring|remote\s*job|paid\s*job).{0,20}(dm|message|apply)/, /earn\s*\$?\d+.{0,15}(per|daily|weekly|hour)/,
    /work\s*from\s*home.{0,15}\$/, /\bcrypto\s*trader\s*(wanted|needed)/,
    /praca\s*(zdalna|z\s*domu).{0,20}(napisz|dm|wiadomosc|pw)/, /szybka\s*kasa/,
    /zarabiaj\s*\d+.{0,15}(zl|pln|dziennie|tygodniowo|godzine)/, /zarob\s*\d+\s*(zl|pln)/,
    /(szukam|zatrudniam)\s*(osob|ludzi).{0,20}(napisz|dm|pw)/,
  ]},
];

// Any URL at all.
const ANY_LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|cc|xyz|top|vip|ru|tk|gift|bet|win|casino|link|online|site|shop|club|app|me)\b/;

// High-risk links: shorteners, discord/steam look-alikes, sketchy TLDs.
const SHADY_LINK = new RegExp([
  'bit\\.ly','tinyurl','cutt\\.ly','rb\\.gy','is\\.gd','t\\.co','shorturl','grabify','iplogger',
  'discordgift','discord-gift','discordnitro','discord-nitro','discordapp\\.gift','disc(ord)?[-.]?nitro',
  'dlscord','discrod','discocrd','dlscprd','steamcommunlty','stearncommunity','steam-?nitro',
  '\\.ru\\b','\\.tk\\b','\\.gift\\b','\\.xyz\\b','\\.top\\b','\\.cc\\b','\\.vip\\b','\\.bet\\b','\\.win\\b',
  '\\.casino\\b','\\.online\\b','\\.click\\b','\\.link\\b','\\.monster\\b',
  'airdrop','claim-','-reward','freenitro','free-nitro','nitro-gift','-giveaway',
].join('|'), 'i');

const INVITE_LINK = /(discord\.gg|discord(app)?\.com\/invite|dsc\.gg|discord\.io)\/\S+/i;

/**
 * Score a message for scamminess. Returns { hit, score, reasons, categories }.
 */
function analyze(message, isNew = false, extraText = '') {
  const rawCombined = ((message.content || '') + ' ' + (extraText || '')).trim();
  const norm   = normalize(rawCombined);
  const folded = deLeet(norm);            // for word matching
  const reasons = [];
  let score = 0;

  // ── Category matching (match against both normal + leet-folded text) ──────
  const catHits = [];
  for (const cat of CATEGORIES) {
    const nMatch = cat.patterns.filter(rx => rx.test(norm) || rx.test(folded)).length;
    if (nMatch) {
      catHits.push(cat.name);
      score += cat.weight;
      if (nMatch >= 2) score += Math.min(nMatch - 1, 3);   // stacked evidence in one theme
    }
  }
  if (catHits.length) reasons.push(...catHits);
  // Mixing several scam themes at once is a very strong signal.
  if (catHits.length >= 2) { score += 2; reasons.push('multi-category'); }

  // ── Link / media / ping signals ──────────────────────────────────────────
  const hasLink   = ANY_LINK.test(norm);
  const shady     = SHADY_LINK.test(norm) || SHADY_LINK.test(rawCombined);
  const hasInvite = INVITE_LINK.test(rawCombined);
  const hasImage  = message.attachments?.size > 0 || (message.embeds || []).some(e => e.image || e.thumbnail);
  const massPing  = message.mentions?.everyone || /@everyone|@here/.test(rawCombined);

  if (shady)     { score += 3; reasons.push('shady link'); }
  if (hasInvite) { score += 2; reasons.push('discord invite'); }
  if (massPing)  { score += 2; reasons.push('@everyone/@here'); }

  // Corroboration combos.
  if (catHits.length && hasLink)  { score += 2; reasons.push('scam + link'); }
  if (catHits.length && hasImage) { score += 2; reasons.push('scam + image'); }
  if (catHits.length && massPing) { score += 1; }

  // ── Obfuscation signal ───────────────────────────────────────────────────
  if (/[Ѐ-ӿͰ-Ͽ]/.test(rawCombined) && norm !== rawCombined.toLowerCase()) {
    score += 2; reasons.push('obfuscated text');
  }

  // ── New-account boosts ────────────────────────────────────────────────────
  // A fresh account posting media/links/pings with no clear reason is the exact
  // attacker profile; image-only scams (no readable caption) get caught here.
  if (isNew) {
    if (massPing && (hasImage || hasLink)) { score += 4; reasons.push('new acct: mass-ping + media'); }
    else if (hasInvite)                    { score += 3; reasons.push('new acct: invite link'); }
    else if (shady)                        { score += 2; reasons.push('new acct: shady link'); }
    else if (massPing)                     { score += 2; reasons.push('new acct: mass-ping'); }
  }

  return { hit: score >= 5, score, reasons: [...new Set(reasons)], categories: catHits };
}

// ── Response ────────────────────────────────────────────────────────────────

function daysBetween(a, b) { return Math.abs(a - b) / 86_400_000; }

async function postAlert(guild, settings, embed) {
  const chId = settings?.antiScamAlertChannelId || settings?.logChannelId;
  if (!chId) return;
  const ch = await guild.channels.fetch(chId).catch(() => null);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

/**
 * Main entry — call from the client 'messageCreate' handler.
 */
async function handleMessage(message, client) {
  try {
    if (!message.guild || message.author.bot || !message.member) return;

    const settings = client.db.getGuildSettings(message.guild.id);
    if (!settings || settings.antiScamEnabled === false) return;

    // Never touch staff / owner / anyone who can manage messages.
    const isStaff = hasStaffRole(message.member, settings);
    const isOwner = settings.ownerRoleId && message.member.roles.cache.has(settings.ownerRoleId);
    const canMod  = message.member.permissions.has(PermissionFlagsBits.ManageMessages);

    if (isStaff || isOwner) return;
    if (canMod) return;

    // How "new" is this member? Use the younger of account age and join age.
    const newDays      = settings.antiScamNewAccountDays ?? 7;
    const accountAge   = daysBetween(Date.now(), message.author.createdTimestamp);
    const joinedAge    = message.member.joinedTimestamp
      ? daysBetween(Date.now(), message.member.joinedTimestamp)
      : accountAge;
    const isNew        = accountAge < newDays || joinedAge < newDays;

    // First pass — text only.
    let verdict  = analyze(message, isNew);
    let ocrText  = '';

    // ── OCR pass ────────────────────────────────────────────────────────────
    // If text alone didn't flag it but the message has image(s), read the text
    // out of the images (fake MrBeast tweet / "Withdrawal Successful" screenshots
    // hide all their scam wording inside the picture).
    if (!verdict.hit && settings.antiScamOcr !== false) {
      const imageUrls = [...message.attachments.values()]
        .filter(a => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.name || a.url))
        .slice(0, 3)               // cap at 3 images per message
        .map(a => a.url);

      if (imageUrls.length) {
        const texts = await Promise.all(imageUrls.map(u => ocr.readImage(u)));
        ocrText = texts.join('\n').trim();
        if (ocrText) {
          verdict = analyze(message, isNew, ocrText);
          if (verdict.hit) verdict.reasons.push('OCR: scam text in image');
        }
      }
    }

    console.log(`[AntiScam] check from=${message.author.tag} ch=#${message.channel?.name} ` +
      `text="${(message.content||'').slice(0,40)}" imgs=${message.attachments.size} ` +
      `ocr="${ocrText.replace(/\s+/g,' ').slice(0,60)}" new=${isNew} ` +
      `HIT=${verdict.hit} score=${verdict.score} [${verdict.reasons.join(',')}]`);

    if (!verdict.hit) return;

    const contentSnippet = (message.content || ocrText || '(no text — image only)').slice(0, 500);

    // Always nuke the message first.
    await message.delete().catch(() => {});

    const baseEmbed = new EmbedBuilder()
      .setTimestamp()
      .addFields(
        { name: 'User',        value: `${message.author} \`${message.author.tag}\` (${message.author.id})`, inline: false },
        { name: 'Account age', value: `${accountAge.toFixed(1)} days`, inline: true },
        { name: 'In server',   value: `${joinedAge.toFixed(1)} days`,  inline: true },
        { name: 'Signals',     value: verdict.reasons.join(', ') || 'heuristic', inline: false },
        { name: 'Message',     value: `\`\`\`${contentSnippet.replace(/`/g, "'")}\`\`\`` },
      );

    if (isNew) {
      // ── New account → strike, then KICK or (at limit) BAN ────────────────
      const reasonStr    = verdict.reasons.join(', ');
      const strikeCount  = client.db.addStrike(message.guild.id, message.author.id, reasonStr);
      const strikeLimit  = settings.antiScamStrikeLimit ?? 3;

      if (strikeCount >= strikeLimit) {
        // ── Escalate to BAN + offer appeal ─────────────────────────────────
        await message.author.send(
          `🔨 You have been **banned** from **${message.guild.name}** after ${strikeCount} scam/spam strikes.\n` +
          `Check your DMs for an appeal option.`
        ).catch(() => {});

        await message.guild.members.ban(message.author.id, {
          reason: `Anti-scam: ${strikeCount} strikes (${reasonStr})`, deleteMessageSeconds: 86400,
        }).catch(() => {});

        client.db.createAppeal(message.guild.id, message.author.id, { reason: reasonStr, tag: message.author.tag });
        const dmed = await banAppeal.sendAppealOffer(client, message.guild, message.author, reasonStr);

        client.db.addModLog(message.guild.id, {
          action: 'AUTO-BAN (scam strikes)', targetId: message.author.id,
          moderatorId: client.user.id, reason: `${strikeCount} strikes: ${reasonStr}`,
        });

        baseEmbed.setColor('#cc0000')
          .setTitle('🔨 Scam blocked — account BANNED (strike limit)')
          .setDescription(`Reached **${strikeCount}/${strikeLimit}** strikes. ${dmed ? 'Appeal DM sent.' : 'Could not DM (DMs closed).'}`);
        await postAlert(message.guild, settings, baseEmbed);
        console.log(`[AntiScam] BANNED ${message.author.tag} — ${strikeCount} strikes (${reasonStr})`);

      } else {
        // ── Kick + warn how many strikes remain ────────────────────────────
        await message.author.send(
          `🚫 Your message in **${message.guild.name}** was flagged as scam/spam and you were removed.\n\n` +
          `⚠️ This is **strike ${strikeCount}/${strikeLimit}** — at ${strikeLimit} strikes you will be **banned**.\n` +
          `Do not post giveaway links, "you won money" screenshots, free-nitro, or "try my game" downloads.`
        ).catch(() => {});

        await message.member.kick(`Anti-scam automod (strike ${strikeCount}/${strikeLimit}): ${reasonStr}`).catch(() => {});

        client.db.addModLog(message.guild.id, {
          action: 'AUTO-KICK (scam)', targetId: message.author.id,
          moderatorId: client.user.id, reason: `strike ${strikeCount}/${strikeLimit}: ${reasonStr}`,
        });

        baseEmbed.setColor('#ff4500')
          .setTitle(`👢 Scam blocked — new account kicked (strike ${strikeCount}/${strikeLimit})`);
        await postAlert(message.guild, settings, baseEmbed);
        console.log(`[AntiScam] Kicked ${message.author.tag} — strike ${strikeCount}/${strikeLimit} (${reasonStr})`);
      }

    } else {
      // ── Established account → likely compromised → TIMEOUT + alert staff ──
      const mins = settings.antiScamTimeoutMinutes ?? 60;
      await message.member.timeout(mins * 60_000, `Anti-scam automod: ${verdict.reasons.join(', ')}`).catch(() => {});

      client.db.addModLog(message.guild.id, {
        action: 'AUTO-TIMEOUT (scam)', targetId: message.author.id,
        moderatorId: client.user.id, reason: verdict.reasons.join(', '), duration: mins,
      });

      baseEmbed.setColor('#9b59b6')
        .setTitle('🔇 Scam blocked — established account timed out')
        .setDescription(
          `This account is **${accountAge.toFixed(0)} days old** — it may be **compromised/hacked** ` +
          `rather than a throwaway. It was **timed out for ${mins} min** instead of kicked. ` +
          `Staff: review and ban/unmute as needed.`
        );
      await postAlert(message.guild, settings, baseEmbed);
      console.log(`[AntiScam] Timed out established account ${message.author.tag} (${verdict.reasons.join(', ')})`);
    }
  } catch (err) {
    console.error('[AntiScam] handleMessage error:', err.message);
  }
}

module.exports = { handleMessage, analyze };
