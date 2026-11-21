import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { orderedTranscript, parseInquiryDecision, VoiceServiceError, type CallRecord, type Decision, type InquiryTurn, type VoiceServices } from "./contracts.ts";
import { Handoff, HttpError, presenceTimeout } from "./handoffs.ts";
import { createCallRecords, recordCleanupIntervalMs } from "./call-records.ts";
import { recoveryChoice, wantsPause } from "./utterance.ts";

type Call = {
  controller: AbortController;
  transcript: string | null;
  decision: Decision | null;
  endedAt: string | null;
  save: Promise<CallRecord | undefined> | null;
  processing: boolean;
  seenAt: number;
  conversation: Map<number, string>;
  handoffs: Handoff[];
  inquiryHistory: InquiryTurn[];
  retries: number;
  dialogueVersion: number;
  lastPrompt: string;
  correctionFor?: string;
};

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "JSON 요청이 필요합니다.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    length += part.length;
    if (length > limit) throw new HttpError(413, "요청 내용이 너무 깁니다.");
    chunks.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || !value || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "요청 형식이 올바르지 않습니다.");
  }
}

async function readInquiry(request: IncomingMessage) {
  const { transcript, correction } = await readJson(request, 12_000);
  if (correction !== undefined && typeof correction !== "string") throw new HttpError(400, "정정할 인계를 확인해 주세요.");
  return { transcript: requireTranscript(transcript), correction };
}

function responseSignal(response: ServerResponse, callSignal: AbortSignal) {
  const connection = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) connection.abort();
  });
  if (response.destroyed) connection.abort();
  return AbortSignal.any([callSignal, connection.signal]);
}

function requireTranscript(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) {
    throw new HttpError(400, "문의 전사를 확인해 주세요.");
  }
  return value.trim();
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }).end(JSON.stringify(value));
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const pages: Record<string, string> = { "/": "index.html", "/agent": "agent.html", "/records": "records.html" };

