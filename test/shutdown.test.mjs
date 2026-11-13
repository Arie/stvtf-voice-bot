import assert from "node:assert/strict";
import { test } from "node:test";
import { stopOnSignal } from "../src/shutdown.mjs";
import { tick } from "./stand.mjs";

/** A made-up process: its signals, and how it exits. */
function world() {
  /** @type {Map<string, () => void>} */
  const handlers = new Map();
  /** @type {number[]} */
  const exits = [];
  let stops = 0;
  /** @type {() => void} */
  let stopped = () => {};
  /** @type {() => void} */
  let late = () => {};
  stopOnSignal({
    stop: () => (stops++, new Promise(r => (stopped = () => r(undefined)))),
    ms: 5000,
    on: (signal, f) => handlers.set(signal, f),
    exit: code => void exits.push(code),
    deadline: () => new Promise(r => (late = () => r())),
  });
  return { handlers, exits, stops: () => stops, stopped: () => stopped(), late: () => late() };
}

test("a signal stops it once, however many come, and it exits once stopped", async () => {
  const w = world();
  w.handlers.get("SIGTERM")?.();
  w.handlers.get("SIGINT")?.();
  w.handlers.get("SIGTERM")?.();
  await tick();
  assert.equal(w.stops(), 1);
  assert.deepEqual(w.exits, []);
  w.stopped();
  await tick();
  assert.deepEqual(w.exits, [0]);
});

test("a stop that hangs is given up on at the deadline", async () => {
  const w = world();
  w.handlers.get("SIGINT")?.();
  await tick();
  w.late();
  await tick();
  assert.deepEqual(w.exits, [0]);
});
