import archiver from 'archiver';
import { Midi } from '@tonejs/midi';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import {
  HUMAN_ACTOR, nowIso,
  type AIMuseProject, type Actor, type AsyncJob, type Id, type MidiClip, type SfxDeliverable,
} from '@aimuse/core';
import type { ExportRequest } from '../common/contracts';
import { AudioEngineController } from './audio-engine';
import { AuthorityManager } from './authority-manager';
import { atomicWriteFile, packProjectFolder, sha256File } from './persistence';
import { ProjectService } from './project-service';
import { analyzePcm } from './media-manager';
import { decodeWav, encodeFloat32Wav } from './wav';
import { applyTrackFader } from './project-renderer';
import { UnsupportedAudioRenderError } from './audio-render-error';

export interface ExportPartialEffects {
  output: 'unchanged' | 'may-be-partial' | 'retained';
  project: 'unchanged' | 'save-may-have-completed';
}
export interface ExportReport { destination: string; warnings: string[]; fallbackReport?: string; request?: ExportRequest; partial?: ExportPartialEffects }
function xml(value: string): string { return value.replace(/[&<>"']/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[match]!); }
function safeName(value: string): string {
  const cleaned = [...value].map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character).join('');
  return cleaned.replace(/[. ]+$/g, '').slice(0, 180) || 'Untitled';
}
async function exists(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
function finalExtension(path: string, extension: string): string { return extname(path).toLowerCase() === extension ? resolve(path) : resolve(`${path}${extension}`); }
function effectiveDestination(request: ExportRequest): string {
  if (request.kind === 'master') return finalExtension(request.destination, `.${request.format ?? 'wav'}`);
  if (request.kind === 'midi') return finalExtension(request.destination, '.mid');
  if (request.kind === 'dawproject') return finalExtension(request.destination, '.dawproject');
  if (request.kind === 'pack') return finalExtension(request.destination, '.aimusepack');
  return resolve(request.destination);
}
function exportPartial(request: ExportRequest, output: ExportPartialEffects['output'], executionStarted: boolean): ExportPartialEffects {
  return { output, project: request.kind === 'pack' && executionStarted ? 'save-may-have-completed' : 'unchanged' };
}
function jobResult(job: AsyncJob): Record<string, unknown> { return typeof job.result === 'object' && job.result ? job.result as Record<string, unknown> : {}; }
function jobRequest(job: AsyncJob): ExportRequest | undefined { return jobResult(job).request as ExportRequest | undefined; }

async function normalizeLufs(path: string, target: number, master?: AIMuseProject['tracks'][string]): Promise<void> {
  const decoded = decodeWav(await readFile(path)); const analysis = analyzePcm(decoded, 'render'); const requestedGain = 10 ** ((target - analysis.integratedLufs) / 20); let peak = 0; for (const channel of decoded.data) for (const sample of channel) peak = Math.max(peak, Math.abs(sample)); const gain = Math.min(requestedGain, peak > 0 ? 0.98 / peak : requestedGain);
  for (const channel of decoded.data) for (let index = 0; index < channel.length; index += 1) channel[index] = Math.tanh(channel[index] * gain * 1.02) / Math.tanh(1.02); if (master) { const stereo: [Float32Array, Float32Array] = [decoded.data[0], decoded.data[1] ?? decoded.data[0].slice()]; applyTrackFader(stereo, master); decoded.data = decoded.channels === 1 ? [stereo[0].map((sample, index) => (sample + stereo[1][index]) * 0.5)] : stereo; }
  await atomicWriteFile(path, encodeFloat32Wav(decoded.data, decoded.sampleRate));
}

function variationRandom(deliverable: SfxDeliverable, index: number): () => number {
  let state = deliverable.variation.seed >>> 0;
  for (const character of `${deliverable.id}:${index}`) state = Math.imul(state ^ character.charCodeAt(0), 0x45d9f3b) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

async function applySfxVariation(path: string, deliverable: SfxDeliverable, index: number): Promise<{ pitchSemitones: number; gainDb: number; timingMilliseconds: number; frames: number }> {
  const decoded = decodeWav(await readFile(path));
  const random = variationRandom(deliverable, index);
  const pitchSemitones = index === 1 ? 0 : (random() * 2 - 1) * deliverable.variation.pitchRangeSemitones;
  const gainDb = index === 1 ? 0 : (random() * 2 - 1) * deliverable.variation.gainRangeDb;
  const timingMilliseconds = index === 1 ? 0 : (random() * 2 - 1) * deliverable.variation.timingRangeMilliseconds;
  const ratio = 2 ** (pitchSemitones / 12); const gain = 10 ** (gainDb / 20); const offset = timingMilliseconds * decoded.sampleRate / 1_000;
  let data = decoded.data.map((source) => { const output = new Float32Array(decoded.frames); for (let frame = 0; frame < output.length; frame += 1) { const position = (frame - offset) * ratio; const left = Math.floor(position); const fraction = position - left; if (left < 0 || left >= source.length) continue; const a = source[left] ?? 0; const b = source[Math.min(source.length - 1, left + 1)] ?? a; output[frame] = (a + (b - a) * fraction) * gain; } return output; });
  if (deliverable.seamlessLoop) {
    const start = deliverable.loopStartSample ?? 0; const end = deliverable.loopEndSample ?? data[0].length;
    if (start < 0 || end <= start || end > data[0].length) throw new Error(`${deliverable.name}: loop sample range exceeds the rendered deliverable.`);
    data = data.map((channel) => channel.slice(start, end));
    // Short cosine boundary fades run after pitch/timing variation and preserve duration.
    // They make each exact splice endpoint-continuous; no listening verdict is implied.
    const width = Math.min(Math.round(decoded.sampleRate * 0.01), Math.floor(data[0].length / 2));
    for (const channel of data) {
      if (channel.length < 4) { channel.fill(channel.reduce((sum, value) => sum + value, 0) / channel.length); continue; }
      for (let frame = 0; frame < width; frame += 1) {
        const gain = 0.5 - 0.5 * Math.cos(Math.PI * frame / (width - 1));
        channel[frame] *= gain; channel[channel.length - 1 - frame] *= gain;
      }
    }
  }
  await atomicWriteFile(path, encodeFloat32Wav(data, decoded.sampleRate));
  return { pitchSemitones, gainDb, timingMilliseconds, frames: data[0]?.length ?? 0 };
}

function encodeMidi(project: AIMuseProject, selectedTrackIds?: Id[]): Uint8Array {
  const midi = new Midi(); midi.header.fromJSON({ name: project.name, ppq: project.settings.ppq, tempos: project.tempoOrder.map((id) => ({ ticks: project.tempoEvents[id].tick, bpm: project.tempoEvents[id].bpm })), timeSignatures: project.timeSignatureOrder.map((id) => ({ ticks: project.timeSignatureEvents[id].tick, timeSignature: [project.timeSignatureEvents[id].numerator, project.timeSignatureEvents[id].denominator] })), keySignatures: [], meta: project.markerOrder.map((id) => ({ ticks: project.markers[id].tick, type: 'marker' as const, text: project.markers[id].name })) });
  const selected = selectedTrackIds ? new Set(selectedTrackIds) : undefined;
  for (const sourceTrack of Object.values(project.tracks)) {
    if (selected && !selected.has(sourceTrack.id)) continue; const clips = sourceTrack.clipIds.map((id) => project.clips[id]).filter((clip): clip is MidiClip => clip?.kind === 'midi'); if (!clips.length) continue;
    for (let channel = 0; channel < 16; channel += 1) {
      const notes = clips.flatMap((clip) => Object.values(clip.notes).filter((note) => note.channel === channel).map((note) => ({ clip, note })));
      const controls = clips.flatMap((clip) => Object.values(clip.controls).filter((event) => event.channel === channel).map((event) => ({ clip, event })));
      const pitchBends = clips.flatMap((clip) => Object.values(clip.pitchBends).filter((event) => event.channel === channel).map((event) => ({ clip, event })));
      if (!notes.length && !controls.length && !pitchBends.length) continue;
      const track = midi.addTrack(); track.name = `${sourceTrack.name}${channel ? ` ch ${channel + 1}` : ''}`; track.channel = channel;
      for (const { clip, note } of notes) track.addNote({ ticks: clip.startTick + note.startTick, durationTicks: note.durationTicks, midi: note.pitch, velocity: note.velocity, noteOffVelocity: note.releaseVelocity });
      for (const { clip, event } of controls) track.addCC({ ticks: clip.startTick + event.tick, number: event.controller, value: event.value });
      // @tonejs/midi exposes decoded bends as normalized values but its encoder
      // forwards the raw signed 14-bit MIDI value to midi-file.
      for (const { clip, event } of pitchBends) track.addPitchBend({ ticks: clip.startTick + event.tick, value: Math.round(event.value * 8_192) });
    }
  }
  return midi.toArray();
}

function dawProjectXml(project: AIMuseProject): { xml: string; fallbacks: string[] } {
  let counter = 0; const id = (): string => `id${counter++}`; const objectIds = new Map<Id, string>(); for (const trackId of project.trackOrder) objectIds.set(trackId, id()); const master = Object.values(project.tracks).find((track) => track.kind === 'master')!; const channelIds = new Map<Id, string>(); for (const track of Object.values(project.tracks)) channelIds.set(track.id, id()); const fallbacks: string[] = [];
  const trackXml = project.trackOrder.map((trackId) => { const track = project.tracks[trackId]; const contentType = track.kind === 'instrument' || track.kind === 'midi' ? 'notes' : track.kind === 'folder' ? 'tracks' : 'audio'; const destination = track.kind === 'master' ? '' : ` destination="${channelIds.get(track.routing.outputTrackId ?? master.id)}"`; const devices = track.deviceIds.map((deviceId) => { const device = project.devices[deviceId]; if (device.format === 'builtin' || device.format === 'missing') { fallbacks.push(`${track.name}: ${device.name} is not portable; audio rendering supports only the documented subset; unsupported processing must be rendered externally and imported as WAV to preserve its sound.`); return ''; } const element = device.format === 'clap' ? 'ClapPlugin' : 'Vst3Plugin'; return `<${element} deviceID="${xml(device.pluginId ?? '')}" deviceName="${xml(device.name)}" deviceRole="${track.kind === 'instrument' ? 'instrument' : 'audioFX'}" loaded="${!device.degraded}" id="${id()}" name="${xml(device.name)}"><Parameters/>${device.stateAssetId ? `<State path="plugins/${xml(device.stateAssetId)}.state"/>` : ''}<Enabled value="${!device.bypassed}" id="${id()}" name="On/Off"/></${element}>`; }).join(''); return `<Track contentType="${contentType}" loaded="true" id="${objectIds.get(track.id)}" name="${xml(track.name)}" color="${xml(track.color)}"><Channel audioChannels="2"${destination} role="${track.kind === 'master' ? 'master' : 'regular'}" solo="${track.solo}" id="${channelIds.get(track.id)}"><Devices>${devices}</Devices><Mute value="${track.mute}" id="${id()}" name="Mute"/><Pan max="1" min="0" unit="normalized" value="${(track.pan + 1) / 2}" id="${id()}" name="Pan"/><Volume max="2" min="0" unit="linear" value="${10 ** (track.gainDb / 20)}" id="${id()}" name="Volume"/></Channel></Track>`; }).join('');
  const lanes = project.trackOrder.map((trackId) => { const track = project.tracks[trackId]; const clips = track.clipIds.map((clipId) => { const clip = project.clips[clipId]; if (!clip) return ''; if (clip.kind === 'midi') { const notes = clip.noteOrder.map((noteId) => { const note = clip.notes[noteId]; return `<Note time="${note.startTick / project.settings.ppq}" duration="${note.durationTicks / project.settings.ppq}" channel="${note.channel}" key="${note.pitch}" vel="${note.velocity}" rel="${note.releaseVelocity}"/>`; }).join(''); return `<Clip time="${clip.startTick / project.settings.ppq}" duration="${clip.durationTicks / project.settings.ppq}" playStart="0" name="${xml(clip.name)}"><Notes id="${id()}">${notes}</Notes></Clip>`; } const asset = project.assets[clip.assetId]; if (!asset) return ''; const mediaPath = `audio/${asset.sha256}${extname(asset.name) || '.wav'}`; return `<Clip time="${clip.startTick / project.settings.ppq}" duration="${clip.durationTicks / project.settings.ppq}" playStart="0" fadeTimeUnit="beats" fadeInTime="${clip.fadeIn.durationTicks / project.settings.ppq}" fadeOutTime="${clip.fadeOut.durationTicks / project.settings.ppq}" name="${xml(clip.name)}"><Clips id="${id()}"><Clip time="0" duration="${clip.durationTicks / project.settings.ppq}" contentTimeUnit="seconds" playStart="${clip.sourceStartSample / (asset.sampleRate ?? project.settings.sampleRate)}"><Audio algorithm="${clip.stretchMode}" channels="${asset.channels ?? 2}" duration="${clip.sourceDurationSamples / (asset.sampleRate ?? project.settings.sampleRate)}" sampleRate="${asset.sampleRate ?? project.settings.sampleRate}" id="${id()}"><File path="${xml(mediaPath)}"/></Audio></Clip></Clips></Clip>`; }).join(''); return `<Lanes track="${objectIds.get(track.id)}" id="${id()}"><Clips id="${id()}">${clips}</Clips></Lanes>`; }).join('');
  if (Object.keys(project.sends).length) fallbacks.push('Send routing is described in fallback-report.json; some DAWs may require manual recreation.'); if (Object.keys(project.sidechains).length) fallbacks.push('Sidechains require manual verification after import.'); if (project.tempoOrder.length > 1) fallbacks.push('The first tempo is in Transport; additional tempo events may require manual verification.'); if (Object.keys(project.provenance).length) fallbacks.push('Legacy generation provenance is passively preserved in fallback-report.json, not the DAWproject core schema.');
  const tempo = project.tempoEvents[project.tempoOrder[0]]; const meter = project.timeSignatureEvents[project.timeSignatureOrder[0]]; return { xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Project version="1.0"><Application name="AIMuse" version="0.1.0-alpha.0"/><Transport><Tempo max="400" min="20" unit="bpm" value="${tempo.bpm}" id="${id()}" name="Tempo"/><TimeSignature denominator="${meter.denominator}" numerator="${meter.numerator}" id="${id()}"/></Transport><Structure>${trackXml}</Structure><Arrangement id="${id()}"><Lanes timeUnit="beats" id="${id()}">${lanes}</Lanes></Arrangement><Scenes/></Project>`, fallbacks };
}

interface DawProjectArchiveFile { archivePath: string; sourcePath: string }

async function dawProjectArchiveFiles(project: AIMuseProject, projects: ProjectService): Promise<DawProjectArchiveFile[]> {
  const files = new Map<string, { sourcePath: string; digest?: Awaited<ReturnType<typeof sha256File>> }>();
  for (const asset of Object.values(project.assets)) {
    const sourcePath = projects.getAssetSource(project.id, asset.id);
    if (!sourcePath) continue;
    const archivePath = asset.kind === 'audio'
      ? `audio/${asset.sha256}${extname(asset.name) || '.wav'}`
      : asset.kind === 'plugin-state' ? `plugins/${asset.id}.state` : undefined;
    if (!archivePath) continue;
    const existing = files.get(archivePath);
    if (!existing) {
      files.set(archivePath, { sourcePath });
      continue;
    }
    existing.digest ??= await sha256File(existing.sourcePath);
    const candidate = await sha256File(sourcePath);
    if (existing.digest.sha256 !== candidate.sha256 || existing.digest.byteLength !== candidate.byteLength) {
      throw new Error(`DAWproject archive member ${archivePath} resolves to different payloads.`);
    }
  }
  return [...files].map(([archivePath, value]) => ({ archivePath, sourcePath: value.sourcePath }));
}

async function writeDawProject(project: AIMuseProject, destination: string, projects: ProjectService): Promise<{ destination: string; fallbackReport: string }> {
  const target = finalExtension(destination, '.dawproject'); const temporary = `${target}.${process.pid}.${Date.now()}.tmp`; await mkdir(dirname(target), { recursive: true }); const generated = dawProjectXml(project); const report = { format: 'AIMuse DAWproject fallback report', projectId: project.id, generatedAt: nowIso(), warnings: generated.fallbacks, sends: project.sends, sidechains: project.sidechains, provenance: project.provenance }; const archiveFiles = await dawProjectArchiveFiles(project, projects);
  await new Promise<void>((resolvePromise, reject) => { const output = createWriteStream(temporary, { flags: 'wx' }); const archive = archiver('zip', { zlib: { level: 6 }, forceZip64: true }); output.once('close', resolvePromise); output.once('error', reject); archive.once('error', reject); archive.pipe(output); archive.append(generated.xml, { name: 'project.xml' }); archive.append(`<?xml version="1.0" encoding="UTF-8"?><MetaData><Title>${xml(project.name)}</Title><Artist>AIMuse creator</Artist><Comment>Exported from AIMuse</Comment></MetaData>`, { name: 'metadata.xml' }); archive.append(`${JSON.stringify(report, null, 2)}\n`, { name: 'fallback-report.json' }); for (const file of archiveFiles) archive.file(file.sourcePath, { name: file.archivePath }); void archive.finalize(); }); await rename(temporary, target); return { destination: target, fallbackReport: generated.fallbacks.join('\n') };
}

export class ExportManager {
  private readonly actors = new Map<Id, Actor>();
  constructor(private readonly projects: ProjectService, private readonly audio: AudioEngineController, private readonly authority: AuthorityManager) { projects.on('approval-resolved', (job: AsyncJob, decision: string) => { const request = (job.result as { request?: ExportRequest } | undefined)?.request; const actor = this.actors.get(job.id); if (request && actor && ['render', 'pack'].includes(job.kind) && decision !== 'deny') void this.run(job.id, request, actor, true); }); }

  start(request: ExportRequest, actor: Actor = HUMAN_ACTOR, approvalReservationId?: Id): { jobId: Id } { const jobId = `export-${crypto.randomUUID()}`; if (approvalReservationId && !this.projects.bindApprovalReservation(approvalReservationId, jobId, actor.id)) throw new Error('Approval reservation is no longer available.'); const timestamp = nowIso(); this.actors.set(jobId, structuredClone(actor)); this.projects.upsertJob({ id: jobId, ownerActorId: actor.id, projectId: request.projectId, kind: request.kind === 'pack' ? 'pack' : 'render', status: 'queued', progress: 0, message: 'Export queued.', createdAt: timestamp, updatedAt: timestamp, cancellable: true, result: { request } }); void this.run(jobId, request, actor, false); return { jobId }; }

  cancel(jobId: Id): AsyncJob | undefined {
    const current = this.projects.getJob(jobId);
    if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) return current;
    if (!this.actors.has(jobId)) return this.projects.cancelJob(jobId);
    const request = jobRequest(current); const cancelled = this.projects.cancelJob(jobId);
    if (!cancelled || cancelled.status !== 'cancelled' || !request) return cancelled;
    const executionStarted = current.status === 'running';
    const next: AsyncJob = {
      ...cancelled,
      cancellable: false,
      message: executionStarted
        ? 'Export cancellation is terminal. In-flight output is not preempted, cleaned up, or retried automatically.'
        : 'Export cancelled before destination writes or a portable-pack save started.',
      result: { ...jobResult(cancelled), partial: exportPartial(request, executionStarted ? 'may-be-partial' : 'unchanged', executionStarted) },
    };
    delete next.approval; delete next.error;
    this.projects.upsertJob(next); return next;
  }

  private async run(jobId: Id, request: ExportRequest, actor: Actor, authorityOverride: boolean): Promise<void> {
    let executionStarted = false;
    try { const target = effectiveDestination(request); const effectiveRequest = { ...request, destination: target }; const targetExists = await exists(target); if (actor.kind === 'agent' && !authorityOverride) { const decision = await this.authority.file(target, 'write', targetExists); const current = this.projects.getJob(jobId); if (!current || current.status === 'cancelled') return; if (!decision.allowed) { this.projects.upsertJob({ ...current, status: 'waiting-for-user', message: decision.reason ?? 'Export requires approval.', updatedAt: nowIso(), approval: { kind: decision.approvalKind ?? 'file-write', summary: `${actor.name} requests a ${request.kind} export.`, request: { destination: target, kind: request.kind, format: request.format, overwrite: request.overwrite, existedAtReview: targetExists }, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } }); return; } } if (targetExists && !request.overwrite) throw new Error('Export destination exists and overwrite was not explicitly requested.'); const project = this.projects.getProject(request.projectId); if (!project) throw new Error('Project is not open.'); const runnable = this.projects.getJob(jobId); if (!runnable || runnable.status === 'cancelled') return; executionStarted = true; this.projects.upsertJob({ ...runnable, status: 'running', progress: 0.03, message: `Exporting ${request.kind}…`, updatedAt: nowIso(), approval: undefined }); let report: ExportReport;
      if (request.kind === 'master') report = await this.master(project, effectiveRequest); else if (request.kind === 'stems') report = await this.stems(project, effectiveRequest, jobId); else if (request.kind === 'midi') { await atomicWriteFile(target, encodeMidi(project, request.trackIds)); report = { destination: target, warnings: [] }; } else if (request.kind === 'dawproject') { const value = await writeDawProject(project, target, this.projects); report = { destination: value.destination, warnings: value.fallbackReport ? value.fallbackReport.split('\n') : [], fallbackReport: value.fallbackReport }; } else if (request.kind === 'sfx-batch') report = await this.sfx(project, effectiveRequest, jobId); else report = await this.pack(project, effectiveRequest, actor);
      const current = this.projects.getJob(jobId)!;
      if (current.status === 'cancelled') {
        this.projects.upsertJob({ ...current, cancellable: false, progress: 1, message: `Export cancellation remained terminal after ${request.kind} output completed. The output remains at its destination.`, updatedAt: nowIso(), error: undefined, result: { ...jobResult(current), ...report, request, partial: exportPartial(request, 'retained', true) } });
        return;
      }
      this.projects.upsertJob({ ...current, status: 'completed', cancellable: false, progress: 1, message: `Exported to ${report.destination}${report.warnings.length ? ` with ${report.warnings.length} warning(s). Inspect result.warnings.` : ''}`, updatedAt: nowIso(), result: report });
    } catch (error) {
      const current = this.projects.getJob(jobId)!; const message = error instanceof Error ? error.message : String(error);
      if (current.status === 'cancelled') {
        this.projects.upsertJob({ ...current, cancellable: false, message: `Export cancellation remained terminal. Partial ${request.kind} output may remain; no automatic cleanup or retry was attempted.`, updatedAt: nowIso(), error: undefined, result: { ...jobResult(current), request, partial: exportPartial(request, executionStarted ? 'may-be-partial' : 'unchanged', executionStarted) } });
        return;
      }
      this.projects.upsertJob({ ...current, status: 'failed', cancellable: false, message, updatedAt: nowIso(), result: { ...jobResult(current), request, partial: exportPartial(request, executionStarted ? 'may-be-partial' : 'unchanged', executionStarted) }, error: { code: error instanceof UnsupportedAudioRenderError ? error.code : 'export-failed', message, retryable: !(error instanceof UnsupportedAudioRenderError) } });
    }
  }

  private async master(project: AIMuseProject, request: ExportRequest): Promise<ExportReport> { if ((request.format ?? 'wav') !== 'wav') throw new UnsupportedAudioRenderError(`${request.format?.toUpperCase()} encoding requires the native codec service; AIMuse did not silently substitute WAV.`); const destination = finalExtension(request.destination, '.wav'); const rendered = await this.audio.render(project, destination, request.startTick, request.endTick, request.trackIds, { skipMasterFader: true }); await normalizeLufs(destination, project.settings.masterLufsTarget, Object.values(project.tracks).find((track) => track.kind === 'master')); return { destination, warnings: rendered.warnings }; }
  private async stems(project: AIMuseProject, request: ExportRequest, jobId: Id): Promise<ExportReport> { if ((request.format ?? 'wav') !== 'wav') throw new UnsupportedAudioRenderError(`${request.format?.toUpperCase()} stem encoding requires the native codec service.`); const destination = resolve(request.destination); await mkdir(destination, { recursive: true }); const tracks = Object.values(project.tracks).filter((track) => !['master', 'folder'].includes(track.kind) && (!request.trackIds || request.trackIds.includes(track.id))); const warnings: string[] = []; for (let index = 0; index < tracks.length; index += 1) { if (this.projects.getJob(jobId)?.status === 'cancelled') throw new Error('Export cancelled.'); const path = join(destination, `${String(index + 1).padStart(2, '0')} ${safeName(tracks[index].name)}.wav`); const rendered = await this.audio.render(project, path, request.startTick, request.endTick, [tracks[index].id], { stem: true }); warnings.push(...rendered.warnings); this.projects.upsertJob({ ...this.projects.getJob(jobId)!, progress: 0.05 + 0.9 * (index + 1) / Math.max(1, tracks.length), message: `Rendered stem ${index + 1}/${tracks.length}`, updatedAt: nowIso() }); } return { destination, warnings }; }
  private async sfx(project: AIMuseProject, request: ExportRequest, jobId: Id): Promise<ExportReport> {
    const destination = resolve(request.destination); await mkdir(destination, { recursive: true }); const deliverables = Object.values(project.sfxDeliverables); if (!deliverables.length) throw new Error('Project has no SFX deliverables to export.');
    const warnings: string[] = []; const files = new Set<string>(); const manifest: Array<Record<string, unknown>> = []; let done = 0; const total = deliverables.reduce((sum, value) => sum + value.variantCount, 0);
    for (const deliverable of deliverables) {
      if (deliverable.exportFormat !== 'wav') { warnings.push(`${deliverable.name}: ${deliverable.exportFormat.toUpperCase()} requires the native codec service.`); continue; }
      for (let index = 1; index <= deliverable.variantCount; index += 1) {
        if (this.projects.getJob(jobId)?.status === 'cancelled') throw new Error('Export cancelled.');
        const filename = deliverable.namingTemplate.replaceAll('{project}', safeName(project.name)).replaceAll('{name}', safeName(deliverable.name)).replaceAll('{index}', String(index).padStart(2, '0')).replaceAll('{tags}', safeName(deliverable.tags.join('-'))); const path = join(destination, `${safeName(filename)}.wav`);
        const key = process.platform === 'win32' ? path.toLowerCase() : path; if (files.has(key)) throw new Error(`SFX naming template creates a duplicate destination: ${path}`); files.add(key); if (!request.overwrite && await exists(path)) throw new Error(`SFX destination exists: ${path}`);
        const tempo = project.tempoEvents[project.tempoOrder[0]].bpm; const tailTicks = deliverable.seamlessLoop ? 0 : Math.round(deliverable.tailMilliseconds / 1_000 * tempo / 60 * project.settings.ppq);
        const rendered = await this.audio.render(project, path, deliverable.startTick, deliverable.endTick + tailTicks); warnings.push(...rendered.warnings); const variation = await applySfxVariation(path, deliverable, index); await normalizeLufs(path, deliverable.targetLufs);
        const finalPcm = decodeWav(await readFile(path));
        const seamJump = Math.max(...finalPcm.data.map((channel) => Math.abs(channel[0] - channel[channel.length - 1])));
        if (deliverable.seamlessLoop && seamJump > 1e-6) throw new Error(`${deliverable.name} variant ${index}: final PCM failed loop-boundary verification.`);
        manifest.push({ deliverableId: deliverable.id, name: deliverable.name, file: `${safeName(filename)}.wav`, variant: index, tags: deliverable.tags, seamlessLoop: deliverable.seamlessLoop && seamJump <= 1e-6, loopVerification: deliverable.seamlessLoop ? { method: '10 ms cosine boundary fades after variation; final PCM boundary check', seamJump, threshold: 1e-6 } : undefined, loopStartSample: deliverable.seamlessLoop ? 0 : undefined, loopEndSample: deliverable.seamlessLoop ? variation.frames : undefined, targetLufs: deliverable.targetLufs, variation });
        done += 1; this.projects.upsertJob({ ...this.projects.getJob(jobId)!, progress: 0.05 + 0.9 * done / Math.max(1, total), message: `Rendered SFX ${done}/${total}`, updatedAt: nowIso() });
      }
    }
    if (!manifest.length) throw new Error(`No SFX files rendered. ${warnings.join(' ')}`);
    await atomicWriteFile(join(destination, 'sfx-export.json'), `${JSON.stringify({ format: 'AIMuse SFX export', version: 1, projectId: project.id, generatedAt: nowIso(), files: manifest, warnings }, null, 2)}\n`);
    return { destination, warnings };
  }
  private async pack(project: AIMuseProject, request: ExportRequest, actor: Actor): Promise<ExportReport> { if (!project.projectPath) throw new Error('Save the working project before creating a portable pack.'); if (project.dirty) await this.projects.save(project.id, undefined, actor); const destination = await packProjectFolder(project.projectPath, request.destination); return { destination, warnings: [] }; }
}
