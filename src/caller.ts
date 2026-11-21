import * as speech from "microsoft-cognitiveservices-speech-sdk";
import { handoffOutcomeText, orderedTranscript, type CallRecord, type Decision, type HandoffView, type InquiryResponse, type SpeechToken } from "./contracts.ts";
import { audioUrl, BrowserHttpError, microphone, poll, post, stopMicrophone } from "./browser-voice.ts";
import { createVoicePeer } from "./voice-peer.ts";
import { createTranscriptionMix } from "./transcription-mix.ts";
import { asksAboutHandoff, introducesCorrection, isAnnouncementEcho, isBackchannel, isQuestion, recoveryChoice, wantsPause } from "./utterance.ts";
import "./style.css";

const start = document.querySelector<HTMLButtonElement>("#start")!;
const end = document.querySelector<HTMLButtonElement>("#end")!;
const play = document.querySelector<HTMLButtonElement>("#play")!;
const playPeer = document.querySelector<HTMLButtonElement>("#play-peer")!;
const peerAudio = document.querySelector<HTMLAudioElement>("#peer-audio")!;
const status = document.querySelector("#status")!;
const aiReply = document.querySelector<HTMLElement>("#ai-reply")!;
const error = document.querySelector<HTMLElement>("#error")!;
const result = document.querySelector<HTMLElement>("#result")!;
const transcriptOutput = document.querySelector("#transcript")!;
const conversationOutput = document.querySelector("#conversation-transcript")!;
const department = document.querySelector("#department")!;
const summary = document.querySelector("#summary")!;
const endedAt = document.querySelector("#ended-at")!;
const handoffOutcome = document.querySelector("#handoff-outcome")!;

type Call = {
  id?: string;
  stream?: MediaStream;
  recognizer?: speech.SpeechRecognizer;
  mixer?: ReturnType<typeof createTranscriptionMix>;
  recognitionClosed?: Promise<void>;
  refresh?: ReturnType<typeof setInterval>;
  presence?: ReturnType<typeof setInterval>;
  playback?: HTMLAudioElement;
  audioUrl?: string;
  controller: AbortController;
  recognitionPhase?: "inquiry" | "waiting" | "pending" | "recovery" | "announcement" | "conversation";
  announcement?: { text: string; until: number };
  correctionLead?: { text: string; id: string; timer?: ReturnType<typeof setTimeout> };
  dialogueVersion: number;
  recoveryFor?: string;
  pendingHandoff?: string;
  correctingFor?: string;
  handoffPolling?: AbortController;
  handoffId?: string;
  handoffConnected: boolean;
  finishing: boolean;
  pendingSegments: string[];
  transcriptSequence: number;
  conversation: Map<number, string>;
  transcriptRequests: Set<Promise<void>>;
  peer?: ReturnType<typeof createVoicePeer>;
};

let current: Call | undefined;

function showResult(transcript: string | null, decision: Decision | null, endTime?: string) {
  result.hidden = !transcript && !endTime;
  transcriptOutput.textContent = transcript ?? "—";
  department.textContent = decision?.department ?? "—";
  summary.textContent = decision?.summary ?? "—";
  endedAt.textContent = endTime ? new Date(endTime).toLocaleString("ko-KR") : "—";
}

function showError(message: string) {
  error.textContent = message;
  error.hidden = false;
}

function stopListening(call: Call) {
  call.recognitionPhase = undefined;
  clearInterval(call.refresh);
  const recognizer = call.recognizer;
  call.recognizer = undefined;
  if (recognizer) {
    call.recognitionClosed = new Promise<void>((resolve, reject) => recognizer.close(resolve, reject))
      .catch(() => {});
  }
  call.mixer?.close();
  call.mixer = undefined;
}

function stopMedia(call: Call) {
  clearCorrectionLead(call);
  stopListening(call);
  stopPlayback(call);
  call.peer?.close();
  call.peer = undefined;
  stopMicrophone(call.stream);
}

function clearCorrectionLead(call: Call) {
  clearTimeout(call.correctionLead?.timer);
  call.correctionLead = undefined;
}

