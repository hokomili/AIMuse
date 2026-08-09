import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [statePath, projectId, outputRoot] = process.argv.slice(2);
if (!statePath || !projectId || !outputRoot) {
  throw new Error('Usage: node scripts/compose-glass-horizon.mjs <mcp-state.json> <project-id> <output-root>');
}

const session = JSON.parse(await readFile(statePath, 'utf8'));
let requestId = 10_000;

function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const events = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!events.length) throw new Error(`Unrecognized MCP response: ${trimmed.slice(0, 240)}`);
  return JSON.parse(events.at(-1));
}

async function rpc(method, params = {}) {
  const response = await fetch(session.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': session.sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = parseRpcPayload(await response.text());
  if (!response.ok || payload.error) throw new Error(JSON.stringify(payload.error ?? payload));
  return payload.result;
}

async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  return text ? JSON.parse(text) : result;
}

function id(prefix) { return `${prefix}_${randomUUID()}`; }

const initial = await tool('project_observe', { projectId, includeEditor: false, assetIds: [] });
const project = initial.project;
if (!project || project.name !== 'Glass Horizon') throw new Error('The isolated Glass Horizon project is not active.');
const actorId = project.createdBy.id;
const timestamp = new Date().toISOString();
const base = (prefix) => ({ id: id(prefix), revision: 0, createdAt: timestamp, updatedAt: timestamp, createdBy: actorId, updatedBy: actorId });

const PPQ = 960;
const BEAT = PPQ;
const BAR = 4 * BEAT;
const BARS = 40;
const END_TICK = BARS * BAR;
const master = Object.values(project.tracks).find((track) => track.kind === 'master');
const padTrack = Object.values(project.tracks).find((track) => track.kind === 'instrument');
if (!master || !padTrack) throw new Error('Expected AIMuse to create one instrument track and one master track.');

function makeTrack(name, color, gainDb, pan = 0) {
  return {
    ...base('track'), kind: 'instrument', name, color,
    clipIds: [], deviceIds: [], automationLaneIds: [], childTrackIds: [],
    gainDb, pan, mute: false, solo: false, armed: false, frozen: false, collapsed: false,
    routing: { outputTrackId: master.id, monitor: 'auto' },
  };
}

function makeNote(startTick, durationTicks, pitch, velocity, channel = 0) {
  return {
    ...base('note'), startTick: Math.round(startTick), durationTicks: Math.max(1, Math.round(durationTicks)),
    pitch: Math.max(0, Math.min(127, Math.round(pitch))), velocity: Math.max(0, Math.min(1, velocity)),
    releaseVelocity: 0.45, channel, probability: 1,
  };
}

function makeClip(track, name, notes, color = track.color) {
  const noteMap = Object.fromEntries(notes.map((note) => [note.id, note]));
  return {
    ...base('clip'), kind: 'midi', trackId: track.id, name, color,
    startTick: 0, durationTicks: END_TICK, muted: false, gainDb: 0,
    fadeIn: { durationTicks: 0, curve: 'equal-power' }, fadeOut: { durationTicks: 0, curve: 'equal-power' },
    loopEnabled: false, notes: noteMap, noteOrder: notes.map((note) => note.id),
    controls: {}, controlOrder: [], pitchBends: {}, pitchBendOrder: [],
  };
}

function parameter(idValue, name, value, min, max, unit) {
  return { id: idValue, name, value, defaultValue: value, min, max, ...(unit ? { unit } : {}), automatable: true };
}

function device(trackId, builtinKind, name, parameters, presetName) {
  return {
    ...base('device'), trackId, format: 'builtin', builtinKind, name,
    bypassed: false, degraded: false, latencySamples: 0,
    ...(presetName ? { presetName } : {}),
    parameters: Object.fromEntries(parameters.map((entry) => [entry.id, entry])),
  };
}

function synth(trackId, presetName, cutoff, resonance, attack, release) {
  return device(trackId, 'subtractive-synth', 'Muse Synth', [
    parameter('cutoff', 'Cutoff', cutoff, 20, 20_000, 'Hz'),
    parameter('resonance', 'Resonance', resonance, 0, 1),
    parameter('attack', 'Attack', attack, 0, 5, 's'),
    parameter('release', 'Release', release, 0, 10, 's'),
  ], presetName);
}

function effect(trackId, kind, name, parameters) {
  return device(trackId, kind, name, parameters);
}

