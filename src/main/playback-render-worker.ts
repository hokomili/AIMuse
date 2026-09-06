import { parentPort, workerData } from 'node:worker_threads';
import { serializeAudioRenderError } from './audio-render-error';
import { renderProjectToWav, type ProjectRenderRequest } from './project-renderer';

const port = parentPort;
if (!port) throw new Error('The playback renderer must run in a worker thread.');

void renderProjectToWav(workerData as ProjectRenderRequest).then(
  (result) => port.postMessage({ ok: true, result }),
  (error) => port.postMessage({ ok: false, ...serializeAudioRenderError(error) }),
);