export function createVoiceServer(
  services: VoiceServices, recordsDirectory: string, webDirectory: string, now = Date.now,
) {
  const calls = new Map<string, Call>();
  const records = createCallRecords(recordsDirectory, now);
  let openingCall = false;
  let agent: { id: string; seenAt: number; selected?: Handoff } | undefined;

  async function save(id: string, call: Call): Promise<CallRecord | undefined> {
    const record: CallRecord = { id, transcript: call.transcript, decision: call.decision, endedAt: call.endedAt! };
    if (call.handoffs.length) {
      record.handoffAttempts = call.handoffs.map(({ id, outcome }) => ({ id, outcome }));
      record.handoff = record.handoffAttempts.at(-1);
    }
    if (call.conversation.size) record.conversationTranscript = orderedTranscript(call.conversation);
    const saved = await records.save(record);
    calls.delete(id);
    return saved;
  }

  function endCall(id: string, call: Call) {
    call.endedAt ??= new Date(now()).toISOString();
    call.controller.abort();
    call.handoffs.at(-1)?.close("cancelled");
    call.save ??= save(id, call).catch(() => {
      call.save = null;
      throw new HttpError(500, "통화 기록을 저장하지 못했습니다. 다시 시도해 주세요.");
    });
    return call.save;
  }

  function reap() {
    const time = now();
    if (agent && time - agent.seenAt >= presenceTimeout) {
      agent.selected?.close("failed");
      agent = undefined;
    }
    for (const [id, call] of calls) {
      call.handoffs.at(-1)?.expire(time);
      if (time - call.seenAt >= presenceTimeout && !call.save) {
        void endCall(id, call).catch(() => {});
      }
    }
  }

  function pendingHandoff() {
    for (const call of calls.values()) {
      const handoff = call.handoffs.at(-1);
      if (handoff?.phase === "pending") return handoff;
    }
  }

  function beginHandoff(decision: Decision) {
    const handoff = new Handoff(decision, now());
    void handoff.prepareSummary(services.speak);
    return handoff;
  }

  function cancelForCorrection(call: Call, id: string) {
    const previous = call.handoffs.at(-1);
    previous?.expire(now());
    if (!previous || previous.id !== id || (previous.phase !== "pending" && call.correctionFor !== id)) {
      throw new HttpError(409, "이미 수락되었거나 종료된 인계입니다.");
    }
    if (previous.phase === "pending") {
      previous.close("cancelled");
      call.decision = null;
      call.correctionFor = id;
      call.dialogueVersion++;
    }
  }

  function recoveryPrompt(handoff: Handoff, retries: number) {
    const reason = handoff.phase === "rejected" ? "담당자가 요청을 거절했습니다."
      : handoff.phase === "expired" ? "담당자가 응답하지 않았습니다." : "담당자와 연결하지 못했습니다.";
    return retries ? `${reason} 다른 문의 또는 종료 중 선택해 주세요.`
      : `${reason} 같은 부서로 한 번 더 연결하거나, 다른 문의를 하거나, 종료할 수 있습니다. 어떻게 할까요?`;
  }

  async function recover(request: IncomingMessage, response: ServerResponse, call: Call) {
    const { id, transcript } = await readJson(request, 12_000);
    const handoff = call.handoffs.at(-1);
    if (call.endedAt || call.processing || !call.decision || !handoff || handoff.id !== id ||
      !["rejected", "expired", "failed"].includes(handoff.phase)) {
      throw new HttpError(409, "이미 처리되었거나 유효하지 않은 인계입니다.");
    }
    if (transcript !== undefined && (typeof transcript !== "string" || !transcript.trim() || transcript.length > 2000)) {
      throw new HttpError(400, "응답 전사를 확인해 주세요.");
    }
    const signal = responseSignal(response, call.controller.signal);
    signal.throwIfAborted();
    call.dialogueVersion++;
    const choice = typeof transcript === "string" ? transcript : "";
    const action = recoveryChoice(choice);
    const other = action === "new";
    const finish = action === "end";
    const retry = action === "retry" && !call.retries;
    if (finish) {
      call.transcript = [call.transcript, choice].filter(Boolean).join("\n");
      json(response, 200, { end: true });
      return;
    }
    call.processing = true;
    try {
      const previous = call.decision;
      const reply = retry ? `같은 ${previous.department} 부서에 한 번 더 연결을 요청하겠습니다.`
        : other ? "다른 문의 내용을 말씀해 주세요." : recoveryPrompt(handoff, call.retries);
      const audio = await services.speak(reply, signal);
      signal.throwIfAborted();
      call.lastPrompt = reply;
      if (choice) call.transcript = [call.transcript, choice].filter(Boolean).join("\n");
      if (other) {
        call.decision = null;
        call.inquiryHistory.length = 0;
        call.retries = 0;
      }
      const next = retry ? beginHandoff(previous) : null;
      if (next) {
        call.retries++;
        call.handoffs.push(next);
      }
      json(response, 200, {
        transcript: call.transcript, decision: call.decision, reply, audio: Buffer.from(audio).toString("base64"),
        handoff: next?.view("caller") ?? null, recoveryFor: other || next ? undefined : handoff.id,
      });
    } finally {
      call.processing = false;
    }
  }

  async function interrupt(request: IncomingMessage, response: ServerResponse, call: Call) {
    const body = await readJson(request, 12_000);
    const transcript = requireTranscript(body.transcript);
    const { handoffId } = body;
    if (handoffId !== undefined && typeof handoffId !== "string") throw new HttpError(400, "인계 번호를 확인해 주세요.");
    if (call.processing) throw new HttpError(409, "이 통화의 문의를 처리하고 있습니다.");
    const version = ++call.dialogueVersion;
    const pending = call.handoffs.at(-1);
    const signal = responseSignal(response, call.controller.signal);
    const requireCurrentRequest = () => {
      signal.throwIfAborted();
      if (version !== call.dialogueVersion) throw new HttpError(409, "새로운 안내를 처리하고 있습니다.");
      pending?.expire(now());
      if (handoffId && (!pending || pending !== call.handoffs.at(-1) ||
        pending.id !== handoffId || pending.phase !== "pending")) {
        throw new HttpError(409, "이미 수락되었거나 종료된 인계입니다.");
      }
    };
    requireCurrentRequest();
    const context = handoffId
      ? `${call.decision?.department} 담당자 수락 대기 중이며 응답이 오면 연결한다. 방금 안내: ${call.lastPrompt}`
      : call.lastPrompt || "AI가 문의를 안내하는 중이다.";
    const raw = await services.answerInterruption?.(transcript, context, signal);
    const result = raw as { pause?: unknown; reply?: unknown } | undefined;
    if (!result || typeof result.pause !== "boolean" || typeof result.reply !== "string" ||
      (!result.pause && !result.reply.trim())) throw new VoiceServiceError("끼어든 발화에 응답할 수 없습니다.");
    requireCurrentRequest();
    const reply = result.pause || wantsPause(transcript) ? "" : result.reply.trim();
    const audio = reply ? await services.speak(reply, signal) : null;
    requireCurrentRequest();
    call.transcript = [call.transcript, transcript].filter(Boolean).join("\n");
    if (reply) call.lastPrompt = reply;
    json(response, 200, {
      transcript: call.transcript, decision: call.decision, reply, audio: audio ? Buffer.from(audio).toString("base64") : "",
      handoff: handoffId ? pending?.view("caller") : null,
    });
  }

  async function agentRequest(request: IncomingMessage, response: ServerResponse, id: string, action: string) {
    if (!agent || agent.id !== id) throw new HttpError(410, "담당자 대기를 다시 시작해 주세요.");
    const participant = agent;
    participant.seenAt = now();
    if (action === "leave") {
      participant.selected?.close("failed");
      agent = undefined;
      json(response, 200, {});
      return;
    }
    if (action === "poll") {
      const handoff = participant.selected ??= pendingHandoff();
      if (participant.selected && !participant.selected.active) participant.selected = undefined;
      json(response, 200, { handoff: handoff?.view("agent") ?? null });
      return;
    }
    const body = await readJson(request, 100_000);
    reap();
    if (agent !== participant) throw new HttpError(410, "담당자 대기를 다시 시작해 주세요.");
    const handoff = participant.selected?.active ? participant.selected : pendingHandoff();
    if (!handoff || handoff.id !== body.id || !handoff.active) {
      throw new HttpError(409, "이미 처리되었거나 종료된 인계 요청입니다.");
    }
    if (action === "accept") {
      handoff.accept(id, now());
      participant.selected = handoff;
    } else if (action === "reject") {
      handoff.reject(id);
      participant.selected = handoff;
    } else if (action === "summary") {
      json(response, 200, { audio: Buffer.from(handoff.readSummary()).toString("base64") });
      return;
    } else {
      if (handoff.agentId !== id) throw new HttpError(409, "아직 수락되지 않은 인계 요청입니다.");
      applySignal(handoff, "agent", action, body);
    }
    json(response, 200, { handoff: handoff.view("agent") });
  }

  function applySignal(handoff: Handoff, side: "agent" | "caller", action: string, body: Record<string, unknown>) {
    switch (action) {
      case "answer":
      case "offer":
        handoff.registerDescription(side, readSdp(body));
        break;
      case "connected":
        handoff.confirmAudio(side);
        break;
      case "fail":
        handoff.close("failed");
        break;
    }
  }

  function readSdp(body: Record<string, unknown>) {
    if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=0") || !body.sdp.includes("m=audio ")) {
      throw new HttpError(400, "음성 연결 형식이 올바르지 않습니다.");
    }
    return body.sdp;
  }

  async function callerHandoff(request: IncomingMessage, response: ServerResponse, handoff: Handoff, action: string) {
    if (action !== "poll") {
      const body = await readJson(request, 100_000);
      reap();
      if (body.id !== handoff.id) throw new HttpError(409, "유효하지 않은 인계 요청입니다.");
      applySignal(handoff, "caller", action, body);
    }
    json(response, 200, { handoff: handoff.view("caller") });
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const host = request.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      throw new HttpError(403, "로컬 브라우저에서 접속해 주세요.");
    }
    const origin = request.headers.origin;
    if (origin && origin !== "http://" + host) throw new HttpError(403, "같은 사이트에서 요청해 주세요.");

    const path = request.url?.split("?")[0] || "/";
    if (request.method === "GET" && (pages[path] || /^\/assets\/[\w.-]+$/.test(path))) {
      const file = pages[path] ?? path.slice(1);
      const contentType = contentTypes[extname(file)];
      if (!contentType) throw new HttpError(404, "페이지를 찾을 수 없습니다.");
      const data = await readFile(join(webDirectory, file)).catch(() => {
        throw new HttpError(404, "페이지를 찾을 수 없습니다. npm run build를 실행해 주세요.");
      });
      response.writeHead(200, { "Content-Type": contentType }).end(data);
      return;
    }

    if (request.method === "GET" && path === "/api/records") {
      json(response, 200, await records.list());
      return;
    }
    if (request.method === "GET" && path.startsWith("/api/records/")) {
      const record = await records.get(path.slice("/api/records/".length));
      if (!record) throw new HttpError(404, "통화 기록을 찾을 수 없습니다.");
      json(response, 200, record);
      return;
    }

    if (request.method !== "POST") throw new HttpError(404, "요청을 찾을 수 없습니다.");
    reap();
    if (path === "/api/agent/join") {
      if (agent) throw new HttpError(409, "다른 담당자 화면에서 이미 대기 중입니다.");
      agent = { id: randomUUID(), seenAt: now() };
      json(response, 201, { id: agent.id });
      return;
    }
    const agentRoute = /^\/api\/agent\/([a-f0-9-]{36})\/(poll|leave|accept|reject|summary|answer|connected|fail)$/.exec(path);
    if (agentRoute) return agentRequest(request, response, agentRoute[1], agentRoute[2]);
    const handoffRoute = /^\/api\/calls\/([a-f0-9-]{36})\/handoff\/(poll|offer|connected|fail)$/.exec(path);
    if (handoffRoute) {
      const call = calls.get(handoffRoute[1]);
      const handoff = call?.handoffs.at(-1);
      if (!call || !handoff || call.endedAt) throw new HttpError(410, "종료되었거나 없는 인계 요청입니다.");
      call.seenAt = now();
      return callerHandoff(request, response, handoff, handoffRoute[2]);
    }

    if (request.method === "POST" && path === "/api/calls") {
      if (openingCall || calls.size) throw new HttpError(409, "이미 진행 중인 통화가 있습니다.");
      openingCall = true;
      const id = randomUUID();
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const speech = await services.speechToken(controller.signal);
        controller.signal.throwIfAborted();
        calls.set(id, {
          controller, transcript: null, decision: null, endedAt: null, save: null,
          processing: false, seenAt: now(), conversation: new Map(), handoffs: [], inquiryHistory: [],
          retries: 0, dialogueVersion: 0, lastPrompt: "",
        });
        json(response, 201, { id, speech });
      } finally {
        openingCall = false;
      }
      return;
    }

    const match = /^\/api\/calls\/([a-f0-9-]{36})\/(presence|speech-token|inquiry|correction-start|recovery|interruption|conversation|end)$/.exec(path);
    if (request.method !== "POST" || !match) throw new HttpError(404, "요청을 찾을 수 없습니다.");
    const [, id, action] = match;
    const call = calls.get(id);

    if (action === "end") {
      const saved = call ? await endCall(id, call) : await records.get(id);
      if (!saved) throw new HttpError(404, "통화를 찾을 수 없습니다.");
      json(response, 200, saved);
      return;
    }

    if (!call || call.endedAt) throw new HttpError(409, "이미 종료된 통화입니다.");
    const signal = responseSignal(response, call.controller.signal);
    call.seenAt = now();
    if (action === "correction-start") {
      const body = await readJson(request, 12_000);
      signal.throwIfAborted();
      if (typeof body.id !== "string") throw new HttpError(400, "정정할 인계를 확인해 주세요.");
      if (call.processing) throw new HttpError(409, "이 통화의 문의를 처리하고 있습니다.");
      cancelForCorrection(call, body.id);
      json(response, 200, {});
      return;
    }
    if (action === "recovery") return recover(request, response, call);
    if (action === "interruption") return interrupt(request, response, call);
    if (action === "presence") {
      json(response, 200, {});
      return;
    }
    if (action === "conversation") {
      const { id: handoffId, sequence, text } = await readJson(request, 12_000);
      const handoff = call.handoffs.at(-1);
      if (call.endedAt || handoff?.phase !== "connected" || handoff.id !== handoffId) {
        throw new HttpError(409, "인계 완료 후 통화 중일 때만 전사를 추가할 수 있습니다.");
      }
      if (
        typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1 || sequence > 10_000 ||
        typeof text !== "string" || !text.trim() || text.length > 2000
      ) throw new HttpError(400, "대화 전사 형식이 올바르지 않습니다.");
      const segment = text.trim();
      const existing = call.conversation.get(sequence);
      if (existing && existing !== segment) throw new HttpError(409, "이미 저장된 전사 순번입니다.");
      call.conversation.set(sequence, segment);
      json(response, 200, {});
      return;
    }
    if (action === "speech-token") {
      const speech = await services.speechToken(signal);
      signal.throwIfAborted();
      json(response, 200, speech);
      return;
    }

    const { transcript, correction } = await readInquiry(request);
    signal.throwIfAborted();
    if (call.processing) throw new HttpError(409, "이 통화의 문의를 처리하고 있습니다.");
    if (correction) {
      cancelForCorrection(call, correction);
      call.correctionFor = undefined;
    } else if (call.decision) {
      throw new HttpError(409, "이 통화의 문의가 이미 접수되었습니다.");
    }
    call.dialogueVersion++;
    call.processing = true;
    try {
      call.transcript = [call.transcript, transcript].filter(Boolean).join("\n");
      const { decision, reply } = parseInquiryDecision(await services.decide(transcript, signal, call.inquiryHistory));
      signal.throwIfAborted();
      const spoken = decision ? `${reply} 문의 내용은 ${decision.summary}입니다. ${decision.department} 담당자에게 연결을 요청하겠습니다.` : reply;
      const audio = await services.speak(spoken, signal);
      signal.throwIfAborted();
      call.lastPrompt = spoken;
      call.inquiryHistory.push({ text: transcript, reply });
      call.decision = decision;
      const handoff = decision ? beginHandoff(decision) : null;
      if (handoff) call.handoffs.push(handoff);
      json(response, 200, {
        transcript: call.transcript, decision, reply: spoken,
        audio: Buffer.from(audio).toString("base64"), handoff: handoff?.view("caller") ?? null,
      });
    } finally {
      call.processing = false;
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof HttpError) json(response, error.status, { error: error.message });
      else if (error instanceof Error && error.name === "AbortError") {
        json(response, 409, { error: "이미 종료된 통화입니다." });
      } else {
        const message = error instanceof VoiceServiceError
          ? error.message : "음성 문의를 처리하지 못했습니다.";
        json(response, 502, { error: message });
      }
    });
  });
  const sweep = setInterval(reap, 1000).unref();
  let purging = false;
  async function purge() {
    if (purging) return;
    purging = true;
    try {
      const failures = await records.purgeExpired();
      if (failures) console.warn(`통화 기록 ${failures}건을 정리하지 못했습니다. 다음 주기에 다시 시도합니다.`);
    } catch {
      console.warn("통화 기록을 정리하지 못했습니다. 다음 주기에 다시 시도합니다.");
    } finally {
      purging = false;
    }
  }
  const cleanup = setInterval(purge, recordCleanupIntervalMs).unref();
  server.once("listening", () => { void purge(); });
  server.on("close", () => {
    clearInterval(sweep);
    clearInterval(cleanup);
  });
  return server;
}
