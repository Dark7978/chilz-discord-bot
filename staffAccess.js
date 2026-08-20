'use strict';

const { PermissionFlagsBits } = require('discord.js');

function extraStaffRoleId() {
  return process.env.STAFF_BYPASS_ROLE_ID || '';
}

function hasStaffRole(member, settings) {
  if (!member?.roles?.cache) return false;
  if (extraStaffRoleId() && member.roles.cache.has(extraStaffRoleId())) return true;
  if (settings?.staffRoleId && member.roles.cache.has(settings.staffRoleId)) return true;
  if (settings?.ownerRoleId && member.roles.cache.has(settings.ownerRoleId)) return true;
  return false;
}

// Anything that is actually a moderator on Discord — not just a custom staff
// role. Historical /scan messages often have no member attached, so callers
// must fetch the member first; this is the permission check once they have it.
const MOD_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
];

function hasModPermissions(member) {
  if (!member?.permissions) return false;
  return MOD_PERMS.some(bit => member.permissions.has(bit));
}

function isStaffMember(member, settings) {
  if (!member) return false;
  if (member.guild?.ownerId && member.id === member.guild.ownerId) return true;
  return hasStaffRole(member, settings) || hasModPermissions(member);
}

function staffPing(settings) {
  const id = settings?.staffRoleId || extraStaffRoleId();
  return id ? `<@&${id}>` : 'Staff';
}

function staffMentionIds(settings) {
  const id = settings?.staffRoleId || extraStaffRoleId();
  return id ? [id] : [];
}

module.exports = {
  extraStaffRoleId,
  hasStaffRole,
  hasModPermissions,
  isStaffMember,
  staffPing,
  staffMentionIds,
};
