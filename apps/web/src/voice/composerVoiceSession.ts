import {
  VOICE_RECORDING_LIMIT_SECONDS,
  resolveTranscriptCommit,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { formatSpokenPunctuation } from "@t3tools/shared/voicePunctuation";

export type ComposerVoiceDraft = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

export type ComposerVoiceCommit = {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly insertion: string;
  readonly expectedText: string;
};

export type ComposerVoiceRecorderCallbacks = {
  readonly onError: (error: Error) => void;
  readonly onTranscript: (text: string) => void;
};

export type ComposerVoiceRecorder = {
  start(): void | Promise<void>;
  stop(): Promise<ComposerVoiceTranscript>;
  dispose(): void;
};

export type ComposerVoiceTranscript = { readonly text: string; readonly locale: string };

export type ComposerVoiceSessionDependencies = {
  readonly readDraft: () => ComposerVoiceDraft | null;
  readonly commitDraft: (commit: ComposerVoiceCommit) => boolean;
  readonly requestMicrophone: () => Promise<MediaStream>;
  readonly createRecorder: (
    stream: Promise<MediaStream>,
    callbacks: ComposerVoiceRecorderCallbacks,
  ) => ComposerVoiceRecorder;
  readonly onStateChange: (state: VoiceInputState) => void;
  readonly onComplete?: (draft: ComposerVoiceDraft) => void;
  readonly now?: () => number;
  readonly formatTranscript?: (text: string) => string;
};

export const IDLE_COMPOSER_VOICE_STATE: VoiceInputState = {
  phase: "idle",
  error: null,
  errorAction: null,
};

export const VOICE_BUSY_SEND_DISABLED_REASON = "Finish voice input before sending";

export const VOICE_NON_CODEX_DISABLED_REASON = "Voice for this provider is coming soon";

export const VOICE_CODEX_LOGIN_DISABLED_REASON = "Sign in with `codex login`";

export const VOICE_COMPOSER_BUSY_DISABLED_REASON =
  "Voice input is unavailable while the composer is busy";

export function resolveVoiceSendDisabledReason(input: {
  readonly external: string | null;
  readonly voiceBusy: boolean;
  readonly fallback: string | null;
}) {
  return (
    input.external ?? (input.voiceBusy ? VOICE_BUSY_SEND_DISABLED_REASON : null) ?? input.fallback
  );
}

export function resolveVoiceMicAvailability(input: {
  readonly driverKind: ProviderDriverKind;
  readonly codexVoiceAvailable: boolean;
  readonly composerDisabled: boolean;
}) {
  if (input.driverKind !== "codex") {
    return { available: false, reason: VOICE_NON_CODEX_DISABLED_REASON } as const;
  }
  if (!input.codexVoiceAvailable) {
    return { available: false, reason: VOICE_CODEX_LOGIN_DISABLED_REASON } as const;
  }
  if (input.composerDisabled) {
    return { available: false, reason: VOICE_COMPOSER_BUSY_DISABLED_REASON } as const;
  }
  return { available: true } as const;
}

export function formatVoiceElapsed(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

export function requestComposerMicrophone(): Promise<MediaStream> {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("Voice input is not supported in this browser."));
  }
  return mediaDevices.getUserMedia({ audio: true });
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Could not transcribe this recording.";
}

export class ComposerVoiceSession {
  private readonly dependencies: ComposerVoiceSessionDependencies;
  private state: VoiceInputState = IDLE_COMPOSER_VOICE_STATE;
  private generation = 0;
  private revision = 0;
  private lastSeen: { ownerKey: string; text: string } | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private segmentDraft: VoiceDraftSnapshot | null = null;
  private lastApplied: VoiceDraftSnapshot | null = null;
  private transcript = "";
  private segmentOffset = 0;
  private segmentEnd = 0;
  private stream: MediaStream | null = null;
  private recorder: ComposerVoiceRecorder | null = null;
  private startedAt = 0;
  private elapsedSeconds = 0;
  private finishing = false;
  private disposed = false;

