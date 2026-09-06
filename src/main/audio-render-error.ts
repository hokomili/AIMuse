/** A project/capability change is required before another audio render can succeed. */
export class UnsupportedAudioRenderError extends Error {
  readonly code = 'unsupported-audio-render';
  readonly retryable = false;
}

export function serializeAudioRenderError(error: unknown): { error: string; errorCode?: string } {
  return { error: error instanceof Error ? error.message : String(error), ...(error instanceof UnsupportedAudioRenderError ? { errorCode: error.code } : {}) };
}
