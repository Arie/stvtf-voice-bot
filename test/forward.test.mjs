import assert from "node:assert/strict";
import { test } from "node:test";
import { Forwarder } from "../src/forward.mjs";
import { fetchOf, tick } from "./stand.mjs";

/** A post's body, as the forwarder sends it. @typedef {{ invite?: string; steamid: string | null; discord: string; name: string; channel?: string; frames: string[]; delay: number }} Body */

const speaker = { steamid: "[U:1:5]", id: "1", name: "a" };

/**
 * A fetch that records what was posted and answers as told.
 * @param {(n: number) => { status: number; text: string } | Promise<{ status: number; text: string }>} answer
 */
function fake(answer = () => ({ status: 200, text: "held until tick 1" })) {
  /** @type {{ url: string; auth: string; body: Body }[]} */
  const posts = [];
  const fetch = fetchOf(async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ url, auth: init.headers.Authorization, body });
    const a = await answer(posts.length);
    return { status: a.status, ok: a.status < 300, text: async () => a.text };
  });
  return { posts, fetch };
}

test("frames go five at a time, in order, with the speaker, the delay and the key", async () => {
  const { posts, fetch } = fake();
  const f = new Forwarder({ url: "https://stv.tf/w/x/voice", key: "k", delay: 90, fetch });
  for (let i = 0; i < 12; i++) f.add(speaker, Buffer.from([i]));
  await f.flush();
  assert.deepEqual(
    posts.map(p => p.body.frames.length),
    [5, 5, 2],
  );
  assert.deepEqual(
    posts.flatMap(p => p.body.frames).map(b => Buffer.from(b, "base64")[0]),
    [...Array(12).keys()],
  );
  assert.deepEqual(
    [posts[0].auth, posts[0].body.steamid, posts[0].body.delay, posts[0].url],
    ["Bearer k", "[U:1:5]", 90, "https://stv.tf/w/x/voice"],
  );
});

test("each speaker has batches of their own", async () => {
  const { posts, fetch } = fake();
  const f = new Forwarder({ url: "u", key: "k", delay: 0, fetch });
  f.add(speaker, Buffer.from([1]));
  f.add({ steamid: null, id: "2", name: "coach" }, Buffer.from([2]));
  await f.flush();
  assert.equal(posts.length, 2);
  assert.deepEqual([posts[1].body.steamid, posts[1].body.discord, posts[1].body.name], [null, "2", "coach"]);
});

test("slow posts keep their order", async () => {
  // The first answers only after a few turns, once the rest have come.
  const { posts, fetch } = fake(async n => {
    for (let t = 0; t < (n === 1 ? 5 : 0); t++) await tick();
    return { status: 200, text: "ok" };
  });
  const f = new Forwarder({ url: "u", key: "k", delay: 90, fetch });
  for (let i = 0; i < 10; i++) f.add(speaker, Buffer.from([i]));
  await f.flush();
  assert.deepEqual(
    posts.flatMap(p => p.body.frames).map(b => Buffer.from(b, "base64")[0]),
    [...Array(10).keys()],
  );
});

test("a match that is gone, or a refused key, stops it and says why", async () => {
  for (const [status, why] of /** @type {[number, RegExp][]} */ ([
    [404, /ended/],
    [401, /key/],
  ])) {
    const { posts, fetch } = fake(() => ({ status, text: "" }));
    let stopped = "";
    const f = new Forwarder({ url: "u", key: "k", delay: 90, fetch, onStop: w => (stopped = w) });
    for (let i = 0; i < 10; i++) f.add(speaker, Buffer.from([i]));
    await f.flush();
    assert.equal(posts.length, 1, "no more after the first refusal");
    assert.match(stopped, why);
    assert.equal(f.stopped, true);
  }
});