const tracks = {
  pad: { ...padTrack, name: 'Horizon Pad', color: '#4F8CFF', gainDb: -8, pan: -0.22 },
  arp: makeTrack('Tidal Arpeggio', '#22C7B8', -10, 0.42),
  bass: makeTrack('Deep Current Bass', '#F5A950', -2, 0),
  lead: makeTrack('Prismatic Lead', '#B18CFF', -7, 0.12),
  counter: makeTrack('Counterlight', '#68C77A', -11, -0.42),
  kick: makeTrack('Pulse Kick', '#EF6F91', -1, 0),
  snare: makeTrack('Echo Snare', '#F27F4F', -7, 0.08),
  hats: makeTrack('Starfield Hats', '#D8DE52', -14, 0.38),
};

const chords = {
  Dm: { root: 38, pad: [50, 57, 62], arp: [62, 65, 69, 74] },
  Bb: { root: 34, pad: [46, 53, 58], arp: [58, 62, 65, 70] },
  F:  { root: 41, pad: [53, 60, 65], arp: [65, 69, 72, 77] },
  C:  { root: 36, pad: [48, 55, 60], arp: [60, 64, 67, 72] },
  Gm: { root: 43, pad: [55, 62, 67], arp: [67, 70, 74, 79] },
  A:  { root: 45, pad: [57, 64, 69, 73], arp: [69, 73, 76, 81] },
};

const progressionNames = [
  'Dm', 'Bb', 'F', 'C',
  'Dm', 'Bb', 'F', 'C', 'Gm', 'Bb', 'Dm', 'A',
  'Dm', 'Bb', 'F', 'C', 'Dm', 'C', 'Bb', 'A', 'Gm', 'Dm', 'Bb', 'A',
  'Dm', 'Bb', 'F', 'C', 'Gm', 'Bb', 'Dm', 'A', 'Dm', 'A',
  'Dm', 'Bb', 'F', 'C', 'Dm', 'Dm',
];
const progression = progressionNames.map((name) => chords[name]);

const padNotes = [];
for (let bar = 0; bar < BARS; bar += 1) {
  const chord = progression[bar];
  const velocity = bar < 4 ? 0.25 : bar < 12 ? 0.34 : bar < 24 ? 0.43 : bar < 34 ? 0.56 : 0.30;
  for (const pitch of chord.pad) padNotes.push(makeNote(bar * BAR, BAR - 100, pitch, velocity));
  if (bar >= 24 && bar < 34) padNotes.push(makeNote(bar * BAR, BAR - 120, chord.arp[3] + 12, 0.20));
}

const arpNotes = [];
const arpPattern = [0, 1, 2, 1, 3, 2, 1, 2];
for (let bar = 4; bar < 34; bar += 1) {
  const chord = progression[bar];
  const octave = bar >= 24 ? 12 : 0;
  const energy = bar < 12 ? 0.34 : bar < 24 ? 0.46 : 0.61;
  for (let step = 0; step < 8; step += 1) {
    arpNotes.push(makeNote(bar * BAR + step * (BEAT / 2), 350, chord.arp[arpPattern[step]] + octave, energy + (step % 2 ? -0.06 : 0.04)));
  }
}
for (let bar = 34; bar < 38; bar += 1) {
  const chord = progression[bar];
  for (let step = 0; step < 4; step += 1) arpNotes.push(makeNote(bar * BAR + step * BEAT, 720, chord.arp[step], 0.28));
}

const bassNotes = [];
for (let bar = 4; bar < 34; bar += 1) {
  const root = progression[bar].root;
  if (bar < 12) {
    bassNotes.push(makeNote(bar * BAR, 1.7 * BEAT, root, 0.58));
    bassNotes.push(makeNote(bar * BAR + 2 * BEAT, 1.55 * BEAT, root + (bar % 2 ? 7 : 0), 0.52));
  } else if (bar < 24) {
    for (let beat = 0; beat < 4; beat += 1) bassNotes.push(makeNote(bar * BAR + beat * BEAT, 760, root + (beat === 3 ? 7 : 0), 0.64 + (beat === 0 ? 0.08 : 0)));
  } else {
    for (let step = 0; step < 8; step += 1) {
      const pitch = step === 7 ? progression[Math.min(BARS - 1, bar + 1)].root : root + (step === 5 ? 7 : 0);
      bassNotes.push(makeNote(bar * BAR + step * (BEAT / 2), 370, pitch, 0.68 + (step % 2 ? -0.08 : 0.06)));
    }
  }
}
for (let bar = 34; bar < BARS; bar += 1) bassNotes.push(makeNote(bar * BAR, BAR - 120, progression[bar].root, bar === 39 ? 0.36 : 0.48));

