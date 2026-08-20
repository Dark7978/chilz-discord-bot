const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

class Database {
  constructor() {
    this.data = this._load();
    this._migrate();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('[DB] Load failed, starting fresh:', err.message);
    }
    return { guilds: {} };
  }

  /** Atomic write: temp file → rename so a crash can't corrupt the DB. */
  saveData() {
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[DB] Save failed:', err.message);
    }
  }

  /** Add any missing fields to existing guild records without wiping data. */
  _migrate() {
    let dirty = false;
    for (const g of Object.values(this.data.guilds)) {
      if (!g.warnings)    { g.warnings  = {};  dirty = true; }
      if (!g.modLogs)     { g.modLogs   = [];  dirty = true; }
      if (!('logChannelId' in g)) { g.logChannelId = null; dirty = true; }
      if (!g.tickets)     { g.tickets   = [];  dirty = true; }
      if (!g.tempVoiceChannels) { g.tempVoiceChannels = []; dirty = true; }
      if (!('antiScamEnabled'        in g)) { g.antiScamEnabled        = true; dirty = true; }
      if (!('antiScamNewAccountDays' in g)) { g.antiScamNewAccountDays = 7;    dirty = true; }
      if (!('antiScamTimeoutMinutes' in g)) { g.antiScamTimeoutMinutes = 60;   dirty = true; }
      if (!('antiScamAlertChannelId' in g)) { g.antiScamAlertChannelId = null; dirty = true; }
      if (!('antiScamOcr'            in g)) { g.antiScamOcr            = true; dirty = true; }
      if (!('antiScamStrikeLimit'    in g)) { g.antiScamStrikeLimit    = 3;    dirty = true; }
      if (!('honeypotChannelId'      in g)) { g.honeypotChannelId      = null; dirty = true; }
      if (!('ticketEscalations'     in g)) { g.ticketEscalations       = {}; dirty = true; }
      if (!('autoModIncidents'     in g)) { g.autoModIncidents         = {}; dirty = true; }
      if (!('autoModTempBans'     in g)) { g.autoModTempBans           = {}; dirty = true; }
      if (!('appealChannelId'        in g)) { g.appealChannelId        = null; dirty = true; }
      if (!g.strikes)  { g.strikes  = {}; dirty = true; }
      if (!g.appeals)  { g.appeals  = {}; dirty = true; }
    }
    if (dirty) this.saveData();
  }

  // ── Guild ─────────────────────────────────────────────────────────────

  initGuild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = {
        staffRoleId:           null,
        ownerRoleId:           null,
        memberRoleId:          null,
        ticketChannelId:       null,
        logChannelId:          null,
        publicSupportChannelId:null,
        tickets:               [],
        warnings:              {},
        modLogs:               [],
        antiScamEnabled:        true,
        antiScamNewAccountDays: 7,
        antiScamTimeoutMinutes: 60,
        antiScamAlertChannelId: null,
        antiScamOcr:            true,
        antiScamStrikeLimit:    3,
        honeypotChannelId:      null,
        ticketEscalations:      {},
        autoModIncidents:       {},
        autoModTempBans:        {},
        appealChannelId:        null,
        strikes:               {},
        appeals:               {},
      };
      this.saveData();
    }
    return this.data.guilds[guildId];
  }

  getGuildSettings(guildId) {
    return this.data.guilds[guildId] || null;
  }

  updateGuildSettings(guildId, settings) {
    if (!this.data.guilds[guildId]) this.initGuild(guildId);
    Object.assign(this.data.guilds[guildId], settings);
    this.saveData();
  }

  // ── Tickets ───────────────────────────────────────────────────────────

  createTicket(guildId, userId, channelId, { category = 'General', topic = '' } = {}) {
    const g = this.data.guilds[guildId];
    if (!g) return null;
    if (!g.tickets) g.tickets = [];
    const ticket = {
      id:        `ticket-${Date.now()}`,
      userId,
      channelId,
      category,
      topic,
      createdAt: Date.now(),
      closedAt:  null,
      closed:    false,
    };
    g.tickets.push(ticket);
    this.saveData();
    return ticket;
  }

  getTicket(guildId, ticketId) {
    return (this.data.guilds[guildId]?.tickets || []).find(t => t.id === ticketId) || null;
  }

  /** Look up a ticket by its Discord channel ID — no name-parsing needed. */
  getTicketByChannelId(guildId, channelId) {
    return (this.data.guilds[guildId]?.tickets || []).find(t => t.channelId === channelId) || null;
  }

  pauseTicketAI(guildId, channelId) {
    const ticket = this.getTicketByChannelId(guildId, channelId);
    if (!ticket || ticket.closed || ticket.aiPaused) return false;
    ticket.aiPaused = true;
    this.saveData();
    return true;
  }

  requestTicketClose(guildId, channelId, userId) {
    const ticket = this.getTicketByChannelId(guildId, channelId);
    if (!ticket || ticket.closed || ticket.closeRequest) return false;
    ticket.closeRequest = { requestedBy: userId, requestedAt: Date.now() };
    this.saveData(); return true;
  }

  clearTicketCloseRequest(guildId, channelId) {
    const ticket = this.getTicketByChannelId(guildId, channelId);
    if (!ticket?.closeRequest) return false;
    delete ticket.closeRequest; this.saveData(); return true;
  }

  markTicketEscalated(guildId, channelId) {
    const g = this.data.guilds[guildId];
    if (!g) return false;
    if (!g.ticketEscalations) g.ticketEscalations = {};
    if (g.ticketEscalations[channelId]) return false;
    g.ticketEscalations[channelId] = Date.now();
    this.saveData();
    return true;
  }

  recordAutoModIncident(guildId, userId) {
    const g = this.data.guilds[guildId]; if (!g) return 0;
    if (!g.autoModIncidents) g.autoModIncidents = {};
    g.autoModIncidents[userId] = (g.autoModIncidents[userId] || 0) + 1;
    this.saveData(); return g.autoModIncidents[userId];
  }

  clearAutoModTempBan(guildId, userId) {
    const g = this.data.guilds[guildId];
    if (!g?.autoModTempBans?.[userId]) return false;
    delete g.autoModTempBans[userId];
    this.saveData();
    return true;
  }

  closeTicket(guildId, ticketId) {
    const ticket = this.getTicket(guildId, ticketId);
    if (ticket) { ticket.closed = true; ticket.closedAt = Date.now(); this.saveData(); }
  }

  getUserTickets(guildId, userId) {
    return (this.data.guilds[guildId]?.tickets || []).filter(t => t.userId === userId && !t.closed);
  }

  getOpenTickets(guildId) {
    return (this.data.guilds[guildId]?.tickets || []).filter(t => !t.closed);
  }

  // ── Warnings ──────────────────────────────────────────────────────────

  addWarning(guildId, userId, reason, moderatorId) {
    if (!this.data.guilds[guildId]) this.initGuild(guildId);
    const g = this.data.guilds[guildId];
    if (!g.warnings)        g.warnings = {};
    if (!g.warnings[userId]) g.warnings[userId] = [];
    const warn = { id: Date.now(), reason, moderatorId, createdAt: Date.now() };
    g.warnings[userId].push(warn);
    this.saveData();
    return warn;
  }

  getWarnings(guildId, userId) {
    return this.data.guilds[guildId]?.warnings?.[userId] || [];
  }

  removeWarning(guildId, userId, warnId) {
    const g = this.data.guilds[guildId];
    if (!g?.warnings?.[userId]) return false;
    const before = g.warnings[userId].length;
    g.warnings[userId] = g.warnings[userId].filter(w => w.id !== Number(warnId));
    if (g.warnings[userId].length < before) { this.saveData(); return true; }
    return false;
  }

  clearWarnings(guildId, userId) {
    const g = this.data.guilds[guildId];
    if (!g?.warnings) return 0;
    const count = (g.warnings[userId] || []).length;
    g.warnings[userId] = [];
    this.saveData();
    return count;
  }

  // ── Mod Logs ──────────────────────────────────────────────────────────

  addModLog(guildId, { action, targetId, moderatorId, reason, duration = null }) {
    if (!this.data.guilds[guildId]) this.initGuild(guildId);
    const g = this.data.guilds[guildId];
    if (!g.modLogs) g.modLogs = [];
    const entry = { id: Date.now(), action, targetId, moderatorId, reason, duration, createdAt: Date.now() };
    g.modLogs.push(entry);
    if (g.modLogs.length > 1000) g.modLogs = g.modLogs.slice(-1000);
    this.saveData();
    return entry;
  }

  getModLogs(guildId, userId) {
    const logs = this.data.guilds[guildId]?.modLogs || [];
    return userId ? logs.filter(l => l.targetId === userId) : logs;
  }

  // ── Strikes (anti-scam escalation) ────────────────────────────────────

  /** Add a strike to a user; returns the new total count. */
  addStrike(guildId, userId, reason) {
    if (!this.data.guilds[guildId]) this.initGuild(guildId);
    const g = this.data.guilds[guildId];
    if (!g.strikes) g.strikes = {};
    if (!g.strikes[userId]) g.strikes[userId] = { count: 0, history: [] };
    g.strikes[userId].count += 1;
    g.strikes[userId].history.push({ reason, at: Date.now() });
    if (g.strikes[userId].history.length > 50) g.strikes[userId].history = g.strikes[userId].history.slice(-50);
    this.saveData();
    return g.strikes[userId].count;
  }

  getStrikeCount(guildId, userId) {
    return this.data.guilds[guildId]?.strikes?.[userId]?.count || 0;
  }

  getStrikes(guildId, userId) {
    return this.data.guilds[guildId]?.strikes?.[userId] || { count: 0, history: [] };
  }

  clearStrikes(guildId, userId) {
    const g = this.data.guilds[guildId];
    if (!g?.strikes?.[userId]) return 0;
    const n = g.strikes[userId].count;
    delete g.strikes[userId];
    this.saveData();
    return n;
  }

  clearAutoModIncidents(guildId, userId) {
    const g = this.data.guilds[guildId]; if (!g) return 0;
    const n = g.autoModIncidents?.[userId] || 0;
    if (g.autoModIncidents) delete g.autoModIncidents[userId];
    this.saveData(); return n;
  }

  // ── Ban appeals ───────────────────────────────────────────────────────

  /** Record that a user was banned and may appeal. */
  createAppeal(guildId, userId, { reason, tag } = {}) {
    if (!this.data.guilds[guildId]) this.initGuild(guildId);
    const g = this.data.guilds[guildId];
    if (!g.appeals) g.appeals = {};
    g.appeals[userId] = {
      userId, tag: tag || null, banReason: reason || 'scam',
      status: 'banned',          // banned → pending → approved/denied
      appealText: null,
      bannedAt: Date.now(), appealedAt: null, resolvedAt: null, resolvedBy: null,
    };
    this.saveData();
    return g.appeals[userId];
  }

  getAppeal(guildId, userId) {
    return this.data.guilds[guildId]?.appeals?.[userId] || null;
  }

  updateAppeal(guildId, userId, updates) {
    const g = this.data.guilds[guildId];
    if (!g?.appeals?.[userId]) return null;
    Object.assign(g.appeals[userId], updates);
    this.saveData();
    return g.appeals[userId];
  }
}

module.exports = Database;
