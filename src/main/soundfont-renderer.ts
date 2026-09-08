import { SpessaSynthProcessor, type BasicSoundBank, type MIDIController } from 'spessasynth_core';
import { ticksToSamples, type AIMuseProject, type Device, type MidiClip } from '@aimuse/core';
import { SOUNDFONT_CONTROLLERS } from '../common/soundfont-library';
import { UnsupportedAudioRenderError } from './audio-render-error';
import { gainFromDb, parameter, type Stereo } from './render-dsp';

interface Event { frame: number; priority: number; apply(synth: SpessaSynthProcessor): void }

/** A clip owns its voices/controllers; each loop restarts them. Tails are bounded
 * by the clip/loop end, matching the other instrument's rendering contract. */
export async function renderSoundFontClip(project: AIMuseProject, clip: MidiClip, data: Stereo, device: Device, bank: BasicSoundBank, fade: (frame: number) => number): Promise<void> {
  const settings = device.soundfont!;
  const preset = bank.presets.find((value) => value.program === settings.program && (value.isGMGSDrum ? 128 : value.bankMSB) === settings.bank && value.bankLSB === 0);
  if (!preset) throw new UnsupportedAudioRenderError(`${device.name}: SoundFont bank ${settings.bank}, program ${settings.program} is missing. Select an available preset.`);
  for (const event of Object.values(clip.controls)) if (!SOUNDFONT_CONTROLLERS.some((value) => value === event.controller)) throw new UnsupportedAudioRenderError(`${clip.name}: SoundFont supports CC1, CC7, CC10, CC11 and CC64; controller ${event.controller} is unavailable.`);
  for (const note of Object.values(clip.notes)) if (note.probability > 0 && note.probability < 1) throw new UnsupportedAudioRenderError(`${clip.name}: fractional note probability is unavailable.`);
  const fs = project.settings.sampleRate;
  const length = clip.loopEnabled ? clip.loopLengthTicks! : clip.durationTicks;
  const gain = gainFromDb(clip.gainDb + parameter(device, 'gain', 0));
  for (let offset = 0; offset < clip.durationTicks; offset += length) {
    const base = clip.startTick + offset; const start = ticksToSamples(project, base);
    if (start >= data[0].length) break;
    const endTick = Math.min(base + length, clip.startTick + clip.durationTicks);
    const end = Math.min(data[0].length, ticksToSamples(project, endTick));
    const events: Event[] = [];
    for (const event of Object.values(clip.controls)) if (event.tick < endTick - base) events.push({ frame: ticksToSamples(project, base + event.tick), priority: 0, apply: (synth) => synth.controllerChange(event.channel, event.controller as MIDIController, Math.round(event.value * 127)) });
    for (const event of Object.values(clip.pitchBends)) if (event.tick < endTick - base) events.push({ frame: ticksToSamples(project, base + event.tick), priority: 0, apply: (synth) => synth.pitchWheel(event.channel, Math.round(8192 + event.value * (event.value < 0 ? 8192 : 8191))) });
    for (const note of Object.values(clip.notes)) {
      if (!note.probability || !note.velocity || note.startTick >= endTick - base) continue;
      const on = ticksToSamples(project, base + note.startTick);
      const off = Math.min(end, Math.max(on + 1, ticksToSamples(project, base + note.startTick + note.durationTicks)));
      events.push({ frame: on, priority: 2, apply: (synth) => synth.noteOn(note.channel, note.pitch, Math.max(1, Math.round(note.velocity * 127))) }, { frame: off, priority: 1, apply: (synth) => synth.noteOff(note.channel, note.pitch) });
    }
    events.sort((a, b) => a.frame - b.frame || a.priority - b.priority);
    if (!events.length) continue;
    const synth = new SpessaSynthProcessor(fs, { eventsEnabled: false, effectsEnabled: false });
    try {
      synth.soundBankManager.addSoundBank(bank, 'instrument');
      await synth.processorInitialized;
      synth.setSystemParameter('autoAllocateVoices', true);
      for (let channel = 0; channel < 16; channel += 1) {
        synth.midiChannels[channel].setDrums(preset.isGMGSDrum);
        synth.controllerChange(channel, 0, preset.bankMSB);
        synth.controllerChange(channel, 32, preset.bankLSB);
        synth.programChange(channel, preset.program);
        if (!synth.midiChannels[channel].preset?.matches(preset)) throw new UnsupportedAudioRenderError(`${device.name}: the selected SoundFont preset could not be assigned.`);
        synth.controllerChange(channel, 7, 127);
        synth.controllerChange(channel, 11, 127);
      }
      const left = new Float32Array(128); const right = new Float32Array(128);
      let eventIndex = 0;
      for (let frame = start; frame < end;) {
        while (eventIndex < events.length && events[eventIndex].frame <= frame) {
          events[eventIndex++].apply(synth);
          if (synth.voiceCount > 4096) throw new UnsupportedAudioRenderError(`${clip.name}: SoundFont exceeds the 4096-voice render limit. Reduce overlapping notes or sustain.`);
        }
        const count = Math.min(128, end - frame, eventIndex < events.length ? events[eventIndex].frame - frame : 128);
        left.fill(0); right.fill(0); synth.process(left, right, 0, count);
        for (let i = 0; i < count; i += 1) { const level = gain * fade(frame + i); data[0][frame + i] += left[i] * level; data[1][frame + i] += right[i] * level; }
        frame += count;
      }
    } finally {
      // The track owns this bank across clips/loops. Destroying a processor also
      // destroys attached banks, so detach it before releasing the voices.
      synth.soundBankManager.deleteSoundBank('instrument');
      synth.destroySynthProcessor();
    }
  }
}
