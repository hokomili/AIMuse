import type { AIMuseProject, Actor, EntityBase, Id } from './model';

export function isDeclaredId(value: unknown): value is Id {
  return typeof value === 'string' && value.length >= 1 && value.length <= 240;
}

export function isDeclaredIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}

export function declaredActorError(actor: Actor | null | undefined, label: string): string | undefined {
  if (!actor || typeof actor !== 'object' || !isDeclaredId(actor.id)) return `${label} has an invalid ID.`;
  if (!['human', 'agent', 'system'].includes(actor.kind)) return `${label} ${actor.id} has an invalid kind.`;
  if (typeof actor.name !== 'string' || actor.name.length < 1 || actor.name.length > 100) return `${label} ${actor.id} has an invalid name.`;
  if (typeof actor.color !== 'string' || actor.color.length < 1 || actor.color.length > 40) return `${label} ${actor.id} has an invalid color.`;
  if (actor.client !== undefined) {
    if (!actor.client || typeof actor.client !== 'object' || Array.isArray(actor.client)) return `${label} ${actor.id} has invalid client metadata.`;
    const metadata = actor.client as Record<string, unknown>;
    const limits: Array<[string, number]> = [['product', 100], ['model', 160], ['effort', 80], ['taskId', 240], ['version', 80]];
    for (const [key, maximum] of limits) {
      const value = metadata[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > maximum)) return `${label} ${actor.id} has invalid client metadata.`;
    }
  }
  return undefined;
}

export function declaredProjectRootError(project: AIMuseProject | null | undefined): string | undefined {
  if (!project || typeof project !== 'object' || !isDeclaredId(project.id)) return 'Project has an invalid ID.';
  if (!Number.isInteger(project.revision) || project.revision < 0) return `Project ${project.id} has an invalid revision.`;
  if (!isDeclaredIsoTimestamp(project.createdAt)) return `Project ${project.id} has an invalid creation timestamp.`;
  if (!isDeclaredIsoTimestamp(project.updatedAt)) return `Project ${project.id} has an invalid update timestamp.`;
  const actorError = declaredActorError(project.createdBy, 'Project creator');
  if (actorError) return actorError;
  if (typeof project.dirty !== 'boolean') return `Project ${project.id} has an invalid dirty value.`;
  if (project.projectPath !== undefined && (typeof project.projectPath !== 'string' || project.projectPath.length > 32_000)) return `Project ${project.id} has an invalid project path.`;
  return undefined;
}

export function declaredEntityBaseError(entity: EntityBase | null | undefined, label: string): string | undefined {
  if (!entity || typeof entity !== 'object' || !isDeclaredId(entity.id)) return `${label} has an invalid entity ID.`;
  if (!Number.isInteger(entity.revision) || entity.revision < 0) return `${label} ${entity.id} has an invalid entity revision.`;
  if (!isDeclaredIsoTimestamp(entity.createdAt)) return `${label} ${entity.id} has an invalid creation timestamp.`;
  if (!isDeclaredIsoTimestamp(entity.updatedAt)) return `${label} ${entity.id} has an invalid update timestamp.`;
  if (!isDeclaredId(entity.createdBy)) return `${label} ${entity.id} has an invalid creator ID.`;
  if (!isDeclaredId(entity.updatedBy)) return `${label} ${entity.id} has an invalid updater ID.`;
  return undefined;
}
