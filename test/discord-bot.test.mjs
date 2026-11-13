import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { startDiscord } from "../src/discord/bot.mjs";
import { stand, tick } from "./stand.mjs";

test("a token Discord will not have is said, not left unheard", async () => {
  const client = Object.assign(new EventEmitter(), {
    login: async () => Promise.reject(new Error("An invalid token was provided.")),
    destroy: async () => {},
  });
  /** @type {Error[]} */
  const failed = [];
  const bot = startDiscord({
    hosts: ["stv.tf"],
    key: "k",
    token: "t",
    onLoginFailed: e => void failed.push(e),
    client: stand(client),
  });
  await tick();
  assert.deepEqual(
    failed.map(e => e.message),
    ["An invalid token was provided."],
  );
  await bot.stop("done");
});
