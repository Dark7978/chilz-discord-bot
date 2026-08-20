# Chilz

A Discord bot for support tickets, anti-scam AutoMod, and music (YouTube, Spotify links, Deezer).

Works on Windows, macOS, and Linux. You do not need a VPS.

## What you need

- [Node.js 18+](https://nodejs.org/) (LTS is fine)
- A Discord bot token ([create one here](https://discord.com/developers/applications))

Optional:

- [Groq API key](https://console.groq.com) for AI support replies
- [Spotify app](https://developer.spotify.com/dashboard) Client ID + Secret if you want Spotify links (metadata only; audio still comes from YouTube)

## Setup (3 commands)

```bash
git clone https://github.com/Dark7978/chilz-discord-bot.git
cd chilz-discord-bot
npm install
npm run setup
```

`npm run setup` creates `.env` if it is missing and downloads [yt-dlp](https://github.com/yt-dlp/yt-dlp) into this folder (required for music).

1. Open `.env` and paste your `DISCORD_TOKEN`.
2. In the [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot**:
   - Turn on **Message Content Intent**, **Server Members Intent**, and **Presence Intent** is not required.
   - Enable **Message Content** and **Server Members**.
3. Invite the bot with scopes `bot` + `applications.commands` and permissions: Read/Send Messages, Manage Messages, Manage Channels, Kick, Ban, Timeout, Connect, Speak, Embed Links.
4. Start it:

```bash
npm start
```

5. In your server, run `/setup` (Administrator). Pick your staff role, owner role, and ticket channel.

That is it. Settings are stored locally in `data.json` (not committed).

## Commands (short)

| Command | Who | What |
|---|---|---|
| `/setup` | Admin | Staff role, tickets, logs, optional bait channel |
| `/music play` | Anyone in a voice channel | Song name, YouTube URL, Spotify, or Deezer |
| `/music eq` | Same | Clean / Bass / Vocal / Treble / Punch |
| `/ticket` | Staff | Close / add / remove / list |
| `/clear` | Staff | Delete up to 300 messages |
| `/recreate_channel` | Staff | Recreate a text channel (separate from `/clear`) |
| `/staff` | Staff | Warn, kick, ban, mute |
| `/antiscam` | Staff | Anti-scam settings |

AutoMod ladder: delete + warn → kick → 24-hour temp ban. No automatic permanent bans. Ticket close requests need staff approval.

## Music notes

- Spotify credentials are only used to read track/album/playlist names. Playback is YouTube through yt-dlp → FFmpeg.
- SoundCloud is not used.
- Keep `yt-dlp` updated if YouTube breaks (`yt-dlp -U` or re-run `npm run setup` after deleting the binary).

## AI support

Set `GROQ_API_KEY`, then in `/setup` pick **ai_support_channel**. When the bot thinks staff are needed, it asks the member if they want a ticket.

## License

MIT. See `LICENSE`.
