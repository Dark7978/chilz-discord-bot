# Chilz

A Discord bot for support tickets, anti-scam AutoMod, and music (YouTube, SoundCloud, Spotify links, Deezer).

Works on Windows, macOS, and Linux. You do not need a VPS.

## What you need

- [Node.js 18+](https://nodejs.org/) (LTS is fine)
- A Discord bot token ([create one here](https://discord.com/developers/applications))

Optional:

- [Groq API key](https://console.groq.com) for AI support replies
- [Spotify app](https://developer.spotify.com/dashboard) Client ID + Secret if you want Spotify links (metadata only; audio comes from YouTube or SoundCloud)

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
| `/music play` | Anyone in a voice channel | Song name, YouTube, SoundCloud, Spotify, or Deezer |
| `/music eq` | Same | Clean / Bass / Vocal / Treble / Punch |
| `/ticket` | Staff | Close / add / remove / list |
| `/clear` | Staff | Delete up to 300 messages |
| `/recreate_channel` | Staff | Recreate a text channel (separate from `/clear`) |
| `/staff` | Staff | Warn, kick, ban, mute |
| `/antiscam` | Staff | Anti-scam settings |
| `/scan` | Staff | Sweep old messages for scams the live filter never saw |

AutoMod ladder: delete + warn → kick → 24-hour temp ban. No automatic permanent bans. Ticket close requests need staff approval.

## Running in more than one server

Some servers only want the moderation half. `/setup` takes a **profile**:

- `everything` — music, tickets, AI support, moderation (the default)
- `moderation only` — AutoMod and anti-scam, nothing else

Commands are registered per server from the profile, so a moderation-only server never sees `/music` or `/ticket` at all, and AI support does not read its messages. Switching profile re-registers that server's commands immediately.

`/scan` handles the backlog a live filter cannot: one run walks every readable channel, thread and forum post with no image or time cap (progress updates while it works; if Discord's 15-minute reply window runs out, the result is posted in the channel). It uses the same detector, including OCR on attachments and embed images. Webhook and APP posts are included; Chilz's own messages and anyone with administrator or moderator permissions are skipped. It only deletes when you pass `action: delete the scam messages`.

Anti-scam reads English and Polish, in message text and inside images. Set `OCR_LANGS=eng+pol` so image text in both languages is picked up.

## Music notes

- Spotify credentials are only used to read track/album/playlist names. Audio comes from YouTube or SoundCloud through yt-dlp → FFmpeg.
- YouTube blocks most datacenter IPs with "Sign in to confirm you're not a bot". If that happens the bot falls back to SoundCloud automatically, so music still plays on a VPS with no extra setup. Home connections normally get YouTube directly.
- To use YouTube from a blocked host anyway, put a Netscape-format `youtube.cookies.txt` next to `bot.js` (or point `YTDLP_COOKIES` at one). It is picked up automatically and is never committed.
- FFmpeg cannot open a YouTube or SoundCloud page URL on its own — it has no extractor for either, so a watch page just looks like HTML to it. yt-dlp turns the page into a real stream URL and FFmpeg takes it from there. That is why both are needed.
- On Linux `npm run setup` downloads a full FFmpeg build into `ffbuild/`, because the `ffmpeg-static` package ships a Linux binary that segfaults as soon as it opens an HTTPS input. Set `FFMPEG_PATH` to use your own build instead.
- Keep `yt-dlp` updated if playback breaks (`yt-dlp -U` or re-run `npm run setup` after deleting the binary).

## AI support

Set `GROQ_API_KEY`, then in `/setup` pick **ai_support_channel**. When the bot thinks staff are needed, it asks the member if they want a ticket.

## License

MIT. See `LICENSE`.
