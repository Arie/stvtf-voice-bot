import assert from "node:assert/strict";
import { test } from "node:test";
import { mayControl } from "../src/discord/control.mjs";

test("only someone in the bot's voice channel changes its delay or sends it away", () => {
  assert.equal(mayControl("1", "1"), true);
  assert.equal(mayControl("2", "1"), false, "in another channel");
  assert.equal(mayControl(null, "1"), false, "in none");
  assert.equal(mayControl(undefined, "1"), false);
});
