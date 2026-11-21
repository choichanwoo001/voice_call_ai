# ACK 브라우저 음성 문의

발신자의 문의를 Azure Speech로 전사하고 Claude로 분류·요약한 뒤, 담당자의 수락으로 두 브라우저를 WebRTC 음성 통화로 연결하는 로컬 프로토타입이다.

## 실행

Node.js 24 이상이 필요하다. .env.example을 .env로 복사한 뒤 Azure Speech 리소스 키·지역과 Claude API 키를 입력한다.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

- [발신자 화면](http://127.0.0.1:4173/)
- [담당자 화면](http://127.0.0.1:4173/agent)
- [통화 기록](http://127.0.0.1:4173/records)

담당자 화면에서 대기를 시작하고 발신자 화면에서 가상의 ACK 문의를 말한다. 담당자는 분류·문의 요약을 확인하고 승인할 수 있다. 통화 기록은 종료 후 7일 동안 보관한다. 서버를 시작할 때와 실행 중 1분마다 만료 파일을 삭제한다.

## 검증

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

연결 이후 전사는 Azure 인식기 하나에서 두 음성을 합쳐 처리한다. 겹쳐 말하면 일부 발화가 누락될 수 있다. 시연 검증에는 Chromium 가상 마이크를 사용했다.

[기능 명세](https://github.com/choichanwoo001/voice_call_ai/issues/1)
