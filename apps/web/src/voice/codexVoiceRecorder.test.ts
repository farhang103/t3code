import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createCodexVoiceRecorder, readVoiceTranscriptEvent } from "./codexVoiceRecorder";

describe("Codex realtime transcription", () => {
  it("accepts user input chunks and ignores assistant speech and commands", () => {
    expect(
      readVoiceTranscriptEvent(
        JSON.stringify({ type: "input_transcript.added", item: { id: "one", text: " Hello" } }),
      ),
    ).toEqual({ id: "one", text: " Hello" });
    expect(
      readVoiceTranscriptEvent(
        JSON.stringify({
          type: "output_transcript.added",
          item: { id: "two", text: "Run this command" },
        }),
      ),
    ).toBeNull();
    expect(
      readVoiceTranscriptEvent(
        JSON.stringify({ type: "delegation", item: { id: "three", text: "Run this command" } }),
      ),
    ).toBeNull();
  });
  it("ignores malformed and unrelated channel messages", () => {
    for (const event of [
      "not json",
      "null",
      "{}",
      '{"type":"input_transcript.added","item":{"text":1}}',
    ])
      expect(readVoiceTranscriptEvent(event)).toBeNull();
  });
});

const network = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../state/session", () => ({ readPreparedConnection: () => ({}) }));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  startVoice: () => ({ kind: "start" }),
  stopVoice: () => ({ kind: "stop" }),
}));
vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromise: (request: { kind: string; text: string }) => {
      if (request.kind === "start") network.start();
      if (request.kind === "stop") network.stop();
      return Promise.resolve({ sessionId: "session", sdp: "answer" });
    },
  },
}));

class VoicePeer {
  static current: VoicePeer;
  channel = {
    readyState: "open",
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
  };
  localDescription = { sdp: "offer" };
  constructor() {
    VoicePeer.current = this;
  }
  createDataChannel() {
    return this.channel;
  }
  addTransceiver() {
    return { sender: { replaceTrack: async () => {} } };
  }
  createOffer() {
    return Promise.resolve({ sdp: "offer" });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  close() {}
  chunk(id: string, text: string) {
    this.channel.onmessage?.({
      data: JSON.stringify({ type: "input_transcript.added", item: { id, text } }),
    });
  }
}
function deferredMicrophone() {
  let resolve = (_stream: MediaStream) => {};
  const promise = new Promise<MediaStream>((done) => {
    resolve = done;
  });
  return { promise, resolve: (stream: MediaStream) => resolve(stream) };
}

function createRecorderHarness(microphone?: Promise<MediaStream>) {
  const track = { enabled: true, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const callbacks = { onTranscript: vi.fn(), onError: vi.fn() };
  const recorder = createCodexVoiceRecorder(
    EnvironmentId.make("env"),
    ProviderInstanceId.make("codex"),
    microphone ?? Promise.resolve(stream),
    callbacks,
  );
  return { track, callbacks, recorder };
}
describe("live recorder completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", VoicePeer);
    vi.stubGlobal("navigator", { language: "en-US" });
    network.start.mockReset();
    network.stop.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("batches live chunks and finishes without a second AI request", async () => {
    const { recorder, callbacks, track } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.chunk("1", "can you");
    VoicePeer.current.chunk("1", "can you");
    VoicePeer.current.chunk("2", " check it question mark");
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "can you check it question mark",
    );
    const stopped = recorder.stop();
    expect(track.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(stopped).resolves.toEqual({
      text: "can you check it question mark",
      locale: "en-US",
    });
    recorder.dispose();
    expect(network.stop).toHaveBeenCalledTimes(1);
  });

  it("extends the quiet window when the last words arrive after stop", async () => {
    const { recorder } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.chunk("1", "can you check");
    const stopped = recorder.stop();
    const completed = vi.fn();
    void stopped.then(completed);
    await vi.advanceTimersByTimeAsync(1400);
    VoicePeer.current.chunk("2", " the microphone");
    await vi.advanceTimersByTimeAsync(999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toMatchObject({ text: "can you check the microphone" });
    recorder.dispose();
  });

  it("cancels pending completion without inserting late speech", async () => {
    const { recorder, callbacks } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.chunk("1", "keep these words");
    const stopped = recorder.stop();
    const rejected = expect(stopped).rejects.toThrow("cancelled");
    recorder.dispose();
    VoicePeer.current.chunk("2", "discard these");
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
  });

  it("negotiates while the microphone is opening and keeps it muted until ready", async () => {
    const microphone = deferredMicrophone();
    const { recorder } = createRecorderHarness(microphone.promise);
    const started = recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(network.start).toHaveBeenCalledTimes(1);
    const track = { enabled: true, stop: vi.fn() };
    microphone.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await started;
    expect(track.enabled).toBe(true);
    recorder.dispose();
    expect(track.stop).toHaveBeenCalled();
  });

  it("releases a microphone that opens after cancellation", async () => {
    const microphone = deferredMicrophone();
    const { recorder } = createRecorderHarness(microphone.promise);
    const started = recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    recorder.dispose();
    const track = { enabled: true, stop: vi.fn() };
    microphone.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await started;
    expect(track.stop).toHaveBeenCalled();
  });
});
