# stvtf-voice-bot

A bot that sits in a team's voice channel, in Discord or Mumble, and passes what is said to a
live match on [stv.tf](https://stv.tf), where it is heard as the speakers' players: on the site,
and in TF2 through a room's relay. A team's comms come out as late as the match's SourceTV (`tv_delay`),
held by the stream's ticks so a pause or a lagging server does not put them out of step; with
`delay:0` it is live commentary by people watching the stream.

## What leaves the channel

The bot records, and shows it: in Discord its name becomes `stv.tf ● recording` and it says so
in the channel; in Mumble it carries the recording sign and says so in the channel's chat. While
it is there, this goes to the stv.tf the match is on:

- **Voice**: every speaker's audio, as it is said. Anyone watching the match on stv.tf hears it
  (as late as the match itself), and it is written into the match's demo, which anyone with the
  match's page can download for two weeks.
- **Who is there**: the id and display name of everyone in the channel, speaking or not (Discord
  user ids; in Mumble the name and the certificate's hash), so whoever runs the match can say
  which player each is. stv.tf remembers that from one match to the next.
- **Steam links**: each Discord user's id is asked of stv.tf, for the Steam account they linked
  there (`/stv link`).

Nothing is kept by the bot itself. It leaves when told to, when the channel is empty, when it is
moved, and when the match ends.

## Commands

| | |
|---|---|
| `/stv join link:<the link from stv.tf, with its invite> [delay:<seconds>]` | joins your voice channel, says it is recording, and passes it on; `delay` is the server's `tv_delay` (90 unless said), `0` for commentary |
| `/stv delay delay:<seconds>` | changes the delay as it goes; only those in the voice channel, and it is said there |
| `/stv leave` | leaves (only for those in the voice channel); it also leaves when the channel is empty or the match is gone |
| `/stv link` | where to link your Steam account (the one on your Discord profile), so your voice is your player's |

Voice only comes into a match with its invite: stv.tf gives the `/stv join` command to whoever
started the match and to casters (the match's or room's page, the 🔊 list), to paste here or to
pass on to a team. Anyone in the voice channel may run it. One channel per server (a second bot account for two
teams in one server).

## Running

It is one half of a pair: it only talks to stv.tf servers ([stvtf-web](https://github.com/Arie/stvtf-web))
started with the same `STVTF_VOICE_KEY`. The one at stv.tf is the author's; to run your own, run
stvtf-web too and name it in `STVTF_HOSTS`.

```
npm ci
DISCORD_TOKEN=… STVTF_VOICE_KEY=… STVTF_HOSTS=your.host npm start
```

Node 22 or later. `STVTF_VOICE_KEY` is the key the stv.tf servers were started with; voice is
only ever posted to the hosts in `STVTF_HOSTS` (default: `stv.tf,na.stv.tf,au.stv.tf,sea.stv.tf`;
`localhost:8090` for a local one). In Discord the bot is invited with the `bot` and
`applications.commands` scopes and the View Channels, Connect, Send Messages and Change Nickname
permissions; it uses no privileged intents. `npm test` runs the tests, none of which need
Discord or a Mumble server. The first host is where people link Steam
and where the bot asks who they are, for matches on any of them: only it needs the Discord
application; all share the voice key.

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
reach with a password; one that only lets registered certificates in must let the bot's in.
Speakers are known by who they are on that server, and put on players on the match's page.
Whatever length of packet they send (10 to 60 ms) is regrouped into 20 ms without decoding.
`STVTF_MUMBLE_ANYWHERE=1` lets it join a server on this machine or its network: for trying out,
and at a LAN. stv.tf refuses such servers too, until it is started with the same setting.

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

A deploy takes the bot out of the voice channels it is in (it says so there); `/stv join` brings
it back. So not during a match.
