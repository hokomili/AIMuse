import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) throw new Error('Fixture requires a worker port.');
const output = Buffer.alloc(52);
output.write('RIFF', 0); output.writeUInt32LE(44, 4); output.write('WAVE', 8); output.write('fmt ', 12); output.writeUInt32LE(16, 16);
output.writeUInt16LE(3, 20); output.writeUInt16LE(2, 22); output.writeUInt32LE(workerData.project.settings.sampleRate, 24);
output.writeUInt32LE(workerData.project.settings.sampleRate * 8, 28); output.writeUInt16LE(8, 32); output.writeUInt16LE(32, 34);
output.write('data', 36); output.writeUInt32LE(8, 40); output.writeFloatLE(0.25, 44); output.writeFloatLE(-0.25, 48);
await mkdir(dirname(workerData.destination), { recursive: true });
await writeFile(workerData.destination, output);
await new Promise((resolve) => setTimeout(resolve, 25));
parentPort.postMessage({ ok: true, result: { destination: workerData.destination, durationSamples: 1, warnings: [] } });