function waitForCorrectionDetails(call: Call, lead: NonNullable<Call["correctionLead"]>) {
  clearTimeout(lead.timer);
  lead.timer = setTimeout(() => {
    if (call.correctionLead !== lead || call.pendingHandoff !== lead.id) return;
    clearCorrectionLead(call);
    void submitInquiry(call, lead.text, lead.id);
  }, 4200);
}

function stopPlayback(call: Call) {
  play.hidden = true;
  if (call.playback) {
    if (call.announcement) call.announcement.until = Date.now() + 1500;
    call.playback.pause();
    call.playback.removeAttribute("src");
    call.playback.load();
    call.playback = undefined;
  }
  if (call.audioUrl) URL.revokeObjectURL(call.audioUrl);
  call.audioUrl = undefined;
}

async function playReply(call: Call, playback: HTMLAudioElement) {
  play.hidden = true;
  status.textContent = "AI가 안내하고 있습니다.";
  try {
    await playback.play();
  } catch (cause) {
    if (call.controller.signal.aborted || call.playback !== playback) return;
    if (cause instanceof DOMException && cause.name === "NotAllowedError") {
      play.hidden = false;
      status.textContent = "재생 버튼을 눌러 AI의 안내를 들을 수 있습니다.";
      return;
    }
    stopPlayback(call);
    showError("음성 응답을 재생하지 못했습니다.");
    status.textContent = "화면에서 문의 결과를 확인하고 통화를 종료해 주세요.";
  }
}

