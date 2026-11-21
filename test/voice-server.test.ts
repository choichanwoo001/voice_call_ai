import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { CallRecord, Decision, VoiceServices } from "../src/contracts.ts";
import { createVoiceServer } from "../src/voice-server.ts";
import { asksAboutHandoff, isAnnouncementEcho, isBackchannel, recoveryChoice, wantsPause } from "../src/utterance.ts";

const transcript = "검사 시스템 신규 도입 견적을 받고 싶습니다.";
const decision: Decision = {
  department: "영업",
  summary: "검사 시스템 신규 도입 견적 요청",
  reply: "신규 도입 견적 문의로 확인했습니다.",
};

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

async function openCall(t: TestContext, overrides: Partial<VoiceServices> = {}, now = Date.now) {
  const records = await mkdtemp(join(tmpdir(), "ack-voice-test-"));
  const server = createVoiceServer({
    speechToken: async () => ({ token: "temporary", region: "koreacentral" }),
    decide: async (text) => { assert.equal(text, transcript); return decision; },
    speak: async () => Uint8Array.of(1, 2),
    ...overrides,
  }, records, "dist", now);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(records, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api`;
  const url = base + "/calls";
  const post = (path: string, body?: object, signal?: AbortSignal) => fetch(path, {
    method: "POST",
    signal,
    body: body && JSON.stringify(body),
    headers: body && { "content-type": "application/json" },
  });
  const start = await fetch(url, { method: "POST" });
  assert.equal(start.status, 201);
  const { id, speech } = await start.json();
  assert.equal(speech.token, "temporary");
  return {
    record: join(records, id + ".json"),
    startAnother: () => post(url),
    post: (action: string, body?: object, signal?: AbortSignal) => post(`${url}/${id}/${action}`, body, signal),
    async agent() {
      const join = await post(base + "/agent/join");
      assert.equal(join.status, 201);
      const { id } = await join.json();
      return (action: string, body?: object) => post(`${base}/agent/${id}/${action}`, body);
    },
  };
}

test("returns a renewal token, classifies an inquiry, returns audio and saves the ended call", async (t) => {
  const call = await openCall(t);
  const renewal = await call.post("speech-token");
  assert.equal(renewal.status, 200);
  assert.equal((await renewal.json()).token, "temporary");
  const response = await call.post("inquiry", { transcript });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.deepEqual(answer.decision, decision);
  assert.equal(answer.audio, "AQI=");
  const end = await call.post("end");
  const record: CallRecord = await end.json();
  assert.equal(end.status, 200);
  assert.equal(record.transcript, transcript);
  assert.deepEqual(record.decision, decision);
  assert.ok(Date.parse(record.endedAt));
  assert.deepEqual(JSON.parse(await readFile(call.record, "utf8")), record);
  assert.deepEqual(await (await call.post("end")).json(), record);
  assert.equal((await call.post("speech-token")).status, 409);
});

test("offers the agent a summary and completes only after both participants receive audio", async (t) => {
  const spoken: string[] = [];
  const call = await openCall(t, {
    speak: async (text) => { spoken.push(text); return Uint8Array.of(1, 2); },
  });
  const agent = await call.agent();
  assert.equal((await (await agent("poll")).json()).handoff, null);
  const { handoff } = await (await call.post("inquiry", { transcript })).json();
  const body = { id: handoff.id };
  assert.equal((await call.post("conversation", { ...body, sequence: 1, text: "연결 전" })).status, 409);
  assert.deepEqual(spoken, [
    `${decision.reply} 문의 내용은 ${decision.summary}입니다. ${decision.department} 담당자에게 연결을 요청하겠습니다.`,
    `${decision.department}. ${decision.summary}`,
  ]);
  const pending = (await (await agent("poll")).json()).handoff;
  assert.equal(pending.phase, "pending");
  assert.equal(pending.department, decision.department);
  assert.equal(pending.summary, decision.summary);
  assert.ok(pending.deadline - Date.now() > 25_000);
  assert.deepEqual(await (await agent("summary", body)).json(), { audio: "AQI=" });
  assert.equal((await call.post("handoff/offer", { ...body, sdp })).status, 409);
  assert.equal((await agent("accept", body)).status, 200);
  assert.equal((await agent("accept", body)).status, 409);
  assert.equal((await call.post("handoff/offer", { ...body, sdp })).status, 200);
  assert.equal((await (await agent("poll")).json()).handoff.remoteDescription, sdp);
  assert.equal((await agent("answer", { ...body, sdp })).status, 200);
  assert.equal((await (await call.post("handoff/poll")).json()).handoff.remoteDescription, sdp);
  assert.equal((await (await agent("connected", body)).json()).handoff.phase, "connecting");
  assert.equal((await (await call.post("handoff/connected", body)).json()).handoff.phase, "connected");
  const later = { ...body, sequence: 2, text: "내일까지 보내 주세요." };
  assert.equal((await call.post("conversation", later)).status, 200);
  assert.equal((await call.post("conversation", later)).status, 200);
  assert.equal((await call.post("conversation", { ...later, text: "다른 결과" })).status, 409);
  assert.equal((await call.post("conversation", { ...later, id: "wrong" })).status, 409);
  assert.equal((await call.post("conversation", { ...body, sequence: 1, text: "견적서를 준비하겠습니다." })).status, 200);
  await agent("fail", body);
  assert.equal((await call.post("conversation", { ...later, sequence: 3 })).status, 409);
  const record = await (await call.post("end")).json();
  assert.deepEqual(record.handoff, { ...body, outcome: "connected" });
  assert.deepEqual(record.handoffAttempts, [record.handoff]);
  assert.deepEqual(record.conversationTranscript, ["견적서를 준비하겠습니다.", later.text]);
  assert.equal((await call.post("conversation", { ...later, sequence: 3 })).status, 409);
  const finished = (await (await agent("poll")).json()).handoff;
  assert.equal(finished.phase, "ended");
  assert.equal(finished.remoteDescription, undefined);
  assert.equal((await agent("accept", body)).status, 409);
});

test("reserves one recognition slot and recovers a caller that disappears before inquiry", async (t) => {
  let time = Date.now();
  const call = await openCall(t, {}, () => time);
  assert.equal((await call.startAnother()).status, 409);
  time += 10_000;
  assert.equal((await call.post("presence")).status, 200);
  time += 10_000;
  assert.equal((await call.startAnother()).status, 409);
  time += 5000;
  assert.equal((await call.post("presence")).status, 409);
  assert.equal((await call.post("end")).status, 200);
  assert.equal((await call.startAnother()).status, 201);
});

test("an agent leaving during setup records failure", async (t) => {
  const call = await openCall(t);
  const agent = await call.agent();
  const { handoff } = await (await call.post("inquiry", { transcript })).json();
  assert.equal((await agent("accept", { id: handoff.id })).status, 200);
  assert.equal((await agent("leave")).status, 200);
  assert.equal((await (await call.post("handoff/poll")).json()).handoff.phase, "failed");
  assert.equal((await (await call.post("end")).json()).handoff.outcome, "failed");
});

test("a viewed request cannot be accepted without summary audio or reassigned after the agent leaves", async (t) => {
  const release = Promise.withResolvers<Uint8Array>();
  const call = await openCall(t, {
    speak: async (text) => text === `${decision.department}. ${decision.summary}`
      ? release.promise : Uint8Array.of(1, 2),
  });
  const agent = await call.agent();
  const { handoff } = await (await call.post("inquiry", { transcript })).json();
  const body = { id: handoff.id };
  try {
    assert.equal((await (await agent("poll")).json()).handoff.summaryAudio, "preparing");
    assert.equal((await agent("accept", body)).status, 409);
    assert.equal((await agent("leave")).status, 200);
    const replacement = await call.agent();
    assert.equal((await (await replacement("poll")).json()).handoff, null);
    assert.equal((await replacement("accept", body)).status, 409);
    assert.equal((await (await call.post("end")).json()).handoff.outcome, "failed");
  } finally {
    release.resolve(Uint8Array.of(1, 2));
  }
});

test("returns to AI, retries the same department only once and permits a new inquiry", async (t) => {
  const call = await openCall(t, { decide: async (text) => ({
    ...decision, department: text.includes("병리") ? "LIS" : "영업",
  }) });
  const agent = await call.agent();
  const first = (await (await call.post("inquiry", { transcript })).json()).handoff;
  assert.equal((await agent("reject", { id: first.id })).status, 200);
  const recovery = await (await call.post("recovery", { id: first.id })).json();
  assert.match(recovery.reply, /한 번 더/);
  assert.equal((await (await call.post("recovery", { id: first.id, transcript: "다시 연결하지 말아 주세요" })).json()).handoff, null);
  assert.equal((await (await call.post("recovery", { id: first.id, transcript: "종료하지 말아 주세요" })).json()).end, undefined);
  const next = (await (await call.post("recovery", { id: first.id, transcript: "다시 연결해 주세요" })).json()).handoff;
  assert.notEqual(next.id, first.id);
  assert.equal(next.department, first.department);
  assert.equal((await agent("poll")).status, 200);
  assert.equal((await agent("reject", { id: next.id })).status, 200);
  const exhausted = await (await call.post("recovery", { id: next.id, transcript: "한 번 더" })).json();
  assert.equal(exhausted.handoff, null);
  assert.doesNotMatch(exhausted.reply, /한 번 더/);
  assert.equal((await call.post("recovery", { id: next.id, transcript: "다른 문의요" })).status, 200);
  const third = (await (await call.post("inquiry", { transcript: "병리 문의입니다." })).json()).handoff;
  assert.equal(third.department, "LIS");
  assert.equal((await agent("poll")).status, 200);
  assert.equal((await agent("reject", { id: third.id })).status, 200);
  assert.deepEqual(await (await call.post("recovery", { id: third.id, transcript: "종료해 주세요" })).json(), { end: true });
  const result = await (await call.post("end")).json();
  assert.deepEqual(result.handoffAttempts.map((attempt: { outcome: string }) => attempt.outcome), ["rejected", "rejected", "rejected"]);
});

test("expired and rejected requests cannot subsequently be accepted", async (t) => {
  let time = Date.now();
  const call = await openCall(t, {}, () => time);
  const agent = await call.agent();
  const { handoff } = await (await call.post("inquiry", { transcript })).json();
  for (const advance of [10_000, 10_000, 9_999]) {
    time += advance;
    assert.equal((await (await agent("poll")).json()).handoff.phase, "pending");
    assert.equal((await (await call.post("handoff/poll")).json()).handoff.phase, "pending");
  }
  time += 1;
  assert.equal((await agent("accept", { id: handoff.id })).status, 409);
  assert.equal((await (await call.post("end")).json()).handoff.outcome, "expired");

  const next = await openCall(t);
  const nextAgent = await next.agent();
  const { handoff: another } = await (await next.post("inquiry", { transcript })).json();
  assert.equal((await nextAgent("reject", { id: another.id })).status, 200);
  assert.equal((await nextAgent("accept", { id: another.id })).status, 409);
  assert.equal((await (await next.post("end")).json()).handoff.outcome, "rejected");
});

test("rejects an invalid judgment and preserves only the transcript", async (t) => {
  const call = await openCall(t, {
    decide: async () => ({ ...decision, summary: "" }),
    speak: async () => { throw new Error("invalid output must not reach synthesis"); },
  });
  const response = await call.post("inquiry", { transcript });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /문의 요약/);
  const record = await (await call.post("end")).json();
  assert.equal(record.transcript, transcript);
  assert.equal(record.decision, null);
});

test("uses the confirmation question and answer before publishing a handoff", async (t) => {
  const call = await openCall(t, {
    decide: async (text, _, history) => {
      if (!history?.length) return { department: null, summary: "", reply: "어떤 뷰어인가요?" };
      assert.deepEqual(history, [{ text: "뷰어 오류입니다.", reply: "어떤 뷰어인가요?" }]);
      assert.equal(text, "LIS 장비 뷰어입니다.");
      return { department: "솔루션", summary: "LIS 장비 뷰어 오류", reply: "확인했습니다." };
    },
  });
  const agent = await call.agent();
  const first = await (await call.post("inquiry", { transcript: "뷰어 오류입니다." })).json();
  assert.equal(first.decision, null);
  assert.equal(first.handoff, null);
  assert.equal((await (await agent("poll")).json()).handoff, null);
  const second = await (await call.post("inquiry", { transcript: "LIS 장비 뷰어입니다." })).json();
  assert.equal(second.decision.department, "솔루션");
  assert.match(second.transcript, /뷰어 오류입니다.\nLIS 장비 뷰어입니다./);
  assert.equal((await (await agent("poll")).json()).handoff.summary, second.decision.summary);
});

test("cancels the old request before reclassifying and blocks stale accept or correction", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const call = await openCall(t, {
    decide: async (text) => {
      if (!text.includes("정정")) return decision;
      entered.resolve();
      await release.promise;
      return { ...decision, department: "솔루션", summary: "RTIS 오류" };
    },
  });
  const agent = await call.agent();
  const first = (await (await call.post("inquiry", { transcript })).json()).handoff;
  await agent("poll");
  assert.equal((await call.post("correction-start", { id: first.id })).status, 200);
  assert.equal((await agent("accept", { id: first.id })).status, 409);
  const corrected = call.post("inquiry", { transcript: "정정합니다. RTIS 오류입니다.", correction: first.id });
  await entered.promise;
  try {
    assert.equal((await agent("accept", { id: first.id })).status, 409);
    assert.equal((await (await call.post("handoff/poll")).json()).handoff.phase, "cancelled");
  } finally {
    release.resolve();
  }
  const next = (await (await corrected).json()).handoff;
  assert.equal(next.department, "솔루션");
  assert.notEqual(next.id, first.id);
  assert.equal((await agent("accept", { id: next.id })).status, 200);
  assert.equal((await call.post("inquiry", { transcript: "정정입니다", correction: next.id })).status, 409);
  const record = await (await call.post("end")).json();
  assert.deepEqual(record.handoffAttempts.map((item: { id: string }) => item.id), [first.id, next.id]);
  assert.equal(record.handoffAttempts[0].outcome, "cancelled");
});

test("ignores a decision returned after the caller hangs up", async (t) => {
  const started = Promise.withResolvers<AbortSignal>();
  const delayed = Promise.withResolvers<Decision>();
  const call = await openCall(t, {
    decide: async (_, signal) => { started.resolve(signal); return delayed.promise; },
    speak: async () => { assert.fail("late decision reached synthesis"); },
  });
  const pending = call.post("inquiry", { transcript });
  const signal = await started.promise;
  const end = await call.post("end");
  try {
    assert.equal(end.status, 200);
    assert.equal(signal.aborted, true);
    assert.equal((await end.json()).decision, null);
  } finally {
    delayed.resolve(decision);
  }
  assert.equal((await pending).status, 409);
  assert.equal(JSON.parse(await readFile(call.record, "utf8")).decision, null);
});

test("recognizes brief backchannels and echoed announcement text without treating corrections as acknowledgments", () => {
  assert.equal(isBackchannel("아, 그렇군요."), true);
  assert.equal(isBackchannel("네, EMR 장비예요."), false);
  assert.equal(isAnnouncementEcho("영업 담당자에게 연결을 요청하겠습니다.", "신규 도입 견적입니다. 영업 담당자에게 연결을 요청하겠습니다."), true);
  assert.equal(isAnnouncementEcho("어느 부서에 연결하나요?", "영업 담당자에게 연결을 요청하겠습니다."), false);
  assert.equal(wantsPause("잠깐만요."), true);
  assert.equal(wantsPause("검사실 뷰어가 멈춰요."), false);
  assert.equal(asksAboutHandoff("환자감시장치 뷰어가 멈췄는데 어떻게 하나요?"), false);
  assert.equal(asksAboutHandoff("전화번호가 뭐예요?"), true);
  assert.equal(recoveryChoice("다시 연결하면 얼마나 기다려야 하나요?"), undefined);
  assert.equal(recoveryChoice("종료하면 다시 전화해야 하나요?"), undefined);
});

test("an interrupted announcement can pause or answer without replacing the pending request", async (t) => {
  const call = await openCall(t, {
    answerInterruption: async (text, context) => {
      assert.match(context, /영업 담당자 수락 대기/);
      return wantsPause(text) ? { pause: true, reply: "" } : { pause: false, reply: "영업 부서의 응답을 기다리고 있습니다." };
    },
  });
  const { handoff } = await (await call.post("inquiry", { transcript })).json();
  const pause = await (await call.post("interruption", { transcript: "잠깐만요.", handoffId: handoff.id })).json();
  assert.equal(pause.audio, "");
  assert.equal(pause.handoff.id, handoff.id);
  const answer = await (await call.post("interruption", { transcript: "어느 부서인가요?", handoffId: handoff.id })).json();
  assert.match(answer.reply, /영업/);
  assert.equal(answer.handoff.id, handoff.id);
});

test("a disconnected correction cannot publish a replacement handoff", async (t) => {
  const processing = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const caller = new AbortController();
  const call = await openCall(t, {
    decide: async (text, signal) => {
      if (!text.includes("정정")) return decision;
      processing.resolve(signal);
      await release.promise;
      return { ...decision, department: "LIS" };
    },
  });
  const agent = await call.agent();
  const original = (await (await call.post("inquiry", { transcript })).json()).handoff;
  await agent("poll");
  const request = call.post("inquiry", { transcript: "정정합니다.", correction: original.id }, caller.signal);
  const signal = await processing.promise;
  const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  caller.abort();
  try {
    await assert.rejects(request, { name: "AbortError" });
    await aborted;
  } finally {
    release.resolve();
  }
  const record = await (await call.post("end")).json();
  assert.deepEqual(record.handoffAttempts, [{ id: original.id, outcome: "cancelled" }]);
  assert.equal(record.decision, null);
});

test("a late interruption response cannot replace a newer dialogue turn", async (t) => {
  const processing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const call = await openCall(t, {
    answerInterruption: async () => {
      processing.resolve();
      await release.promise;
      return { pause: false, reply: "지연된 이전 안내입니다." };
    },
  });
  const request = call.post("interruption", { transcript: "잠깐만요." });
  await processing.promise;
  try {
    assert.equal((await call.post("inquiry", { transcript })).status, 200);
  } finally {
    release.resolve();
  }
  assert.equal((await request).status, 409);
  assert.equal((await (await call.post("end")).json()).transcript, transcript);
});
