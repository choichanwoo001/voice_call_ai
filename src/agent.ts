import { audioUrl, microphone, poll, post, stopMicrophone } from "./browser-voice.ts";
import type { HandoffView } from "./contracts.ts";
import { createVoicePeer } from "./voice-peer.ts";
import "./style.css";

const start = document.querySelector<HTMLButtonElement>("#start")!;
const leave = document.querySelector<HTMLButtonElement>("#leave")!;
const accept = document.querySelector<HTMLButtonElement>("#accept")!;
const reject = document.querySelector<HTMLButtonElement>("#reject")!;
const hangUp = document.querySelector<HTMLButtonElement>("#hang-up")!;
const summaryPlay = document.querySelector<HTMLButtonElement>("#summary-play")!;
const peerPlay = document.querySelector<HTMLButtonElement>("#play-peer")!;
const summaryAudio = document.querySelector<HTMLAudioElement>("#summary-audio")!;
const peerAudio = document.querySelector<HTMLAudioElement>("#peer-audio")!;
const panel = document.querySelector<HTMLElement>("#request")!;
const status = document.querySelector("#status")!;
const error = document.querySelector<HTMLElement>("#error")!;
const department = document.querySelector("#department")!;
const summary = document.querySelector("#summary")!;
const time = document.querySelector("#time")!;

type Incoming = {
  view: HandoffView;
  busy: boolean;
  loadingSummary: boolean;
  heardSummary: boolean;
  summaryUrl?: string;
  stream?: MediaStream;
  peer?: ReturnType<typeof createVoicePeer>;
};

type Session = { controller: AbortController; id?: string; incoming?: Incoming };
let session: Session | undefined;

function showError(cause: unknown) {
  error.textContent = cause instanceof Error ? cause.message : "담당자 요청을 처리하지 못했습니다.";
  error.hidden = false;
}

function send<T>(current: Session, action: string, body?: object) {
  return post<T>(`/api/agent/${current.id}/${action}`, current.controller.signal, body);
}

function stopSummary(incoming: Incoming) {
  summaryAudio.onended = null;
  summaryAudio.pause();
  summaryAudio.removeAttribute("src");
  summaryAudio.load();
  if (incoming.summaryUrl) URL.revokeObjectURL(incoming.summaryUrl);
  incoming.summaryUrl = undefined;
}

function dispose(incoming?: Incoming) {
  if (!incoming) return;
  stopSummary(incoming);
  incoming.peer?.close();
  stopMicrophone(incoming.stream);
}

function pending(current: Session, incoming: Incoming) {
  return current.incoming === incoming && incoming.view.phase === "pending" && !current.controller.signal.aborted;
}

async function prepareSummary(current: Session, incoming: Incoming) {
  if (incoming.loadingSummary || incoming.summaryUrl || incoming.view.summaryAudio !== "ready") return;
  incoming.loadingSummary = true;
  try {
    const { audio } = await send<{ audio: string }>(current, "summary", { id: incoming.view.id });
    if (!pending(current, incoming) || incoming.busy) return;
    incoming.summaryUrl = audioUrl(audio);
    const url = incoming.summaryUrl;
    summaryAudio.src = url;
    summaryAudio.onended = () => {
      if (pending(current, incoming) && incoming.summaryUrl === url) incoming.heardSummary = true;
    };
    summaryPlay.disabled = false;
    await summaryAudio.play().catch(() => {});
  } catch (cause) {
    if (pending(current, incoming)) showError(cause);
  } finally {
    incoming.loadingSummary = false;
  }
}

async function disconnect(current: Session, incoming: Incoming, cause?: unknown) {
  if (current.incoming !== incoming || incoming.busy) return;
  incoming.busy = true;
  dispose(incoming);
  try {
    await send(current, "fail", { id: incoming.view.id });
  } catch (failure) {
    if (!current.controller.signal.aborted) showError(failure);
  } finally {
    incoming.busy = false;
  }
  if (cause && !current.controller.signal.aborted) showError(cause);
}

