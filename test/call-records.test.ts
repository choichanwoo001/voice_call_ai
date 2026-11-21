import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createCallRecords, recordCleanupIntervalMs, recordRetentionMs } from "../src/call-records.ts";
import type { CallRecord, VoiceServices } from "../src/contracts.ts";
import { createVoiceServer } from "../src/voice-server.ts";

const baseTime = Date.parse("2026-11-20T00:00:00Z");
const firstId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const thirdId = "cccccccc-3333-4333-8333-cccccccccccc";
const services: VoiceServices = {
  speechToken: async () => ({ token: "temporary", region: "koreacentral" }),
  decide: async () => { assert.fail("record tests do not use a language model"); },
  speak: async () => { assert.fail("record tests do not use synthesis"); },
};

function legacyRecord(id: string, endedAt: number): CallRecord {
  return { id, endedAt: new Date(endedAt).toISOString(), transcript: "가상 문의", decision: null };
}

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ack-retention-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startServer(directory: string, now: () => number) {
  const server = createVoiceServer(services, directory, "dist", now);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function waitForDeletion(directory: string, name: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await readdir(directory)).includes(name)) return;
    await wait(10);
  }
  assert.fail(`${name} was not removed by the scheduled cleanup`);
}

test("lists legacy and newer records, then deletes records at seven days without a page visit", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const directory = await temporaryDirectory(t);
  let time = baseTime;
  const hoursOld = legacyRecord(firstId, time - 3600000);
  const almostExpired = {
    ...legacyRecord(secondId, time - recordRetentionMs + 1),
    decision: { department: "영업", summary: "견적 문의", reply: "문의 확인" },
    handoff: { id: thirdId, outcome: "connected" },
    conversationTranscript: ["금요일에 견적을 보내겠습니다."],
  } satisfies CallRecord;
  const expired = legacyRecord(thirdId, time - recordRetentionMs);
  await Promise.all([hoursOld, almostExpired, expired].map((record) =>
    writeFile(join(directory, record.id + ".json"), JSON.stringify(record))));

  const server = await startServer(directory, () => time);
  try {
    await waitForDeletion(directory, thirdId + ".json");
    const list = await fetch(server.url + "/api/records");
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.deepEqual(await list.json(), [
      { id: firstId, endedAt: hoursOld.endedAt },
      { id: secondId, endedAt: almostExpired.endedAt, department: "영업", outcome: "connected" },
    ]);
    assert.deepEqual(await (await fetch(server.url + "/api/records/" + secondId)).json(), almostExpired);
    time += 1;
    t.mock.timers.tick(recordCleanupIntervalMs);
    await waitForDeletion(directory, secondId + ".json");
    assert.equal((await fetch(server.url + "/api/records/" + secondId)).status, 404);
    assert.equal((await fetch(server.url + "/api/calls/" + secondId + "/end", { method: "POST" })).status, 404);
    assert.equal((await fetch(server.url + "/api/calls/" + secondId + "/conversation", { method: "POST" })).status, 409);
    assert.deepEqual(await readdir(directory), [firstId + ".json"]);
  } finally {
    await server.close();
  }
  const restarted = await startServer(directory, () => time + recordRetentionMs);
  try {
    await waitForDeletion(directory, firstId + ".json");
  } finally {
    await restarted.close();
  }
});

test("continues cleanup after one removal fails and retries using the original end time", async (t) => {
  const directory = await temporaryDirectory(t);
  const stale = legacyRecord(firstId, baseTime - recordRetentionMs);
  const staleFile = join(directory, firstId + ".json");
  const incomplete = join(directory, secondId + ".json.tmp");
  const unrelated = join(directory, "notes.txt");
  await writeFile(staleFile, JSON.stringify(stale));
  await writeFile(incomplete, "{");
  await writeFile(unrelated, "keep");
  let remainingFailures = 1;
  const records = createCallRecords(directory, () => baseTime, async (path) => {
    if (basename(path) === firstId + ".json" && remainingFailures-- > 0) throw new Error("temporary denial");
    await unlink(path);
  });
  assert.equal(await records.purgeExpired(), 1);
  assert.deepEqual(JSON.parse(await readFile(staleFile, "utf8")), stale);
  assert.equal(await records.get(stale.id), undefined);
  assert.deepEqual(await records.list(), []);
  assert.deepEqual((await readdir(directory)).sort(), [firstId + ".json", "notes.txt"]);
  assert.equal(await records.purgeExpired(), 0);
  await records.save(stale);
  assert.equal(await records.purgeExpired(), 0);
  assert.deepEqual(await readdir(directory), ["notes.txt"]);
});

test("a failed save retry preserves the original server end time", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "records");
  await writeFile(directory, "save temporarily blocked");
  let time = baseTime;
  const server = await startServer(directory, () => time);
  try {
    const opened = await fetch(server.url + "/api/calls", { method: "POST" });
    assert.equal(opened.status, 201);
    const { id } = await opened.json();
    const end = () => fetch(server.url + "/api/calls/" + id + "/end", { method: "POST" });
    assert.equal((await end()).status, 500);
    await unlink(directory);
    time += 1000;
    const retried = await end();
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).endedAt, new Date(baseTime).toISOString());
    assert.deepEqual(await (await fetch(server.url + "/api/records")).json(), [
      { id, endedAt: new Date(baseTime).toISOString() },
    ]);
  } finally {
    await server.close();
  }
});

test("a write retried after the retention deadline does not return or recreate the ended call", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "records");
  await writeFile(directory, "save temporarily blocked");
  let time = baseTime;
  const server = await startServer(directory, () => time);
  try {
    const opened = await fetch(server.url + "/api/calls", { method: "POST" });
    assert.equal(opened.status, 201);
    const { id } = await opened.json();
    const end = () => fetch(server.url + "/api/calls/" + id + "/end", { method: "POST" });
    assert.equal((await end()).status, 500);
    await unlink(directory);
    time += recordRetentionMs;
    assert.equal((await end()).status, 404);
    assert.deepEqual(await (await fetch(server.url + "/api/records")).json(), []);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await server.close();
  }
});
