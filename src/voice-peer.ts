type MediaCallbacks = {
  connected(): void;
  failed(): void;
  playbackBlocked(blocked: boolean): void;
};

async function localDescription(peer: RTCPeerConnection, description: RTCSessionDescriptionInit, signal: AbortSignal) {
  await peer.setLocalDescription(description);
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  if (peer.iceGatheringState !== "complete") {
    await new Promise<void>((resolve, reject) => {
      waiting.throwIfAborted();
      const cleanup = () => {
        peer.removeEventListener("icegatheringstatechange", changed);
        waiting.removeEventListener("abort", aborted);
      };
      const changed = () => {
        if (peer.iceGatheringState !== "complete") return;
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(waiting.reason);
      };
      peer.addEventListener("icegatheringstatechange", changed);
      waiting.addEventListener("abort", aborted, { once: true });
    });
  }
  signal.throwIfAborted();
  return peer.localDescription!.sdp;
}

export function createVoicePeer(stream: MediaStream, audio: HTMLAudioElement, callbacks: MediaCallbacks) {
  const peer = new RTCPeerConnection();
  const lifecycle = new AbortController();
  let remote: MediaStreamTrack | undefined;
  let playbackStarted = false;
  let reported = false;
  stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

  function reportConnected() {
    if (reported || lifecycle.signal.aborted) return;
    if (peer.connectionState === "connected" && remote && !remote.muted && playbackStarted) {
      reported = true;
      callbacks.connected();
    }
  }

  async function play() {
    try {
      await audio.play();
      if (lifecycle.signal.aborted) return;
      playbackStarted = true;
      callbacks.playbackBlocked(false);
      reportConnected();
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      if (error instanceof DOMException && error.name === "NotAllowedError") callbacks.playbackBlocked(true);
      else callbacks.failed();
    }
  }

  peer.ontrack = ({ track }) => {
    remote = track;
    track.addEventListener("unmute", reportConnected, { signal: lifecycle.signal });
    audio.srcObject = new MediaStream([track]);
    void play();
  };
  peer.onconnectionstatechange = () => {
    if (lifecycle.signal.aborted) return;
    if (peer.connectionState === "connected") reportConnected();
    if (peer.connectionState === "failed" || peer.connectionState === "disconnected") callbacks.failed();
  };

  return {
    async offer() {
      return localDescription(peer, await peer.createOffer(), lifecycle.signal);
    },
    async answer(sdp: string) {
      await peer.setRemoteDescription({ type: "offer", sdp });
      return localDescription(peer, await peer.createAnswer(), lifecycle.signal);
    },
    receiveAnswer(sdp: string) {
      return peer.setRemoteDescription({ type: "answer", sdp });
    },
    play,
    close() {
      lifecycle.abort();
      peer.close();
      audio.pause();
      audio.srcObject = null;
      callbacks.playbackBlocked(false);
    },
  };
}
