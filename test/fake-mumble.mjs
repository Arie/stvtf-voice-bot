// A made-up Mumble server, for the tests.
import { PassThrough, Duplex } from "node:stream";
import { decode, encode, frame, Frames } from "../src/mumble/proto.mjs";

/** A made-up server: what the client sent it, and a way to send the client messages. */
export function fake() {
  const [toServer, toClient] = [new PassThrough(), new PassThrough()];
  const frames = new Frames();
  /** @type {{ type: string; body: Buffer }[]} */
  const got = [];
  toServer.on("data", d => got.push(...frames.push(d)));
  return {
    got,
    connect: () => Duplex.from({ writable: toServer, readable: toClient }),
    send: (type, message) => toClient.write(frame(type, Buffer.isBuffer(message) ? message : encode(type, message))),
    sent: type => got.filter(m => m.type === type).map(m => decode(type, m.body)),
    end: () => toClient.end(),
  };
}
export const tick = () => new Promise(r => setImmediate(r));

/** The server lets the client in: two channels, someone in one of them, and the client itself. */
export function welcome(server) {
  server.send("ChannelState", { channel_id: 0, name: "Root" });
  server.send("ChannelState", { channel_id: 5, parent: 0, name: "Team Comms" });
  server.send("UserState", { session: 9, name: "arie", channel_id: 5, hash: "abc" });
  server.send("UserState", { session: 2, name: "stv.tf", channel_id: 0 });
  server.send("ServerSync", { session: 2, welcome_text: "hi" });
}

/** That, and the server moving the client to Team Comms as it asked. */
export function welcomeIn(server) {
  welcome(server);
  server.send("UserState", { session: 2, actor: 2, channel_id: 5, recording: true });
}

