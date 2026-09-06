import { readFile } from 'node:fs/promises';

export interface DecodedWav { sampleRate: number; channels: number; frames: number; data: Float32Array[] }

function fourcc(buffer: Buffer, offset: number): string { return buffer.toString('ascii', offset, offset + 4); }

export function encodeFloat32Wav(channels: Float32Array[], sampleRate: number, clamp = true): Buffer {
  const channelCount = channels.length; const frames = channels[0]?.length ?? 0; const dataBytes = frames * channelCount * 4;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0); output.writeUInt32LE(36 + dataBytes, 4); output.write('WAVE', 8); output.write('fmt ', 12); output.writeUInt32LE(16, 16);
  output.writeUInt16LE(3, 20); output.writeUInt16LE(channelCount, 22); output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * channelCount * 4, 28); output.writeUInt16LE(channelCount * 4, 32); output.writeUInt16LE(32, 34); output.write('data', 36); output.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) for (let channel = 0; channel < channelCount; channel += 1) { const sample = channels[channel][frame] ?? 0; output.writeFloatLE(clamp ? Math.max(-1, Math.min(1, sample)) : sample, offset); offset += 4; }
  return output;
}

export function decodeWav(buffer: Buffer): DecodedWav {
  if (fourcc(buffer, 0) !== 'RIFF' || fourcc(buffer, 8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file.');
  let cursor = 12; let format = 0; let channels = 0; let sampleRate = 0; let bits = 0; let dataOffset = 0; let dataLength = 0;
  while (cursor + 8 <= buffer.length) {
    const id = fourcc(buffer, cursor); const length = buffer.readUInt32LE(cursor + 4); const start = cursor + 8;
    if (id === 'fmt ') { format = buffer.readUInt16LE(start); channels = buffer.readUInt16LE(start + 2); sampleRate = buffer.readUInt32LE(start + 4); bits = buffer.readUInt16LE(start + 14); }
    if (id === 'data') { dataOffset = start; dataLength = Math.min(length, buffer.length - start); break; }
    cursor = start + length + (length % 2);
  }
  if (![1, 3].includes(format) || !channels || !sampleRate || !dataOffset) throw new Error('Unsupported WAV format.');
  const bytesPerSample = bits / 8; const frames = Math.floor(dataLength / (bytesPerSample * channels)); const data = Array.from({ length: channels }, () => new Float32Array(frames));
  let offset = dataOffset;
  for (let frame = 0; frame < frames; frame += 1) for (let channel = 0; channel < channels; channel += 1) {
    let value = 0;
    if (format === 3 && bits === 32) value = buffer.readFloatLE(offset);
    else if (bits === 16) value = buffer.readInt16LE(offset) / 32768;
    else if (bits === 24) value = buffer.readIntLE(offset, 3) / 8_388_608;
    else if (bits === 32) value = buffer.readInt32LE(offset) / 2_147_483_648;
    else throw new Error(`Unsupported WAV bit depth: ${bits}.`);
    data[channel][frame] = value; offset += bytesPerSample;
  }
  return { sampleRate, channels, frames, data };
}

export async function readWav(path: string): Promise<DecodedWav> { return decodeWav(await readFile(path)); }
