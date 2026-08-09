import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectKind, ProjectTransaction } from '@aimuse/core';
import type { NewProjectOptions, WorkspaceEvent, WorkspaceSnapshot } from '../common/contracts';
import { rebaseUiTransaction } from './editor-helpers';

export interface WorkspaceController {
  snapshot?: WorkspaceSnapshot;
  loading: boolean;
  error?: string;
  toast?: { id: number; tone: 'normal' | 'success' | 'warning'; message: string };
  refresh(): Promise<void>;
  createProject(kind: ProjectKind, name?: string): Promise<void>;
  apply(transaction: ProjectTransaction): Promise<boolean>;
  notify(message: string, tone?: 'normal' | 'success' | 'warning'): void;
}

export function useWorkspace(): WorkspaceController {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<WorkspaceController['toast']>();
  const toastId = useRef(0);
  const applyTail = useRef<Promise<void>>(Promise.resolve());

  const publishSnapshot = useCallback((next: WorkspaceSnapshot | ((current?: WorkspaceSnapshot) => WorkspaceSnapshot | undefined)) => {
    setSnapshot((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      return value;
    });
  }, []);

  const notify = useCallback((message: string, tone: 'normal' | 'success' | 'warning' = 'normal') => {
    const id = ++toastId.current;
    setToast({ id, tone, message });
    window.setTimeout(() => setToast((current) => current?.id === id ? undefined : current), 3_800);
  }, []);

  const refresh = useCallback(async () => {
    try {
      publishSnapshot(await window.aimuse.bootstrap());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [publishSnapshot]);

  useEffect(() => {
    void refresh();
    const removeEvent = window.aimuse.onEvent((event: WorkspaceEvent) => {
      if (event.type === 'workspace') publishSnapshot(event.snapshot);
      else if (event.type === 'transport') publishSnapshot((current) => current ? { ...current, transport: event.state } : current);
      else if (event.type === 'job') {
        publishSnapshot((current) => current ? {
          ...current,
          jobs: [...current.jobs.filter((job) => job.id !== event.job.id), event.job],
        } : current);
      }
    });
    const removeNewProject = window.aimuse.onNewProjectRequested((kind) => {
      void createProjectInternal(kind ?? 'song');
    });
    return () => { removeEvent(); removeNewProject(); };
  // The preload listeners should be installed exactly once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createProjectInternal = useCallback(async (kind: ProjectKind, name?: string) => {
    const options: NewProjectOptions = { kind, name, sampleRate: 48_000, bpm: kind === 'song' ? 120 : 100 };
    try {
      publishSnapshot(await window.aimuse.newProject(options));
      notify(`${kind === 'song' ? 'Song' : 'SFX project'} created`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'warning');
    }
  }, [notify, publishSnapshot]);

  const apply = useCallback(async (transaction: ProjectTransaction) => {
    const run = applyTail.current.then(async () => {
      try {
        // IPC responses and workspace events travel independently. Observe once
        // at the head of the local queue so a fast second gesture cannot reuse
        // the first gesture's stale expectedRevision value.
        const latest = await window.aimuse.bootstrap();
        publishSnapshot(latest);
        const project = latest.activeProject?.id === transaction.projectId ? latest.activeProject : undefined;
        const result = await window.aimuse.applyTransaction(project ? rebaseUiTransaction(transaction, project) : transaction);
        if (result.status !== 'committed' && result.status !== 'duplicate') {
          notify(result.message ?? `Edit was not committed (${result.status}).`, 'warning');
          return false;
        }
        return true;
      } catch (cause) {
        notify(cause instanceof Error ? cause.message : String(cause), 'warning');
        return false;
      }
    });
    applyTail.current = run.then(() => undefined, () => undefined);
    return run;
  }, [notify, publishSnapshot]);

  return { snapshot, loading, error, toast, refresh, createProject: createProjectInternal, apply, notify };
}
