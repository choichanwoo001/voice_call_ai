import { createVoiceServer } from "./src/voice-server.ts";
import { voiceServices } from "./src/voice-services.ts";

const port = Number(process.env.PORT || 4173);
createVoiceServer(voiceServices, ".call-records", "dist").listen(port, "127.0.0.1", () => {
  console.log(`ACK 음성 문의 · http://127.0.0.1:${port}`);
});
