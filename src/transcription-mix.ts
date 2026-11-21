export function createTranscriptionMix(microphone: MediaStream) {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const local = context.createMediaStreamSource(microphone);
  const localVolume = context.createGain();
  const remoteVolume = context.createGain();
  let remoteSource: MediaStreamAudioSourceNode | undefined;
  local.connect(localVolume);
  localVolume.connect(destination);
  remoteVolume.connect(destination);

  return {
    stream: destination.stream,
    ready: context.resume(),
    listen() {
      remoteSource?.disconnect();
      remoteSource = undefined;
      localVolume.gain.value = 1;
      remoteVolume.gain.value = 0;
    },
    pause() {
      localVolume.gain.value = 0;
      remoteVolume.gain.value = 0;
    },
    startConversation(remoteAudio: MediaStream) {
      localVolume.gain.value = 0.5;
      remoteVolume.gain.value = 0.5;
      remoteSource?.disconnect();
      remoteSource = context.createMediaStreamSource(remoteAudio);
      remoteSource.connect(remoteVolume);
    },
    close() {
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => {});
    },
  };
}
