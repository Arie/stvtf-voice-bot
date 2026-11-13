// What the bot knows of a Mumble server: its people and channels, as the server says. Kept short
// and few: more than any real server has is a server to leave.

const MAX_NAME = 128,
  MAX_USERS = 5000,
  MAX_CHANNELS = 5000;

/** @typedef {{ session: number; name: string; channel: number; id: string }} Person */

export class ServerState {
  /** @type {Map<number, Person>} By session. */
  users = new Map();
  /** @type {Map<number, string>} Channels' names by id. */
  channels = new Map();

  /** @param {(why: string) => void} onOverflow Told when the server has more than any real one. */
  constructor(onOverflow) {
    this.onOverflow = onOverflow;
  }

  /** @param {import("./proto.mjs").ChannelState} m */
  applyChannelState(m) {
    if (m.name == null) return;
    const id = m.channel_id ?? 0;
    if (!this.channels.has(id) && this.channels.size >= MAX_CHANNELS) return this.onOverflow("too many channels");
    this.channels.set(id, m.name.slice(0, MAX_NAME));
  }

  /** @param {import("./proto.mjs").ChannelRemove} m */
  applyChannelRemove(m) {
    if (m.channel_id != null) this.channels.delete(m.channel_id);
  }

  /** @param {import("./proto.mjs").UserState} m @returns {Person | null} Who it is now, if kept. */
  applyUserState(m) {
    if (m.session == null) return null;
    if (!this.users.has(m.session) && this.users.size >= MAX_USERS) {
      this.onOverflow("too many users");
      return null;
    }
    const u = this.users.get(m.session) ?? { session: m.session, name: "", channel: 0, id: "" };
    if (m.name != null) u.name = m.name.slice(0, MAX_NAME);
    if (m.channel_id != null) u.channel = m.channel_id;
    // Who they are from one visit to the next: their certificate, the same on any server;
    // else as registered on this one.
    if (m.hash) u.id = `cert:${m.hash.slice(0, MAX_NAME)}`;
    else if (m.user_id != null && !u.id.startsWith("cert:")) u.id = `user:${m.user_id}`;
    this.users.set(m.session, u);
    return u;
  }

  /** @param {number} session */
  removeUser(session) {
    this.users.delete(session);
  }

  /** A channel's id by its name, whatever its case. @param {string} name */
  channelNamed(name) {
    const want = name.trim().toLowerCase();
    return [...this.channels].find(([, n]) => n.toLowerCase() === want)?.[0];
  }

  /** Those in `channel`, `self` aside. @param {number} channel @param {number} self @returns {Person[]} */
  peopleIn(channel, self) {
    return [...this.users.values()].filter(u => u.channel === channel && u.session !== self);
  }
}
