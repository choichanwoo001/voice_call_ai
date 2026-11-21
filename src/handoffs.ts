import { randomUUID } from "node:crypto";
import type { Decision, HandoffOutcome, HandoffPhase, HandoffView } from "./contracts.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const presenceTimeout = 15_000;
type Side = "caller" | "agent";

export class Handoff {
  readonly id = randomUUID();
  readonly deadline: number;
  agentId?: string;
  phase: HandoffPhase = "pending";
  private readonly decision: Decision;
  private readonly summaryController = new AbortController();
  private audio?: Uint8Array;
  private audioFailed = false;
  private connectionDeadline = 0;
  private offer?: string;
  private answer?: string;
  private readonly liveAudio = new Set<Side>();

  constructor(decision: Decision, now: number) {
    this.decision = decision;
    this.deadline = now + 30_000;
  }

  get active() {
    return this.phase === "pending" || this.phase === "connecting" || this.phase === "connected";
  }

  get outcome(): HandoffOutcome {
    if (this.phase === "ended") return "connected";
    if (this.phase === "pending" || this.phase === "connecting") return "cancelled";
    return this.phase;
  }

  expire(now: number) {
    if (this.phase === "pending" && now >= this.deadline) this.close("expired");
    if (this.phase === "connecting" && now >= this.connectionDeadline) this.close("failed");
  }

  async prepareSummary(speak: (text: string, signal: AbortSignal) => Promise<Uint8Array>) {
    const { signal } = this.summaryController;
    try {
      const audio = await speak(`${this.decision.department}. ${this.decision.summary}`, signal);
      if (!signal.aborted) this.audio = audio;
    } catch {
      if (!signal.aborted) this.audioFailed = true;
    }
  }

  readSummary() {
    this.requirePhase("pending");
    if (!this.audio) throw new HttpError(409, "음성 요약을 아직 들을 수 없습니다.");
    return this.audio;
  }

  accept(agentId: string, now: number) {
    this.readSummary();
    this.agentId = agentId;
    this.connectionDeadline = now + 15_000;
    this.phase = "connecting";
    this.summaryController.abort();
    this.audio = undefined;
  }

  reject(agentId: string) {
    this.requirePhase("pending");
    this.agentId = agentId;
    this.close("rejected");
  }

  registerDescription(side: Side, sdp: string) {
    this.requirePhase("connecting");
    if (side === "caller" && !this.offer) this.offer = sdp;
    else if (side === "agent" && this.offer && !this.answer) this.answer = sdp;
    else throw new HttpError(409, "이미 처리된 연결 요청입니다.");
  }

  confirmAudio(side: Side) {
    if (this.phase === "connected") return;
    this.requirePhase("connecting");
    if (!this.answer) throw new HttpError(409, "음성 연결을 준비하는 중입니다.");
    this.liveAudio.add(side);
    if (this.liveAudio.size === 2) this.phase = "connected";
  }

  close(outcome: Exclude<HandoffOutcome, "connected">) {
    if (!this.active) return;
    this.phase = this.phase === "connected" ? "ended" : outcome;
    this.summaryController.abort();
    this.audio = undefined;
    this.offer = undefined;
    this.answer = undefined;
  }

  view(side: Side): HandoffView {
    return {
      id: this.id,
      phase: this.phase,
      department: this.decision.department,
      summary: this.decision.summary,
      deadline: this.deadline,
      summaryAudio: this.audio ? "ready" : this.audioFailed ? "failed" : "preparing",
      remoteDescription: side === "caller" ? this.answer : this.offer,
    };
  }

  private requirePhase(expected: HandoffPhase) {
    if (this.phase !== expected) throw new HttpError(409, "이미 처리되었거나 종료된 인계 요청입니다.");
  }
}
