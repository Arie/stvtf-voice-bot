# stvtf-voice-bot

A Discord bot that sits in a voice channel and passes what is said to a live match on
[stv.tf](https://stv.tf), where it is heard as the speakers' players: on the site, and in TF2
through a room's relay. A team's comms come out as late as the match's SourceTV (`tv_delay`),
held by the stream's ticks so a pause or a lagging server does not put them out of step; with
`delay:0` it is live commentary by people watching the stream.

## Commands

| | |
|---|---|
| `/stv join link:<stv.tf match or room page> [delay:<seconds>]` | joins your voice channel, says it is recording, and passes it on; `delay` is the server's `tv_delay` (90 unless said), `0` for commentary |
| `/stv delay delay:<seconds>` | changes the delay as it goes; only those in the voice channel, and it is said there |
| `/stv leave` | leaves (only for those in the voice channel); it also leaves when the channel is empty or the match is gone |
| `/stv link` | where to link your Steam account (the one on your Discord profile), so your voice is your player's |

Anyone in the voice channel may invite it. One channel per server (a second bot account for two
teams in one server).

## Running

```
DISCORD_TOKEN=… STVTF_VOICE_KEY=… npm start
```

`STVTF_VOICE_KEY` is the key the stv.tf servers were started with; voice is only ever posted to
the hosts in `STVTF_HOSTS` (default: `stv.tf,na.stv.tf,au.stv.tf,sea.stv.tf`; add
`localhost:8090` to test against a local one). The bot needs the View Channels, Connect, Send
Messages and Change Nickname permissions, and the `applications.commands` scope. `npm test`
runs the tests of the parts that do not need Discord.