test("a hiccup (the stream not there yet, the site restarting) is waited out, not fatal", async () => {
  const { posts, fetch } = fake(n => (n === 1 ? { status: 409, text: "no stream yet" } : { status: 200, text: "ok" }));
  const f = new Forwarder({ url: "u", key: "k", delay: 90, fetch });
  for (let i = 0; i < 10; i++) f.add(speaker, Buffer.from([i]));
  await f.flush();
  assert.equal(f.stopped, false);
  assert.equal(posts.length, 2, "the next batch still goes");
});

test("the delay can change as it goes", async () => {
  const { posts, fetch } = fake();
  const f = new Forwarder({ url: "u", key: "k", delay: 90, fetch });
  f.add(speaker, Buffer.from([1]));
  await f.flush();
  f.delay = 0;
  f.add(speaker, Buffer.from([2]));
  await f.flush();
  assert.deepEqual(
    posts.map(p => p.body.delay),
    [90, 0],
  );
});

test("posts say which voice channel the speaker is in", async () => {
  const { posts, fetch } = fake();
  const f = new Forwarder({ url: "https://stv.tf/w/x/voice", key: "k", delay: 90, channel: "42", fetch });
  f.add(speaker, Buffer.from([1]));
  await f.flush();
  assert.equal(posts[0].body.channel, "42");
});

test("what waits behind a slow post goes as one post a speaker, and a post has a time limit", async () => {
  /** @type {{ body: Body; signal?: AbortSignal }[]} */
  const posts = [];
  /** @type {(() => void)[]} */
  const answers = [];
  const fetch = fetchOf((url, init) => {
    posts.push({ body: JSON.parse(init.body), signal: init.signal });
    return new Promise(r => answers.push(() => r({ status: 200, ok: true, text: async () => "held" })));
  });
  const f = new Forwarder({ url: "u", key: "k", delay: 90, fetch });
  for (let i = 0; i < 5; i++) f.add(speaker, Buffer.from([i]));
  await tick();
  for (let i = 5; i < 20; i++) f.add(speaker, Buffer.from([i]));
  const done = f.flush();
  await tick();
  assert.equal(posts.length, 1, "one at a time");
  assert.ok(posts[0].signal instanceof AbortSignal);
  answers[0]();
  await tick();
  answers[1]();
  await done;
  assert.deepEqual(
    posts.map(p => p.body.frames.length),
    [5, 15],
  );
  assert.deepEqual(
    posts.flatMap(p => p.body.frames).map(b => Buffer.from(b, "base64")[0]),
    [...Array(20).keys()],
  );
});

test("posts carry the invite, and a refused one stops it", async () => {
  const { posts, fetch } = fake(() => ({ status: 403, text: "not invited" }));
  let why = "";
  const f = new Forwarder({ url: "u", key: "k", delay: 90, invite: "abc", fetch, onStop: w => (why = w) });
  f.add(speaker, Buffer.from([1]));
  await f.flush();
  assert.equal(posts[0].body.invite, "abc");
  assert.match(why, /invite/);
  assert.equal(f.stopped, true);
});

test("behind a slow post, speakers taking turns add nothing to wait on but what waits", async () => {
  /** @type {(() => void)[]} */
  const answers = [];
  let posts = 0;
  const fetch = fetchOf(
    () => (posts++, new Promise(r => answers.push(() => r({ status: 200, ok: true, text: async () => "" })))),
  );
  const f = new Forwarder({ url: "u", key: "k", delay: 90, fetch });
  for (let i = 0; i < 5; i++) f.add(speaker, Buffer.from([i]));
  await tick();
  const posting = f.posting;
  const other = { steamid: null, id: "2", name: "b" };
  for (let n = 0; n < 1000; n++) for (let i = 0; i < 5; i++) f.add(n % 2 ? speaker : other, Buffer.from([i]));
  assert.equal(f.posting, posting, "one loop drains them all");
  assert.equal(f.waiting.length, 100);
  for (let n = 0; n < 200 && answers.length; n++) {
    answers.shift()?.();
    await tick();
  }
  await f.flush();
  assert.equal(posts, 101);
});