const leadNotes = [];
const theme = [
  [0, 1.5, 74], [1.5, 0.5, 77], [2, 1, 81], [3, 1, 79],
  [4, 1, 77], [5, 1, 74], [6, 2, 72],
  [8, 1, 69], [9, 1, 72], [10, 1, 74], [11, 1, 77],
  [12, 1, 76], [13, 0.5, 74], [13.5, 0.5, 72], [14, 2, 69],
];
function addTheme(startBar, transpose, velocity) {
  for (const [beatOffset, beatDuration, pitch] of theme) {
    leadNotes.push(makeNote(startBar * BAR + beatOffset * BEAT, beatDuration * BEAT - 70, pitch + transpose, velocity + ((beatOffset * 2) % 2 ? -0.05 : 0.03)));
  }
}
addTheme(8, 0, 0.62);
addTheme(16, 0, 0.69);
addTheme(24, 12, 0.78);
const resolution = [
  [34, 0, 2, 74], [34, 2, 2, 69], [35, 0, 2, 70], [35, 2, 2, 65],
  [36, 0, 2, 69], [36, 2, 2, 72], [37, 0, 2, 67], [37, 2, 2, 64],
  [38, 0, 1, 65], [38, 1, 1, 69], [38, 2, 2, 74], [39, 0, 4, 74],
];
for (const [bar, beat, duration, pitch] of resolution) leadNotes.push(makeNote(bar * BAR + beat * BEAT, duration * BEAT - 100, pitch, bar === 39 ? 0.38 : 0.52));

const counterNotes = [];
for (let bar = 12; bar < 34; bar += 1) {
  const chord = progression[bar];
  const pitch = chord.arp[(bar + 1) % 3] - (bar < 24 ? 0 : 12);
  counterNotes.push(makeNote(bar * BAR, 1.8 * BEAT, pitch, bar < 24 ? 0.31 : 0.42));
  counterNotes.push(makeNote(bar * BAR + 2 * BEAT, 1.75 * BEAT, chord.arp[(bar + 2) % 4], bar < 24 ? 0.28 : 0.39));
}

const kickNotes = [];
for (let bar = 8; bar < 34; bar += 1) {
  const steps = bar < 16 ? [0, 2] : bar < 24 ? [0, 1.5, 2, 3.5] : [0, 1, 2, 3];
  for (const beat of steps) {
    const velocity = beat === 0 ? 0.98 : 0.78;
    kickNotes.push(makeNote(bar * BAR + beat * BEAT, 170, 36, velocity));
    if (bar >= 24) kickNotes.push(makeNote(bar * BAR + beat * BEAT, 120, 48, velocity * 0.42));
  }
}
kickNotes.push(makeNote(34 * BAR, 240, 36, 0.82));
kickNotes.push(makeNote(38 * BAR, 240, 36, 0.68));

const snareNotes = [];
for (let bar = 8; bar < 34; bar += 1) {
  for (const beat of [1, 3]) {
    const at = bar * BAR + beat * BEAT;
    snareNotes.push(makeNote(at, 120, 76, 0.66));
    snareNotes.push(makeNote(at + 18, 90, 83, 0.38));
    if (bar >= 24) snareNotes.push(makeNote(at + 36, 70, 90, 0.25));
  }
  if (bar >= 20 && bar % 2 === 1) snareNotes.push(makeNote(bar * BAR + 3.75 * BEAT, 75, 79, 0.28));
}

const hatNotes = [];
for (let bar = 8; bar < 34; bar += 1) {
  const divisions = bar < 24 ? 8 : 16;
  for (let step = 0; step < divisions; step += 1) {
    const interval = BAR / divisions;
    const velocity = divisions === 8 ? (step % 2 ? 0.30 : 0.45) : (step % 4 === 0 ? 0.52 : step % 2 ? 0.22 : 0.35);
    hatNotes.push(makeNote(bar * BAR + step * interval, divisions === 8 ? 70 : 45, step % 4 === 3 ? 111 : 104, velocity));
  }
}
for (let bar = 34; bar < 38; bar += 1) {
  for (let step = 0; step < 4; step += 1) hatNotes.push(makeNote(bar * BAR + step * BEAT, 65, 104, 0.22));
}

