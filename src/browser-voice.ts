export async function post<T>(path: string, signal?: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    signal,
    headers: body && { "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new BrowserHttpError(response.status, data.error || "음성 문의 요청에 실패했습니다.");
  return data;
}

export function audioUrl(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

export function microphone() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
    .catch(() => { throw new Error("브라우저의 마이크 연결과 권한을 확인해 주세요."); });
}

export function stopMicrophone(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function poll(operation: () => Promise<void>, signal: AbortSignal) {
  async function next() {
    if (signal.aborted) return;
    await operation();
    if (!signal.aborted) timer = setTimeout(next, 400);
  }
  let timer: ReturnType<typeof setTimeout>;
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  void next();
}
export class BrowserHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
