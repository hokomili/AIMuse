import { parentPort } from 'node:worker_threads';
import { serializeAudioRenderError, UnsupportedAudioRenderError } from '../../src/main/audio-render-error.ts';
parentPort.postMessage({ ok: false, ...serializeAudioRenderError(new UnsupportedAudioRenderError('Unsupported fixture processing.')) });