const clips = {
  pad: makeClip(tracks.pad, 'Glass Horizon — harmonic bed', padNotes),
  arp: makeClip(tracks.arp, 'Tidal eighth-note lattice', arpNotes),
  bass: makeClip(tracks.bass, 'Deep current movement', bassNotes),
  lead: makeClip(tracks.lead, 'Prismatic main theme', leadNotes),
  counter: makeClip(tracks.counter, 'Counterlight response', counterNotes),
  kick: makeClip(tracks.kick, 'Pulse kick arc', kickNotes),
  snare: makeClip(tracks.snare, 'Echo snare arc', snareNotes),
  hats: makeClip(tracks.hats, 'Starfield rhythm', hatNotes),
};

const operations = [
  { kind: 'project.settings.update', changes: { masterLufsTarget: -14, metronomeEnabled: false } },
  { kind: 'track.update', trackId: padTrack.id, changes: { name: tracks.pad.name, color: tracks.pad.color, gainDb: tracks.pad.gainDb, pan: tracks.pad.pan } },
  ...Object.values(tracks).filter((track) => track.id !== padTrack.id).map((track, index) => ({ kind: 'track.add', track, index: index + 1 })),
];

const sectionSpecs = [
  ['Dawn Through Glass', 0, 4, '#345A93', 0.20, 'Sparse suspended harmony; establish distance and wonder.'],
  ['First Light', 4, 12, '#2A9D8F', 0.42, 'Arpeggio and bass emerge; introduce the theme.'],
  ['Forward Motion', 12, 24, '#E9A23B', 0.66, 'Rhythmic drive and counterline broaden the cue.'],
  ['The Glass Horizon', 24, 34, '#B56BDE', 0.95, 'Full cinematic-electronic climax with octave theme.'],
  ['Afterglow', 34, 40, '#6687A8', 0.28, 'Release percussion, slow the motion, and resolve on D.'],
];
for (const [name, startBar, endBar, color, energy, prompt] of sectionSpecs) {
  operations.push({ kind: 'section.add', section: { ...base('section'), name, startTick: startBar * BAR, endTick: endBar * BAR, color, energy, prompt } });
  operations.push({ kind: 'marker.add', marker: { ...base('marker'), tick: startBar * BAR, name, color, kind: 'cue' } });
}

const deviceChains = new Map([
  [tracks.pad.id, [
    synth(tracks.pad.id, 'Slow Blue Horizon', 3_200, 0.22, 1.2, 2.8),
    effect(tracks.pad.id, 'chorus', 'Wide Chorus', [parameter('rate', 'Rate', 0.35, 0.01, 10, 'Hz'), parameter('depth', 'Depth', 0.58, 0, 1), parameter('mix', 'Mix', 0.38, 0, 1)]),
    effect(tracks.pad.id, 'reverb', 'Long Glass Reverb', [parameter('size', 'Size', 0.82, 0, 1), parameter('decay', 'Decay', 5.4, 0.1, 20, 's'), parameter('mix', 'Mix', 0.34, 0, 1)]),
  ]],
  [tracks.arp.id, [
    synth(tracks.arp.id, 'Tidal Pluck', 8_500, 0.34, 0.005, 0.22),
    effect(tracks.arp.id, 'delay', 'Dotted Reflection', [parameter('time', 'Time', 0.409, 0.001, 2, 's'), parameter('feedback', 'Feedback', 0.36, 0, 0.98), parameter('mix', 'Mix', 0.27, 0, 1)]),
  ]],
  [tracks.bass.id, [synth(tracks.bass.id, 'Deep Current', 720, 0.18, 0.008, 0.18)]],
  [tracks.lead.id, [
    synth(tracks.lead.id, 'Prismatic Voice', 6_200, 0.28, 0.018, 0.65),
    effect(tracks.lead.id, 'delay', 'Theme Echo', [parameter('time', 'Time', 0.273, 0.001, 2, 's'), parameter('feedback', 'Feedback', 0.30, 0, 0.98), parameter('mix', 'Mix', 0.22, 0, 1)]),
  ]],
  [tracks.counter.id, [synth(tracks.counter.id, 'Counterlight Reed', 4_800, 0.20, 0.08, 0.75)]],
  [tracks.kick.id, [device(tracks.kick.id, 'drum-rack', 'Pulse Drum Rack', [parameter('gain', 'Gain', 0, -48, 12, 'dB'), parameter('choke', 'Choke', 0, 0, 1)], 'Low Pulse Kit')]],
  [tracks.snare.id, [device(tracks.snare.id, 'drum-rack', 'Echo Drum Rack', [parameter('gain', 'Gain', -2, -48, 12, 'dB'), parameter('choke', 'Choke', 0, 0, 1)], 'Glass Snap Kit')]],
  [tracks.hats.id, [device(tracks.hats.id, 'drum-rack', 'Starfield Drum Rack', [parameter('gain', 'Gain', -5, -48, 12, 'dB'), parameter('choke', 'Choke', 1, 0, 1)], 'Shimmer Kit')]],
]);

