import type { AIMuseProject, TempoEvent } from './model';

export function sortedTempoEvents(project: Pick<AIMuseProject, 'tempoEvents' | 'tempoOrder'>): TempoEvent[] {
  return project.tempoOrder.map((id) => project.tempoEvents[id]).filter(Boolean).sort((a, b) => a.tick - b.tick);
}

export function ticksToSeconds(project: Pick<AIMuseProject, 'settings' | 'tempoEvents' | 'tempoOrder'>, ticks: number): number {
  if (ticks <= 0) return 0;
  const events = sortedTempoEvents(project);
  let seconds = 0;
  let cursor = 0;
  let bpm = events[0]?.bpm ?? 120;
  for (const event of events) {
    if (event.tick <= 0) { bpm = event.bpm; continue; }
    if (event.tick >= ticks) break;
    seconds += ((event.tick - cursor) / project.settings.ppq) * (60 / bpm);
    cursor = event.tick;
    bpm = event.bpm;
  }
  return seconds + ((ticks - cursor) / project.settings.ppq) * (60 / bpm);
}

export function ticksToSamples(project: Pick<AIMuseProject, 'settings' | 'tempoEvents' | 'tempoOrder'>, ticks: number): number {
  return Math.round(ticksToSeconds(project, ticks) * project.settings.sampleRate);
}

export function secondsToTicks(project: Pick<AIMuseProject, 'settings' | 'tempoEvents' | 'tempoOrder'>, seconds: number): number {
  if (seconds <= 0) return 0;
  const events = sortedTempoEvents(project);
  let remaining = seconds;
  let cursorTick = 0;
  let bpm = events[0]?.bpm ?? 120;
  for (const event of events) {
    if (event.tick <= 0) { bpm = event.bpm; continue; }
    const spanSeconds = ((event.tick - cursorTick) / project.settings.ppq) * (60 / bpm);
    if (remaining <= spanSeconds) return Math.round(cursorTick + remaining * bpm * project.settings.ppq / 60);
    remaining -= spanSeconds;
    cursorTick = event.tick;
    bpm = event.bpm;
  }
  return Math.round(cursorTick + remaining * bpm * project.settings.ppq / 60);
}

export function samplesToTicks(project: Pick<AIMuseProject, 'settings' | 'tempoEvents' | 'tempoOrder'>, samples: number): number {
  return secondsToTicks(project, samples / project.settings.sampleRate);
}