  constructor(dependencies: ComposerVoiceSessionDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  get busy(): boolean {
    return voiceInputBlocksSubmission(this.state);
  }

  getElapsedSeconds(): number {
    if (this.state.phase === "recording") return this.computeElapsed();
    return this.elapsedSeconds;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const generation = ++this.generation;
    const draft = this.readRevisionedDraft();
    if (!draft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    this.capturedDraft = draft;
    this.segmentDraft = draft;
    this.lastApplied = draft;
    this.transcript = "";
    this.segmentOffset = 0;
    this.segmentEnd = draft.selection.end;
    this.elapsedSeconds = 0;
    this.setState({ phase: "preparing", error: null, errorAction: null });
    try {
      // Negotiate the connection while the browser opens the microphone.
      const stream = this.dependencies.requestMicrophone().then((capture) => {
        if (!this.isCurrent(generation)) {
          for (const track of capture.getTracks()) track.stop();
          throw new Error("Voice input was cancelled.");
        }
        this.stream = capture;
        return capture;
      });
      // A synchronous recorder-construction failure must still release a late mic.
      void stream.catch(() => {});
      const recorder = this.dependencies.createRecorder(stream, {
        onTranscript: (text) => {
          if (!this.isCurrent(generation) || !this.busy) return;
          this.applyTranscript(text);
        },
        onError: (recorderError) => {
          if (!this.isCurrent(generation)) return;
          if (this.state.phase !== "recording") return;
          this.cleanupCapture();
          this.capturedDraft = null;
          this.setError(transcriptionErrorMessage(recorderError), "retry");
        },
      });
      this.recorder = recorder;
      await Promise.all([recorder.start(), stream]);
      if (!this.isCurrent(generation)) {
        recorder.dispose();
        return;
      }
      this.startedAt = this.now();
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.generation += 1;
      this.cleanupCapture();
      this.capturedDraft = null;
      this.setError(
        isPermissionDenied(error)
          ? "Microphone access was denied."
          : transcriptionErrorMessage(error),
        "retry",
      );
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording" || this.finishing) return Promise.resolve();
    return this.finishRecording();
  }

  cancel(): void {
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.setState(IDLE_COMPOSER_VOICE_STATE);
        return;
      case "preparing":
      case "recording":
      case "transcribing":
        this.generation += 1;
        // Release the stop gate: cleanup settles any awaiting recorder.stop()
        // (dispose rejects pendingStop), and the stale finishRecording() below
        // must not clobber a fresh session's flag (see finally guard).
        this.finishing = false;
        this.cleanupCapture();
        this.capturedDraft = null;
        this.elapsedSeconds = 0;
        this.setState(IDLE_COMPOSER_VOICE_STATE);
        return;
    }
  }

  dismissError(): void {
    if (this.state.phase === "error") this.setState(IDLE_COMPOSER_VOICE_STATE);
  }

  /** Called on a cheap interval by the owner while recording; auto-stops at the cap. */
  tick(): void {
    if (this.disposed || this.state.phase !== "recording") return;
    this.elapsedSeconds = this.computeElapsed();
    if (this.elapsedSeconds >= VOICE_RECORDING_LIMIT_SECONDS) void this.finishRecording();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.finishing = false;
    this.cleanupCapture();
    this.capturedDraft = null;
  }

  private async finishRecording(): Promise<void> {
    if (this.finishing || this.state.phase !== "recording") return;
    this.finishing = true;
    const generation = this.generation;
    const captured = this.capturedDraft;
    const recorder = this.recorder;
    this.elapsedSeconds = this.computeElapsed();
    this.setState({ phase: "transcribing", error: null, errorAction: null });
    try {
      if (!recorder || !captured) {
        if (this.isCurrent(generation)) this.setError("Could not finish voice recording.", "retry");
        return;
      }
      let transcript: string;
      let locale: string;
      try {
        ({ text: transcript, locale } = await recorder.stop());
      } catch (error) {
        if (this.isCurrent(generation)) {
          this.cleanupCapture();
          this.setError(transcriptionErrorMessage(error), "retry");
        }
        return;
      }
      if (!this.isCurrent(generation)) return;
      this.cleanupCapture();
      if (this.readRevisionedDraft()?.ownerKey !== captured.ownerKey) {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      if (!transcript.trim()) {
        this.setError("No speech was detected.", "retry");
        return;
      }
      const hasFinalWords = transcript !== this.transcript;
      const applied = this.applyTranscript(transcript, locale);
      if (!this.isCurrent(generation)) return;
      if (!applied) {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      // The editor may not have rendered the final commit yet. Use its expected
      // snapshot for new words, but preserve typing since an earlier live chunk.
      const completed = hasFinalWords ? this.lastApplied : this.readRevisionedDraft();
      this.elapsedSeconds = 0;
      this.setState(IDLE_COMPOSER_VOICE_STATE);
      if (completed?.text.trim()) {
        this.dependencies.onComplete?.({
          ownerKey: completed.ownerKey,
          text: completed.text,
          selectionStart: 0,
          selectionEnd: completed.text.length,
        });
      }
    } finally {
      // A cancel/dispose bumps generation and already cleared the gate; only
      // clear here when still current so a stale finish can't unblock (or
      // re-block) a fresh session's stop().
      if (this.generation === generation) this.finishing = false;
    }
  }

  /** Update only our current insertion; moving or editing starts a new one. */
  private applyTranscript(text: string, locale = "en"): boolean {
    const current = this.readRevisionedDraft();
    if (!current || current.ownerKey !== this.capturedDraft?.ownerKey) return false;
    if (text === this.transcript) return true;
    // Realtime input chunks are cumulative. Never replay old speech after edits.
    if (!text.startsWith(this.transcript)) return false;
    const previous = this.lastApplied;
    const moved =
      !previous ||
      current.text !== previous.text ||
      current.selection.start !== previous.selection.start ||
      current.selection.end !== previous.selection.end;
    if (moved) {
      this.segmentDraft = current;
      this.segmentOffset = this.transcript.length;
      this.segmentEnd = current.selection.end;
    }
    const base = this.segmentDraft;
    if (!base) return false;
    const formatted = (this.dependencies.formatTranscript ?? formatSpokenPunctuation)(
      text.slice(this.segmentOffset).trim(),
    );
    const result = resolveTranscriptCommit(base, base, formatted, locale, {
      preserveWhitespace: true,
    });
    if (result.kind === "stale") return false;
    if (result.kind === "empty" && current.text === base.text) {
      this.transcript = text;
      this.lastApplied = current;
      return true;
    }
    const end = this.segmentEnd;
    const insertion =
      result.kind === "empty"
        ? base.text.slice(base.selection.start, base.selection.end)
        : result.text.slice(base.selection.start, result.selection.start);
    const applied = this.dependencies.commitDraft({
      rangeStart: base.selection.start,
      rangeEnd: end,
      insertion,
      expectedText: current.text.slice(base.selection.start, end),
    });
    if (!applied) return false;
    this.transcript = text;
    this.segmentEnd = base.selection.start + insertion.length;
    this.lastApplied =
      result.kind === "empty"
        ? {
            ...current,
            text: base.text,
            selection: { start: this.segmentEnd, end: this.segmentEnd },
          }
        : { ...current, text: result.text, selection: result.selection };
    return true;
  }

  private readRevisionedDraft(): VoiceDraftSnapshot | null {
    const raw = this.dependencies.readDraft();
    if (!raw) return null;
    const last = this.lastSeen;
    if (!last || last.ownerKey !== raw.ownerKey || last.text !== raw.text) {
      this.revision += 1;
      this.lastSeen = { ownerKey: raw.ownerKey, text: raw.text };
    }
    const start = Math.max(0, Math.min(raw.text.length, raw.selectionStart));
    const end = Math.max(start, Math.min(raw.text.length, raw.selectionEnd));
    return {
      ownerKey: raw.ownerKey,
      text: raw.text,
      selection: { start, end },
      revision: this.revision,
    };
  }

  private computeElapsed(): number {
    return Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
    );
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private cleanupCapture(): void {
    try {
      this.recorder?.dispose();
    } catch {
      // Best effort: releasing tracks below matters more than recorder errors.
    }
    this.recorder = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track that refuses to stop must not break session teardown.
        }
      }
      this.stream = null;
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction });
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}
