'use strict';

// Not every server wants the whole bot. A server that only asked for AutoMod and
// anti-scam should never see music, tickets or AI support — not as commands, not
// as background message handling.
//
// 'full'       — everything (the home server)
// 'moderation' — AutoMod, anti-scam and the staff tools that support them

const PROFILES = {
  full:       ['moderation', 'music', 'tickets', 'ai'],
  moderation: ['moderation'],
};

// Commands a moderation-only server gets. Anything absent is never registered
// there, so it cannot be invoked at all rather than replying with a refusal.
const MODERATION_COMMANDS = new Set([
  'setup', 'help', 'status', 'antiscam', 'scan',
  'staff', 'clear', 'modlogs', 'userinfo', 'unban', 'recreate_channel',
]);

function profileOf(settings) {
  return settings?.profile === 'moderation' ? 'moderation' : 'full';
}

function has(settings, feature) {
  return PROFILES[profileOf(settings)].includes(feature);
}

/** Filter a list of command JSON payloads down to what this guild should see. */
function commandsFor(settings, payloads) {
  if (profileOf(settings) === 'full') return payloads;
  return payloads.filter(c => MODERATION_COMMANDS.has(c.name));
}

module.exports = { has, profileOf, commandsFor, PROFILES, MODERATION_COMMANDS };