for (const track of Object.values(tracks)) {
  for (const entry of deviceChains.get(track.id) ?? []) operations.push({ kind: 'device.add', device: entry });
  const key = Object.entries(tracks).find(([, value]) => value.id === track.id)?.[0];
  operations.push({ kind: 'clip.add', clip: clips[key] });
}

for (const entry of [
  effect(master.id, 'compressor', 'Master Glue', [
    parameter('threshold', 'Threshold', -16, -60, 0, 'dB'), parameter('ratio', 'Ratio', 2.5, 1, 20),
    parameter('attack', 'Attack', 0.025, 0.0001, 1, 's'), parameter('release', 'Release', 0.18, 0.01, 3, 's'),
  ]),
  effect(master.id, 'limiter', 'Master Limiter', [parameter('ceiling', 'Ceiling', -1, -12, 0, 'dB'), parameter('release', 'Release', 0.10, 0.001, 1, 's')]),
  effect(master.id, 'analyzer', 'Spectrum & Loudness', []),
]) operations.push({ kind: 'device.add', device: entry });

const applied = await tool('project_apply', {
  projectId,
  clientOperationId: `compose-glass-horizon-${randomUUID()}`,
  label: 'Compose Glass Horizon — complete original 40-bar soundtrack',
  operations,
  commitMode: 'checkpointed',
});
if (applied.status !== 'committed') throw new Error(`Composition was not committed: ${JSON.stringify(applied)}`);

const observed = await tool('project_observe', { projectId, includeEditor: false, assetIds: [] });
const composed = observed.project;
const noteCount = Object.values(composed.clips).reduce((sum, clip) => sum + (clip.kind === 'midi' ? clip.noteOrder.length : 0), 0);
if (Object.keys(composed.clips).length !== 8 || noteCount < 900) throw new Error(`Unexpected composition size: ${Object.keys(composed.clips).length} clips, ${noteCount} notes.`);

const projectDestination = `${outputRoot}\\Glass-Horizon`;
const saved = await tool('project_manage', { action: 'save', projectId, path: projectDestination });
if (saved.jobId || saved.error) throw new Error(`Project save needs attention: ${JSON.stringify(saved)}`);

async function exportAndWait(kind, destination, extra = {}) {
  const started = await tool('export_manage', { projectId, kind, destination, ...extra, overwrite: false });
  if (!started.jobId) throw new Error(`${kind} export did not start: ${JSON.stringify(started)}`);
  let job;
  do {
    job = await tool('job_manage', { action: 'wait', jobId: started.jobId, timeoutMs: 30_000 });
  } while (!['completed', 'failed', 'cancelled', 'waiting-for-user'].includes(job.status));
  if (job.status !== 'completed') throw new Error(`${kind} export failed or blocked: ${JSON.stringify(job)}`);
  return job;
}

const masterJob = await exportAndWait('master', `${outputRoot}\\Glass Horizon`, { format: 'wav', startTick: 0, endTick: END_TICK });
const midiJob = await exportAndWait('midi', `${outputRoot}\\Glass Horizon Score`, { startTick: 0, endTick: END_TICK });

console.log(JSON.stringify({
  projectId,
  revision: composed.revision,
  bars: BARS,
  endTick: END_TICK,
  tracks: Object.keys(composed.tracks).length,
  clips: Object.keys(composed.clips).length,
  notes: noteCount,
  sections: composed.sectionOrder.map((sectionId) => composed.sections[sectionId].name),
  projectPath: saved.projectPath,
  master: masterJob.result?.destination,
  midi: midiJob.result?.destination,
}, null, 2));
