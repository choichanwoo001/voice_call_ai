import { handoffOutcomeText, recordRetentionDays, type CallRecord, type CallRecordSummary } from "./contracts.ts";
import "./style.css";

const list = document.querySelector<HTMLUListElement>("#records-list")!;
const status = document.querySelector("#records-status")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh-records")!;
const panel = document.querySelector<HTMLElement>("#record")!;
const error = document.querySelector<HTMLElement>("#error")!;
let selection: AbortController | undefined;
let selectedButton: HTMLButtonElement | undefined;
const time = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" });
document.querySelector("#record-retention")!.textContent = `기록은 통화 종료 후 ${recordRetentionDays}일 동안 보관됩니다.`;

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "통화 기록을 불러오지 못했습니다.");
  return data;
}

function showError(cause: unknown) {
  error.textContent = cause instanceof Error ? cause.message : "통화 기록을 불러오지 못했습니다.";
  error.hidden = false;
}

function showRecord(record: CallRecord) {
  const outcome = record.handoff && handoffOutcomeText[record.handoff.outcome];
  const attempts = record.handoffAttempts ?? (record.handoff ? [record.handoff] : []);
  const values = {
    "ended-at": time.format(new Date(record.endedAt)),
    department: record.decision?.department,
    summary: record.decision?.summary,
    transcript: record.transcript,
    "conversation-transcript": record.conversationTranscript?.join("\n"),
    "handoff-attempt": attempts.map((attempt, index) => `${index + 1}차 · ${handoffOutcomeText[attempt.outcome]}`).join("\n"),
    "handoff-outcome": outcome,
  };
  for (const [id, value] of Object.entries(values)) {
    document.getElementById(id)!.textContent = value || "—";
  }
  panel.hidden = false;
}

async function openRecord(id: string, button: HTMLButtonElement) {
  selection?.abort();
  const current = new AbortController();
  selection = current;
  selectedButton?.setAttribute("aria-pressed", "false");
  selectedButton = button;
  button.setAttribute("aria-pressed", "true");
  panel.hidden = true;
  error.hidden = true;
  try {
    const record = await get<CallRecord>(`/api/records/${id}`, current.signal);
    if (!current.signal.aborted) showRecord(record);
  } catch (cause) {
    if (!current.signal.aborted) showError(cause);
  }
}

async function loadRecords() {
  selection?.abort();
  selectedButton = undefined;
  refresh.disabled = true;
  list.replaceChildren();
  panel.hidden = true;
  error.hidden = true;
  status.textContent = "통화 기록을 불러오는 중입니다.";
  try {
    const records = await get<CallRecordSummary[]>("/api/records");
    status.textContent = records.length ? "통화를 선택하면 상세 기록을 볼 수 있습니다." : "저장된 통화 기록이 없습니다.";
    for (const record of records) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = [time.format(new Date(record.endedAt)), record.department, record.outcome && handoffOutcomeText[record.outcome]]
        .filter(Boolean).join(" · ");
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => { void openRecord(record.id, button); });
      row.append(button);
      list.append(row);
    }
  } catch (cause) {
    status.textContent = "";
    showError(cause);
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", () => { void loadRecords(); });
void loadRecords();
