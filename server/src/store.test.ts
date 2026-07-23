import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStore, MemoryStore, utcDay } from "./store.ts";

test("utcDay formats as YYYY-MM-DD in UTC", () => {
  assert.equal(utcDay(new Date("2026-07-23T23:59:59.999Z")), "2026-07-23");
  assert.equal(utcDay(new Date("2026-07-24T00:00:00.000Z")), "2026-07-24");
});

test("MemoryStore counts per user per day", async () => {
  const store = new MemoryStore();
  assert.equal(await store.getCount("u1", "2026-07-23"), 0);
  assert.equal(await store.increment("u1", "2026-07-23"), 1);
  assert.equal(await store.increment("u1", "2026-07-23"), 2);
  assert.equal(await store.getCount("u1", "2026-07-23"), 2);
  // Independent per day and per user.
  assert.equal(await store.getCount("u1", "2026-07-24"), 0);
  assert.equal(await store.getCount("u2", "2026-07-23"), 0);
});

test("FileStore persists across instances (round-trip)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sual-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const a = new FileStore(dir);
  assert.equal(await a.increment("u1", "2026-07-23"), 1);
  assert.equal(await a.increment("u1", "2026-07-23"), 2);
  assert.equal(await a.increment("u2", "2026-07-23"), 1);

  // A fresh instance lazily loads the same file.
  const b = new FileStore(dir);
  assert.equal(await b.getCount("u1", "2026-07-23"), 2);
  assert.equal(await b.getCount("u2", "2026-07-23"), 1);
  assert.equal(await b.getCount("u3", "2026-07-23"), 0);

  // Atomic write: no leftover tmp files, valid JSON on disk.
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["usage.json"]);
  const onDisk = JSON.parse(await readFile(path.join(dir, "usage.json"), "utf8"));
  assert.deepEqual(onDisk, { "2026-07-23": { u1: 2, u2: 1 } });
});

test("FileStore tolerates a corrupt usage file", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sual-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "usage.json"), "not json", "utf8");
  const store = new FileStore(dir);
  assert.equal(await store.getCount("u1", "2026-07-23"), 0);
  assert.equal(await store.increment("u1", "2026-07-23"), 1);
});

test("FileStore serializes concurrent increments", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sual-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await Promise.all(
    Array.from({ length: 10 }, () => store.increment("u1", "2026-07-23")),
  );
  assert.equal(await store.getCount("u1", "2026-07-23"), 10);
});