async function finish(call: Call) {
  if (current !== call || call.finishing) return;
  call.finishing = true;
  end.disabled = true;
  status.textContent = "통화를 종료하는 중입니다.";
  try {
    if (call.handoffConnected && call.recognizer && call.recognitionPhase === "conversation") {
      const recognizer = call.recognizer;
      call.mixer?.pause();
      call.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
      peerAudio.pause();
      const timeout = AbortSignal.timeout(1500);
      await new Promise<void>((resolve) => {
        timeout.addEventListener("abort", () => resolve(), { once: true });
        recognizer.stopContinuousRecognitionAsync(resolve, () => resolve());
      }).catch(() => {});
    }
    clearInterval(call.presence);
    call.controller.abort();
    stopMedia(call);
    const closeTimeout = AbortSignal.timeout(2000);
    const closeDeadline = new Promise<void>((resolve) => {
      closeTimeout.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.all([Promise.race([call.recognitionClosed, closeDeadline]), ...call.transcriptRequests]);
    if (call.id) {
      const record = await post<CallRecord>(`/api/calls/${call.id}/end`);
      showResult(record.transcript, record.decision, record.endedAt);
      conversationOutput.textContent = record.conversationTranscript?.join("\n") || "—";
      if (record.handoff) {
        handoffOutcome.textContent = handoffOutcomeText[record.handoff.outcome];
      }
    }
    current = undefined;
    status.textContent = "통화가 종료되었습니다.";
    start.disabled = false;
  } catch (cause) {
    call.finishing = false;
    showError(cause instanceof Error ? cause.message : "통화 기록을 저장하지 못했습니다.");
    end.disabled = false;
  }
}

function saveConversationSegment(call: Call, text: string) {
  if (call.controller.signal.aborted) return;
  if (!call.handoffConnected) {
    call.pendingSegments.push(text);
    return;
  }
  const sequence = ++call.transcriptSequence;
  const request = post(`/api/calls/${call.id}/conversation`, AbortSignal.timeout(3000), {
    id: call.handoffId, sequence, text,
  }).then(() => {
    if (call.controller.signal.aborted) return;
    call.conversation.set(sequence, text);
    conversationOutput.textContent = orderedTranscript(call.conversation).join("\n");
  }).catch(() => {
    if (!call.controller.signal.aborted) showError("대화 전사 일부를 저장하지 못했습니다.");
  }).finally(() => { call.transcriptRequests.delete(request); });
  call.transcriptRequests.add(request);
}

function startConversationTranscription(call: Call, id: string) {
  if (call.recognitionPhase !== "waiting" || !call.mixer) return;
  const remote = peerAudio.srcObject;
  if (!(remote instanceof MediaStream)) {
    showError("담당자 음성을 전사할 수 없습니다. 통화는 계속할 수 있습니다.");
    stopListening(call);
    return;
  }
  try {
    call.mixer.startConversation(remote);
    call.handoffId = id;
    call.recognitionPhase = "conversation";
    conversationOutput.textContent = "대화를 전사하는 중입니다.";
  } catch {
    stopListening(call);
    showError("대화 전사를 시작하지 못했습니다. 통화는 계속할 수 있습니다.");
  }
}

function monitorHandoff(call: Call, initial: HandoffView) {
  const signal = call.controller.signal;
  call.handoffPolling?.abort();
  const polling = new AbortController();
  call.handoffPolling = polling;
  call.pendingHandoff = initial.id;
  const pollSignal = AbortSignal.any([signal, polling.signal]);
  const path = `/api/calls/${call.id}/handoff`;
  const body = { id: initial.id };
  let phase = initial.phase;
  let answered = false;
  let failing = false;

  function markConnected(handoff: HandoffView) {
    if (pollSignal.aborted || call.finishing) return;
    startConversationTranscription(call, handoff.id);
    call.handoffConnected = true;
    for (const text of call.pendingSegments.splice(0)) saveConversationSegment(call, text);
    handoffOutcome.textContent = "인계 완료";
    status.textContent = "담당자와 통화 중입니다.";
  }

  function cleanup() {
    polling.abort();
    clearCorrectionLead(call);
    stopPlayback(call);
    call.peer?.close();
    call.peer = undefined;
    call.pendingSegments.length = 0;
    call.mixer?.pause();
  }

  async function fail() {
    if (failing || pollSignal.aborted) return;
    failing = true;
    cleanup();
    const result = await post<{ handoff: HandoffView }>(`${path}/fail`, signal, body).catch(() => null);
    if (signal.aborted) return;
    if (result?.handoff.phase === "failed" && !call.handoffConnected) {
      void recoverHandoff(call, initial.id);
      return;
    }
    stopMedia(call);
    handoffOutcome.textContent = call.handoffConnected ? "인계 완료" : "연결 실패";
    status.textContent = "담당자 음성 연결이 종료되었습니다.";
    showError("음성 연결을 유지하지 못했습니다. 통화를 종료해 주세요.");
  }

  function connect() {
    status.textContent = "담당자와 음성을 연결하는 중입니다.";
    stopPlayback(call);
    const peer = createVoicePeer(call.stream!, peerAudio, {
      connected: () => {
        if (pollSignal.aborted || call.finishing) return;
        startConversationTranscription(call, body.id);
        void post<{ handoff: HandoffView }>(`${path}/connected`, pollSignal, body)
          .then(({ handoff }) => { if (handoff.phase === "connected") markConnected(handoff); }).catch(fail);
      },
      failed: () => { void fail(); },
      playbackBlocked: (blocked) => { playPeer.hidden = !blocked; },
    });
    call.peer = peer;
    return peer;
  }

  poll(async () => {
    try {
      const { handoff } = await post<{ handoff: HandoffView }>(`${path}/poll`, pollSignal);
      if (pollSignal.aborted || call.finishing) return;
      phase = handoff.phase;
      if (phase === "pending") return;
      if (phase === "connecting") {
        call.pendingHandoff = undefined;
        clearCorrectionLead(call);
        if (call.recognitionPhase !== "conversation") {
          call.recognitionPhase = "waiting";
          call.mixer?.pause();
        }
        if (call.playback) return;
        if (!call.peer) {
          const sdp = await connect().offer();
          await post(`${path}/offer`, pollSignal, { ...body, sdp });
        } else if (handoff.remoteDescription && !answered) {
          answered = true;
          await call.peer.receiveAnswer(handoff.remoteDescription);
        }
        return;
      }
      if (phase === "connected") {
        markConnected(handoff);
        return;
      }
      if (phase === "cancelled" && call.correctingFor === handoff.id) {
        polling.abort();
        return;
      }
      cleanup();
      call.pendingHandoff = undefined;
      if (phase === "rejected" || phase === "expired" || phase === "failed") {
        handoffOutcome.textContent = handoffOutcomeText[phase];
        void recoverHandoff(call, handoff.id);
        return;
      }
      stopMedia(call);
      const message = {
        cancelled: "인계 요청이 취소되었습니다.",
        ended: "담당자와의 통화가 종료되었습니다.",
      }[phase];
      handoffOutcome.textContent = phase === "ended" ? "인계 완료" : message;
      status.textContent = message + " 통화를 종료해 주세요.";
    } catch {
      await fail();
    }
  }, pollSignal);
}

function listenForInquiry(call: Call) {
  call.recognitionPhase = call.recoveryFor ? "recovery" : "inquiry";
  call.mixer?.listen();
  status.textContent = call.recoveryFor ? "선택을 말씀해 주세요." : "듣고 있습니다. 문의를 말씀해 주세요.";
}

function listenForCorrection(call: Call, id: string) {
  if (call.pendingHandoff !== id || call.correctingFor) return;
  call.recognitionPhase = "pending";
  call.mixer?.listen();
  status.textContent = "담당자의 응답을 기다리고 있습니다. 문의를 정정할 수 있습니다.";
}

function playInquiryResponse(call: Call, response: InquiryResponse, keepMonitoring = false) {
  const { transcript, decision, reply, audio, handoff } = response;
  call.recoveryFor = response.recoveryFor;
  showResult(transcript, decision);
  aiReply.textContent = reply;
  aiReply.hidden = !reply;
  if (handoff || !call.recoveryFor) handoffOutcome.textContent = handoff ? "담당자 수락 대기" : "—";
  if (handoff && !keepMonitoring) monitorHandoff(call, handoff);
  const listen = () => {
    if (handoff) listenForCorrection(call, handoff.id);
    else listenForInquiry(call);
  };
  if (!audio) {
    listen();
    return;
  }
  call.announcement = { text: reply, until: Infinity };
  call.recognitionPhase = "announcement";
  call.mixer?.listen();
  call.audioUrl = audioUrl(audio);
  const playback = new Audio(call.audioUrl);
  call.playback = playback;
  playback.addEventListener("ended", () => {
    if (call.controller.signal.aborted || call.playback !== playback) return;
    stopPlayback(call);
    listen();
  }, { once: true });
  playback.addEventListener("error", () => {
    if (!call.controller.signal.aborted && call.playback === playback) {
      showError("음성 응답을 재생하지 못했습니다.");
      stopPlayback(call);
      listen();
    }
  }, { once: true });
  void playReply(call, playback);
}

async function recoverHandoff(call: Call, id: string, transcript?: string) {
  const version = ++call.dialogueVersion;
  call.recognitionPhase = "waiting";
  call.mixer?.pause();
  status.textContent = "AI 안내를 준비하고 있습니다.";
  try {
    const result = await post<InquiryResponse | { end: true }>(
      `/api/calls/${call.id}/recovery`, call.controller.signal, { id, transcript },
    );
    if (call.controller.signal.aborted || call.finishing || version !== call.dialogueVersion) return;
    if ("end" in result) await finish(call);
    else playInquiryResponse(call, result);
  } catch (cause) {
    if (call.controller.signal.aborted || call.finishing || version !== call.dialogueVersion) return;
    showError(cause instanceof Error ? cause.message : "AI 안내로 돌아가지 못했습니다.");
    status.textContent = "통화를 종료해 주세요.";
  }
}

async function submitInquiry(call: Call, transcript: string, correction?: string) {
  const version = ++call.dialogueVersion;
  call.recognitionPhase = "waiting";
  call.mixer?.pause();
  if (correction) {
    call.correctingFor = correction;
    stopPlayback(call);
  }
  status.textContent = "문의 내용을 확인하는 중입니다.";
  try {
    const response = await post<InquiryResponse>(
      `/api/calls/${call.id}/inquiry`, call.controller.signal, { transcript, correction },
    );
    if (!call.controller.signal.aborted && !call.finishing && version === call.dialogueVersion) {
      if (correction) {
        call.handoffPolling?.abort();
        call.pendingHandoff = undefined;
      }
      playInquiryResponse(call, response);
    }
  } catch (cause) {
    if (call.controller.signal.aborted || version !== call.dialogueVersion) return;
    if (correction && cause instanceof BrowserHttpError && cause.status === 409) return;
    stopMedia(call);
    showError(cause instanceof Error ? cause.message : "문의를 처리하지 못했습니다.");
    status.textContent = "통화를 종료해 주세요.";
  } finally {
    if (correction) call.correctingFor = undefined;
  }
}

async function interruptAnnouncement(call: Call, transcript: string) {
  const version = ++call.dialogueVersion;
  const correction = call.pendingHandoff;
  call.recognitionPhase = "waiting";
  call.mixer?.pause();
  status.textContent = "끼어든 말씀을 확인하는 중입니다.";
  try {
    const result = await post<InquiryResponse>(
      `/api/calls/${call.id}/interruption`, call.controller.signal, { transcript, handoffId: correction },
    );
    if (call.controller.signal.aborted || call.finishing || version !== call.dialogueVersion) return;
    if (correction && call.pendingHandoff !== correction) return;
    playInquiryResponse(call, { ...result, recoveryFor: call.recoveryFor }, true);
  } catch (cause) {
    if (call.controller.signal.aborted || call.finishing || version !== call.dialogueVersion ||
      (correction && call.pendingHandoff !== correction)) return;
    showError(cause instanceof Error ? cause.message : "끼어든 발화를 처리하지 못했습니다.");
    if (correction) listenForCorrection(call, correction);
    else listenForInquiry(call);
  }
}

function recognizeUtterance(call: Call, transcript: string) {
  if (call.recognitionPhase === "conversation") {
    saveConversationSegment(call, transcript);
    return;
  }
  if (!call.recognitionPhase || call.finishing || call.controller.signal.aborted || call.recognitionPhase === "waiting") return;
  if (call.announcement && Date.now() <= call.announcement.until && isAnnouncementEcho(transcript, call.announcement.text)) return;
  if (call.pendingHandoff && introducesCorrection(transcript)) {
    if (call.recognitionPhase === "announcement") stopPlayback(call);
    clearCorrectionLead(call);
    call.recognitionPhase = "pending";
    const lead = { text: transcript, id: call.pendingHandoff };
    call.correctionLead = lead;
    call.correctingFor = lead.id;
    status.textContent = "정정할 내용을 말씀해 주세요.";
    waitForCorrectionDetails(call, lead);
    void post(`/api/calls/${call.id}/correction-start`, call.controller.signal, { id: lead.id }).catch((cause: unknown) => {
      if (call.correctionLead !== lead || call.controller.signal.aborted || call.finishing) return;
      if (cause instanceof BrowserHttpError && cause.status === 409) {
        clearCorrectionLead(call);
        call.correctingFor = undefined;
      } else {
        showError("기존 인계 요청을 바로 취소하지 못했습니다.");
      }
    });
    return;
  }
  if ((call.recognitionPhase === "announcement" || call.recognitionPhase === "pending") && isBackchannel(transcript)) {
    const answeringQuestion = call.recognitionPhase === "announcement" && !call.pendingHandoff && !call.recoveryFor &&
      call.announcement?.text.trimEnd().endsWith("?") && call.playback &&
      call.playback.duration - call.playback.currentTime < 0.5;
    if (!answeringQuestion) return;
  }
  if (call.recognitionPhase === "announcement") stopPlayback(call);
  const correctionLead = call.correctionLead;
  if (correctionLead && correctionLead.id === call.pendingHandoff) {
    clearCorrectionLead(call);
    void submitInquiry(call, `${correctionLead.text} ${transcript}`, correctionLead.id);
    return;
  }
  if (wantsPause(transcript) || (call.pendingHandoff && asksAboutHandoff(transcript)) ||
    (call.recoveryFor && isQuestion(transcript) && !recoveryChoice(transcript))) {
    void interruptAnnouncement(call, transcript);
  } else if (call.pendingHandoff) {
    void submitInquiry(call, transcript, call.pendingHandoff);
  } else if (call.recoveryFor) {
    void recoverHandoff(call, call.recoveryFor, transcript);
  } else if (call.recognitionPhase === "inquiry" || call.recognitionPhase === "announcement") {
    void submitInquiry(call, transcript);
  }
}

start.addEventListener("click", async () => {
  const call: Call = {
    controller: new AbortController(), handoffConnected: false, finishing: false,
    pendingSegments: [], transcriptSequence: 0, dialogueVersion: 0, conversation: new Map(), transcriptRequests: new Set(),
  };
  current = call;
  start.disabled = true;
  end.disabled = false;
  error.hidden = true;
  aiReply.hidden = true;
  aiReply.textContent = "";
  handoffOutcome.textContent = "—";
  conversationOutput.textContent = "—";
  showResult(null, null);
  status.textContent = "마이크와 음성 서비스를 준비하는 중입니다.";

  try {
    const stream = await microphone();
    if (call.controller.signal.aborted) {
      stopMicrophone(stream);
      return;
    }
    call.stream = stream;
    const { id, speech: authorization } = await post<{ id: string; speech: SpeechToken }>("/api/calls");
    if (call.controller.signal.aborted) {
      await post(`/api/calls/${id}/end`).catch(() => {});
      return;
    }
    call.id = id;
    call.presence = setInterval(() => {
      void post(`/api/calls/${id}/presence`, call.controller.signal).catch(() => {});
    }, 5000);

    const config = speech.SpeechConfig.fromAuthorizationToken(authorization.token, authorization.region);
    config.speechRecognitionLanguage = "ko-KR";
    config.setProperty(speech.PropertyId.Recognizer_StopTimeoutMs, "1200");
    const mixer = createTranscriptionMix(stream);
    call.mixer = mixer;
    await mixer.ready;
    if (call.controller.signal.aborted) return;
    const recognizer = new speech.SpeechRecognizer(config, speech.AudioConfig.fromStreamInput(mixer.stream));
    call.recognizer = recognizer;
    call.recognitionPhase = "inquiry";
    const recognitionError = (message: string) => {
      if (call.recognizer !== recognizer || call.finishing) return;
      const duringConversation = call.recognitionPhase === "conversation" && call.handoffConnected;
      stopListening(call);
      if (duringConversation) {
        showError("대화 전사를 계속할 수 없습니다. 음성 통화는 유지됩니다.");
        return;
      }
      call.handoffPolling?.abort();
      stopPlayback(call);
      stopMicrophone(call.stream);
      showError(message);
      status.textContent = "통화를 종료해 주세요.";
    };
    recognizer.recognized = (_, event) => {
      const transcript = event.result.text.trim();
      if (event.result.reason !== speech.ResultReason.RecognizedSpeech || !transcript) return;
      recognizeUtterance(call, transcript);
    };
    recognizer.recognizing = (_, event) => {
      if (call.correctionLead && event.result.text.trim()) waitForCorrectionDetails(call, call.correctionLead);
    };
    recognizer.canceled = () => recognitionError("Azure 음성 인식이 중단되었습니다. 키와 Azure 리소스를 확인해 주세요.");
    recognizer.sessionStopped = () => recognitionError("Azure 음성 인식 세션이 종료되었습니다.");
    await new Promise<void>((resolve, reject) => recognizer.startContinuousRecognitionAsync(resolve, reject));
    if (call.recognizer !== recognizer) return;
    if (call.recognitionPhase === "inquiry") {
      listenForInquiry(call);
    }
    call.refresh = setInterval(async () => {
      try {
        const renewed = await post<SpeechToken>(`/api/calls/${id}/speech-token`, call.controller.signal);
        if (call.recognizer === recognizer) recognizer.authorizationToken = renewed.token;
      } catch {
        recognitionError("Azure 음성 인증을 갱신하지 못했습니다.");
      }
    }, 9 * 60_000);
  } catch (cause) {
    if (call.controller.signal.aborted) return;
    stopMedia(call);
    showError(cause instanceof Error ? cause.message : "음성 인식을 시작하지 못했습니다.");
    if (call.id) {
      status.textContent = "통화를 종료해 주세요.";
    } else {
      current = undefined;
      status.textContent = "설정을 확인한 뒤 다시 시작해 주세요.";
      start.disabled = false;
      end.disabled = true;
    }
  }
});

end.addEventListener("click", () => { if (current) void finish(current); });
playPeer.addEventListener("click", () => { void current?.peer?.play(); });
play.addEventListener("click", () => {
  if (current?.playback) void playReply(current, current.playback);
});
window.addEventListener("pagehide", () => {
  if (!current) return;
  clearInterval(current.presence);
  current.controller.abort();
  stopMedia(current);
  if (current.id) navigator.sendBeacon(`/api/calls/${current.id}/end`);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && current) void finish(current);
});
