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

function isStaffMember(member, settings) {
  if (!member) return false;
  return hasStaffRole(member, settings)
    || member.permissions.has(PermissionFlagsBits.ManageMessages)
    || member.permissions.has(PermissionFlagsBits.Administrator);
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
  isStaffMember,
  staffPing,
  staffMentionIds,
};