async function render(current: Session, view: HandoffView | null) {
  if (current.controller.signal.aborted) return;
  if (!view || !["pending", "connecting", "connected"].includes(view.phase)) {
    const prior = current.incoming?.view.phase;
    dispose(current.incoming);
    current.incoming = undefined;
    panel.hidden = true;
    status.textContent = prior === "connected" ? "통화가 종료되었습니다. 새 요청을 기다립니다." : "새 인계 요청을 기다리고 있습니다.";
    return;
  }
  if (current.incoming?.view.id !== view.id) {
    dispose(current.incoming);
    error.hidden = true;
    current.incoming = { view, busy: false, loadingSummary: false, heardSummary: false };
  }
  const incoming = current.incoming;
  incoming.view = view;
  panel.hidden = false;
  department.textContent = view.department;
  summary.textContent = view.summary;
  const awaiting = view.phase === "pending";
  time.textContent = awaiting ? `${Math.max(0, Math.ceil((view.deadline - Date.now()) / 1000))}초` : "—";
  accept.hidden = reject.hidden = summaryPlay.hidden = !awaiting;
  reject.disabled = incoming.busy || Date.now() >= view.deadline;
  accept.disabled = reject.disabled || !incoming.heardSummary;
  summaryPlay.disabled = !incoming.summaryUrl;
  hangUp.hidden = awaiting;
  hangUp.disabled = incoming.busy;

  if (awaiting) {
    status.textContent = view.summaryAudio === "failed" ? "음성 요약을 재생할 수 없어 요청을 수락할 수 없습니다."
      : incoming.heardSummary ? "요약을 확인하고 수락하거나 거절해 주세요." : "음성 요약을 들은 뒤 요청을 수락할 수 있습니다.";
    void prepareSummary(current, incoming);
    return;
  }
  status.textContent = view.phase === "connected" ? "발신자와 통화 중입니다." : "발신자와 음성을 연결하는 중입니다.";
  if (view.phase !== "connecting" || !view.remoteDescription || incoming.peer || incoming.busy) return;
  if (!incoming.stream) throw new Error("담당자 마이크를 연결할 수 없습니다.");
  const body = { id: view.id };
  incoming.peer = createVoicePeer(incoming.stream, peerAudio, {
    connected: () => { void send(current, "connected", body).catch((cause) => disconnect(current, incoming, cause)); },
    failed: () => { void disconnect(current, incoming, new Error("음성 연결을 유지하지 못했습니다.")); },
    playbackBlocked: (blocked) => { peerPlay.hidden = !blocked; },
  });
  try {
    const sdp = await incoming.peer.answer(view.remoteDescription);
    await send(current, "answer", { ...body, sdp });
  } catch (cause) {
    await disconnect(current, incoming, cause);
  }
}

function leaveSession(current: Session, notify: boolean) {
  current.controller.abort();
  dispose(current.incoming);
  if (notify && current.id) navigator.sendBeacon(`/api/agent/${current.id}/leave`);
  if (session !== current) return;
  session = undefined;
  panel.hidden = true;
  leave.hidden = true;
  start.disabled = false;
  status.textContent = "담당자 대기가 종료되었습니다.";
}

start.addEventListener("click", async () => {
  const current: Session = { controller: new AbortController() };
  session = current;
  start.disabled = true;
  error.hidden = true;
  try {
    const { id } = await post<{ id: string }>("/api/agent/join");
    current.id = id;
    if (current.controller.signal.aborted) {
      navigator.sendBeacon(`/api/agent/${id}/leave`);
      return;
    }
    leave.hidden = false;
    poll(async () => {
      try {
        const { handoff } = await send<{ handoff: HandoffView | null }>(current, "poll");
        await render(current, handoff);
      } catch (cause) {
        if (current.controller.signal.aborted) return;
        leaveSession(current, true);
        showError(cause);
      }
    }, current.controller.signal);
  } catch (cause) {
    if (current.controller.signal.aborted) return;
    leaveSession(current, false);
    showError(cause);
  }
});

async function respond(action: "accept" | "reject") {
  const current = session;
  const incoming = current?.incoming;
  if (!current || !incoming || incoming.busy || !pending(current, incoming)) return;
  if (action === "accept" && !incoming.heardSummary) return;
  incoming.busy = true;
  accept.disabled = reject.disabled = true;
  error.hidden = true;
  try {
    if (action === "accept") {
      const stream = await microphone();
      if (!pending(current, incoming)) {
        stopMicrophone(stream);
        return;
      }
      incoming.stream = stream;
    }
    await send(current, action, { id: incoming.view.id });
    if (current.incoming === incoming) stopSummary(incoming);
  } catch (cause) {
    stopMicrophone(incoming.stream);
    incoming.stream = undefined;
    if (!current.controller.signal.aborted) showError(cause);
  } finally {
    incoming.busy = false;
  }
}

accept.addEventListener("click", () => { void respond("accept"); });
reject.addEventListener("click", () => { void respond("reject"); });
summaryPlay.addEventListener("click", () => { void summaryAudio.play().catch(showError); });
peerPlay.addEventListener("click", () => { void session?.incoming?.peer?.play(); });
hangUp.addEventListener("click", () => {
  if (session?.incoming) void disconnect(session, session.incoming);
});
leave.addEventListener("click", async () => {
  if (!session) return;
  const current = session;
  leaveSession(current, false);
  await post(`/api/agent/${current.id}/leave`).catch(showError);
});
window.addEventListener("pagehide", () => { if (session) leaveSession(session, true); });
