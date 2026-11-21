export const departments = ["LIS", "검사장비 연동", "진료장비 연동", "솔루션", "LIT", "영업", "기타 문의"] as const;
export type Decision = { department: typeof departments[number]; summary: string; reply: string };
export type InquiryTurn = { text: string; reply: string };
export type InquiryResponse = {
  transcript: string; decision: Decision | null; reply: string; audio: string; handoff: HandoffView | null;
  recoveryFor?: string;
};
export type SpeechToken = { token: string; region: string };
export type HandoffOutcome = "connected" | "failed" | "rejected" | "expired" | "cancelled";
export type HandoffAttempt = { id: string; outcome: HandoffOutcome };
export type HandoffPhase = "pending" | "connecting" | "ended" | HandoffOutcome;
export type HandoffView = {
  id: string;
  phase: HandoffPhase;
  department: Decision["department"];
  summary: string;
  deadline: number;
  summaryAudio: "preparing" | "ready" | "failed";
  remoteDescription?: string;
};
export type CallRecord = {
  id: string;
  transcript: string | null;
  decision: Decision | null;
  endedAt: string;
  handoff?: HandoffAttempt;
  handoffAttempts?: HandoffAttempt[];
  conversationTranscript?: string[];
};

export type CallRecordSummary = {
  id: string;
  endedAt: string;
  department?: Decision["department"];
  outcome?: HandoffOutcome;
};

export const handoffOutcomeText: Record<HandoffOutcome, string> = {
  connected: "인계 완료", failed: "연결 실패", rejected: "담당자 거절",
  expired: "담당자 응답 없음", cancelled: "인계 취소",
};
export const recordRetentionDays = 7;

export function orderedTranscript(segments: ReadonlyMap<number, string>) {
  return Array.from(segments).sort(([left], [right]) => left - right).map(([, text]) => text);
}

export interface VoiceServices {
  speechToken(signal: AbortSignal): Promise<SpeechToken>;
  decide(transcript: string, signal: AbortSignal, history?: readonly InquiryTurn[]): Promise<unknown>;
  answerInterruption?(text: string, context: string, signal: AbortSignal): Promise<unknown>;
  speak(text: string, signal: AbortSignal): Promise<Uint8Array>;
}

export class VoiceServiceError extends Error {}

export function parseDecision(value: unknown): Decision {
  if (typeof value !== "object" || value === null) {
    throw new VoiceServiceError("Claude 판단 결과가 올바르지 않습니다.");
  }

  const { department, summary, reply } = value as Record<string, unknown>;
  if (
    !departments.includes(department as Decision["department"]) ||
    typeof summary !== "string" || !summary.trim() ||
    typeof reply !== "string" || !reply.trim()
  ) {
    throw new VoiceServiceError("문의 요약 또는 부서 분류가 확인되지 않았습니다.");
  }
  return { department: department as Decision["department"], summary: summary.trim(), reply: reply.trim() };
}

export function parseInquiryDecision(value: unknown): { decision: Decision | null; reply: string } {
  if (typeof value === "object" && value && "department" in value && value.department === null &&
    "reply" in value && typeof value.reply === "string" && value.reply.trim()) {
    return { decision: null, reply: value.reply.trim() };
  }
  const decision = parseDecision(value);
  return { decision, reply: decision.reply };
}
