function compact(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function isBackchannel(text: string) {
  return /^(아|어|네|예)?(네네|네|예|응|음|아|어|알겠습니다|그렇군요|아하|감사합니다|고맙습니다|기다릴게요)$/.test(compact(text));
}

export function isAnnouncementEcho(text: string, announcement: string) {
  const fragment = compact(text);
  return fragment.length >= 6 && compact(announcement).includes(fragment);
}

export function wantsPause(text: string) {
  const phrase = compact(text);
  return /^(?:아|네)?(?:잠깐만?요?|잠시만요?|그만(?:해|하세요|요|해주세요)|멈춰(?:요|주세요)?)$/.test(phrase) ||
    /(?:말|안내|설명)(?:을|를)?(?:멈춰|중단|그만)/.test(phrase);
}

export function introducesCorrection(text: string) {
  return /^(아니요|아니|정정이요|정정할게요|정정합니다|정정하고싶어요|정정할내용이있어요)$/.test(compact(text));
}

export function asksAboutHandoff(text: string) {
  const newFault = /뷰어|장비|LIS|EMR|LIT|RTIS|검체|심전도/i.test(text) &&
    /오류|장애|멈춰|멈췄|고장|열리지|안\s*되/.test(text);
  return !newFault && !/정정|바꿔|아니고|아니라|아니요|말고|잘못|^아니[,.\s]/.test(text) &&
    (isQuestion(text) || /언제|얼마나|어느\s*부서|어디로\s*연결|연결\s*중|연결\s*됐|기다리면/.test(text));
}

export function isQuestion(text: string) {
  return /[?？]|뭐(?:예요|죠)|나요|까요|인가요|얼마나/.test(text);
}

export function recoveryChoice(text: string): "retry" | "new" | "end" | undefined {
  if (isQuestion(text) && !/해\s*주세요[?？]?$/.test(text.trim())) return;
  const negative = /(?:다시\s*연결|재시도|종료|끝내|다른\s*문의).*?(?:하지\s*[마말]|하지\s*않|안\s*할|없어요)/;
  if (negative.test(text)) return;
  if (/다른\s*문의|새로운\s*문의|새\s*문의|별개\s*문의/.test(text)) return "new";
  if (/종료|끝낼|끝내|끊을|끊어/.test(text)) return "end";
  if (/다시|재시도|한\s*번\s*더|같은 부서/.test(text)) return "retry";
}
