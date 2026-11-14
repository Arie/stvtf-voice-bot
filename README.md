# stvtf-voice-bot

A bot that sits in a team's voice channel, in Discord or Mumble, and passes what is said to a
live match on [stv.tf](https://stv.tf), where it is heard as the speakers' players: on the site,
and in TF2 through a room's relay. A team's comms come out as late as the match's SourceTV
(`tv_delay`), held by the stream's ticks so a pause or a lagging server does not put them out of
step; with `delay:0` it is live commentary by people watching the stream.

## What leaves the channel

The bot records, and shows it: in Discord its name becomes `stv.tf ● recording` and it says so
where the command was given; in Mumble it carries the recording sign and says so in the channel's
chat. While it is there, this goes to the stv.tf the match is on:

- **Voice**: every speaker's audio, as it is said. Anyone watching the match on stv.tf hears it
  (as late as the match itself), and it is written into the match's demo, which anyone with the
  match's page can download for two weeks.
- **Who is there**: the id and display name of everyone in the channel, speaking or not (Discord
  user ids; in Mumble the name and the certificate's hash, or without one the id on that server),
  so whoever runs the match can say which player each is. stv.tf remembers that from one match to
  the next. With it, where the bot is: in the channel, could not join, or left.
- **Steam links**: each Discord user's id is asked of stv.tf, for the Steam account they linked
  there (`/stv link`).

While stv.tf is away or restarting, or the match's stream is not there yet, a post goes again each
second, saying how long it has waited, so it still comes out at its moment. What has waited longer
than the delay (5 s at least) is dropped.

Of this the bot keeps nothing. With `STVTF_STATE` it keeps which Discord channels it is in (server,
channel, the match's link with its invite, the delay) until it leaves them. It leaves when told
to, when it is moved, when the match ends or its invite is refused; in Discord also when the
channel is empty. A Discord voice connection that drops has 5 s to come back.

## Commands

| | |
|---|---|
| `/stv join link:<the link from stv.tf, with its invite> [delay:<seconds>]` | joins your voice channel, says it is recording, and passes it on; `delay` is the server's `tv_delay` (90 unless said), `0` for commentary |
| `/stv delay delay:<seconds>` | changes the delay as it goes; only those in the voice channel, and it is said there |
| `/stv leave` | leaves (only for those in the voice channel); it also leaves when the channel is empty or the match is gone |
| `/stv link` | where to link your Steam account (the one on your Discord profile), so your voice is your player's |

Voice only comes into a match with its invite: stv.tf gives the `/stv join` command to whoever
started the match and to casters (the match's or room's page, the 🔊 list), to paste here or to
pass on to a team. Anyone in the voice channel may run it. One channel per server (a second bot
account for two teams in one server).

## Running

It is one half of a pair: it only talks to stv.tf servers
([stvtf-web](https://github.com/Arie/stvtf-web)) started with the same `STVTF_VOICE_KEY`. The one
at stv.tf is the author's; to run your own, run stvtf-web too and name it in `STVTF_HOSTS`.

```
npm ci
DISCORD_TOKEN=… STVTF_VOICE_KEY=… STVTF_HOSTS=your.host npm start
```

| setting | |
|---|---|
| `DISCORD_TOKEN` | the bot's token, from its Discord application; required |
| `STVTF_VOICE_KEY` | the key the stv.tf servers were started with; required |
| `STVTF_HOSTS` | the only hosts voice is ever posted to, comma separated (default `stv.tf,na.stv.tf,au.stv.tf,sea.stv.tf`; `localhost:8080` for a local one, over plain http). The first is where people link Steam and where the bot asks who they are, for matches on any of them: only it needs the Discord application; all share the voice key |
| `STVTF_STATE` | a file to keep the Discord channels it is in, to go back into them when it starts; without, it goes back into none |
| `STVTF_MUMBLE_ANYWHERE` | `1` lets it join a Mumble server on this machine or its network: for trying out, and at a LAN. stv.tf refuses such servers too, until it is started with the same setting |

Node 26 or later. Without the token or the key, or with a token Discord refuses, it says so and
exits. Stopped (`SIGINT`, `SIGTERM`), it leaves its channels, posts what it still holds, and exits
within 5 s. In Discord the bot is invited with the `bot` and `applications.commands` scopes and
the View Channels, Connect, Send Messages and Change Nickname permissions; it uses no privileged
intents. `npm test` runs the tests, none of which need Discord or a Mumble server.

## Checks

| command | |
|---|---|
| `script/test` | every check: eslint, prettier, tsc, shellcheck, hadolint, actionlint, zizmor, the tests and `npm audit` (`--help` for the rest); the linters `mise.toml` pins are programs of their own (`mise install`), skipped when not installed |
| `script/test --fix` | fixes what eslint and prettier can, then checks |

Before each commit, the quick ones (all but the audit), once enabled with
`ln -s ../../.githooks/pre-commit .git/hooks/pre-commit`.

## Mumble

Teams on Mumble need no command: on the match's page on stv.tf, whoever started it (or a caster)
gives the server's address, its password and the channel, and the bot joins there at once, marked
as recording (Mumble's own sign), and says so in the channel. It works with any server it can
reach with a password; it has no certificate, so not with one that only lets certificates in.
Speakers are known by their certificate, or without one by who they are on that server, and put
on players on the match's page. Whatever length of packet they send (10 to 60 ms) is regrouped
into 20 ms without decoding. The server must be out on the internet, unless
`STVTF_MUMBLE_ANYWHERE` is set.

## Deploying

`config/deploy.yml` is the Kamal config: one container on the stv.tf host in Europe, no proxy
and no ports (it only connects out). Secrets are read from `~/.config/stvtf/`:

| file | |
|---|---|
| `ghcr.token` | the registry token stv.tf deploys with |
| `voice-bot.token` | the bot's token, from its Discord application |
| `voice.key` | `openssl rand -hex 32`; the same key every stv.tf region is started with |

| command | |
|---|---|
| `bin/build` | builds and pushes the image, tagged with the commit |
| `bin/deploy` | stops the running bot, then starts the new one |
| `kamal logs` | follows its log |

A deploy takes the bot out of its voice channels for some seconds, and what is said meanwhile is
not heard. It goes back into each when it starts. Discord's are kept in `STVTF_STATE`
(`/data/discord.json`, on the `stvtf-voice-bot` volume): it says nothing there and keeps its name,
and forgets one it cannot go back into. Mumble's are asked of stv.tf: it says there that it
leaves and, back, that it records.
