// A made-up Mumble server, for the tests.
import assert from "node:assert/strict";
import { PassThrough, Duplex } from "node:stream";
import { decode, encode, frame, Frames } from "../src/mumble/proto.mjs";
import { stand } from "./stand.mjs";

/** @typedef {import("../src/mumble/proto.mjs").Messages} Messages */

/** A made-up server: what the client sent it, and a way to send the client messages. */
export function fake() {
  const [toServer, toClient] = [new PassThrough(), new PassThrough()];
  const frames = new Frames();
  /** @type {{ type: string; body: Buffer }[]} */
  const got = [];
  toServer.on("data", d => got.push(...frames.push(d)));
  const server = {
    got,
    /** @type {Duplex | null} The client's end, once it connects. */
    socket: null,
    closed: false,
    connect: () => {
      // Node's types want web streams here; a pair of Node streams works.
      server.socket = Duplex.from(/** @type {any} */ ({ writable: toServer, readable: toClient }));
      server.socket.on("close", () => (server.closed = true));
      return server.socket;
    },
    /** @param {keyof typeof import("../src/mumble/proto.mjs").TYPES} type @param {Buffer | Record<string, unknown>} message */
    send: (type, message) =>
      toClient.write(
        frame(type, Buffer.isBuffer(message) ? message : encode(/** @type {keyof Messages} */ (type), stand(message))),
      ),
    /** @template {keyof Messages} T @param {T} type @returns {Messages[T][]} */
    sent: type => got.filter(m => m.type === type).map(m => decode(type, m.body)),
    end: () => toClient.end(),
  };
  return server;
}

/** @typedef {ReturnType<typeof fake>} Server */

/** The server lets the client in: two channels, someone in one of them, and the client itself. @param {Server} server */
export function welcome(server) {
  server.send("ChannelState", { channel_id: 0, name: "Root" });
  server.send("ChannelState", { channel_id: 5, parent: 0, name: "Team Comms" });
  server.send("UserState", { session: 9, name: "arie", channel_id: 5, hash: "abc" });
  server.send("UserState", { session: 2, name: "stv.tf", channel_id: 0 });
  server.send("ServerSync", { session: 2, welcome_text: "hi" });
}

/** That, and the server moving the client to Team Comms as it asked. */
/** @param {Server} server */
export function welcomeIn(server) {
  welcome(server);
  server.send("UserState", { session: 2, actor: 2, channel_id: 5, recording: true });
}

/** A DNS lookup that answers `ips`. @param {string[]} ips @returns {import("../src/mumble/address.mjs").Lookup} */
export const lookupOf = ips => async (host, o) => (
  assert.equal(o.all, true),
  ips.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))
);
