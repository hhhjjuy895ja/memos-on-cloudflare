import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioRecorder } from "@/components/MemoEditor/hooks/useAudioRecorder";

class MockMediaRecorder extends EventTarget {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = "inactive";
  finalChunk = new Blob();

  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions,
  ) {
    super();
    MockMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => {
    this.state = "recording";
  });

  stop = vi.fn(() => {
    if (this.state === "inactive") throw new DOMException("Recorder is inactive", "InvalidStateError");
    this.state = "inactive";
    // The browser delivers the final audio chunk before its asynchronous stop event.
    void Promise.resolve().then(() => {
      this.emitChunk(this.finalChunk);
      this.dispatchEvent(new Event("stop"));
    });
  });

  emitChunk(data: Blob) {
    const event = new Event("dataavailable");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

function createActions() {
  return {
    setAudioRecorderSupport: vi.fn(),
    setAudioRecorderPermission: vi.fn(),
    setAudioRecorderStatus: vi.fn(),
    setAudioRecorderElapsed: vi.fn(),
    setAudioRecorderError: vi.fn(),
    onRecordingComplete: vi.fn(),
    onRecordingEmpty: vi.fn(),
  };
}

describe("useAudioRecorder", () => {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>();
  let stopTrack: ReturnType<typeof vi.fn>;
  let stream: MediaStream;
  let originalMediaDevices: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));
    MockMediaRecorder.instances = [];
    stopTrack = vi.fn();
    stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    getUserMedia.mockReset().mockResolvedValue(stream);
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:recorded-audio");
        static revokeObjectURL = vi.fn();
      },
    );
  });

  afterEach(() => {
    cleanup();
    if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps recording and elapsed time when actions change, then delivers retained audio to the latest callback", async () => {
    const originalActions = createActions();
    const latestActions = createActions();
    const { result, rerender } = renderHook(({ actions }) => useAudioRecorder(actions), {
      initialProps: { actions: originalActions },
    });

    await act(() => result.current.startRecording());
    const recorder = MockMediaRecorder.instances[0];
    const firstChunk = new Blob(["audio before rerender"]);
    recorder.emitChunk(firstChunk);
    rerender({ actions: latestActions });

    expect(stopTrack).not.toHaveBeenCalled();
    expect(result.current.recordingStream).toBe(stream);
    expect(latestActions.setAudioRecorderStatus).not.toHaveBeenCalledWith("idle");
    const previousElapsedUpdates = originalActions.setAudioRecorderElapsed.mock.calls.length;
    act(() => vi.advanceTimersByTime(1250));
    expect(latestActions.setAudioRecorderElapsed).toHaveBeenLastCalledWith(1);
    expect(originalActions.setAudioRecorderElapsed).toHaveBeenCalledTimes(previousElapsedUpdates);

    recorder.finalChunk = new Blob(["audio at stop"]);
    await act(async () => {
      expect(result.current.stopRecording("transcribe")).toBe(true);
      await Promise.resolve();
    });

    expect(originalActions.onRecordingComplete).not.toHaveBeenCalled();
    expect(latestActions.onRecordingComplete).toHaveBeenCalledTimes(1);
    const [recording, mode] = latestActions.onRecordingComplete.mock.calls[0];
    expect(mode).toBe("transcribe");
    expect(recording.file).toBeInstanceOf(File);
    expect(recording.file.size).toBe(firstChunk.size + recorder.finalChunk.size);
    expect(recording.file.type).toBe("audio/webm;codecs=opus");
    expect(recording.origin).toBe("audio_recording");
    expect(recording.audioMeta.durationSeconds).toBe(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(result.current.recordingStream).toBeNull();
    expect(latestActions.setAudioRecorderStatus).toHaveBeenLastCalledWith("idle");
  });

  it("reports an empty recording through the latest callback", async () => {
    const originalActions = createActions();
    const latestActions = createActions();
    const { result, rerender } = renderHook(({ actions }) => useAudioRecorder(actions), {
      initialProps: { actions: originalActions },
    });

    await act(() => result.current.startRecording());
    rerender({ actions: latestActions });
    await act(async () => {
      expect(result.current.stopRecording("transcribe")).toBe(true);
      await Promise.resolve();
    });

    expect(originalActions.onRecordingEmpty).not.toHaveBeenCalled();
    expect(latestActions.onRecordingEmpty).toHaveBeenCalledExactlyOnceWith("transcribe");
    expect(latestActions.onRecordingComplete).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("stops the microphone and elapsed updates when unmounted", async () => {
    const actions = createActions();
    const { result, unmount } = renderHook(() => useAudioRecorder(actions));
    await act(() => result.current.startRecording());
    act(() => vi.advanceTimersByTime(1000));
    expect(actions.setAudioRecorderElapsed).toHaveBeenLastCalledWith(1);

    unmount();
    const elapsedUpdates = actions.setAudioRecorderElapsed.mock.calls.length;
    act(() => vi.advanceTimersByTime(2000));

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(actions.setAudioRecorderElapsed).toHaveBeenCalledTimes(elapsedUpdates);
    expect(actions.onRecordingComplete).not.toHaveBeenCalled();
  });

  it("closes a microphone acquired after unmount without starting a recorder", async () => {
    let resolveStream!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => (resolveStream = resolve)));
    const actions = createActions();
    const { result, unmount } = renderHook(() => useAudioRecorder(actions));
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.startRecording();
    });

    unmount();
    await act(async () => {
      resolveStream(stream);
      await startPromise;
    });

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances).toHaveLength(0);
    expect(actions.setAudioRecorderStatus).not.toHaveBeenCalledWith("recording");
    expect(actions.onRecordingComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards audio and any queued completion when recording is reset", async () => {
    const actions = createActions();
    const { result } = renderHook(() => useAudioRecorder(actions));
    await act(() => result.current.startRecording());
    MockMediaRecorder.instances[0].finalChunk = new Blob(["discard this recording"]);

    await act(async () => {
      expect(result.current.stopRecording("transcribe")).toBe(true);
      result.current.resetRecording();
      await Promise.resolve();
    });

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(actions.onRecordingComplete).not.toHaveBeenCalled();
    expect(actions.onRecordingEmpty).not.toHaveBeenCalled();
    expect(result.current.recordingStream).toBeNull();
    expect(result.current.stopRecording()).toBe(false);
  });
});
