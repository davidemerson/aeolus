import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { Button, ConfirmInline, toastStore } from '@aeolus/shared/ui';

import { api, ApiRequestError } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';

interface Checkpoint {
  id: string;
  label: string;
  // 'user' = explicit user-named checkpoint; 'auto_open' = system-
  // captured snapshot fired when someone opened the file (subject
  // to per-user-per-file 5-min coalescing and 30-day retention
  // server-side). Auto rows render with subdued styling so the
  // user-named ones stay prominent.
  kind?: 'user' | 'auto_open';
  file_path?: string;
  created_by: string | null;
  created_by_email?: string | null;
  created_at: string;
}

interface ProjectCheckpoint {
  id: string;
  label: string;
  file_count: number;
  created_by: string | null;
  created_at: string;
}

interface HistoryPanelProps {
  docId: string;
  canWrite: boolean;
  // Currently-open file (or null for the project's main entrypoint).
  // When set, checkpoints scope to this file: list reads its
  // checkpoints, create writes against it. Per-file checkpoints
  // (issue #9 follow-up).
  currentFile: { id: string; path: string } | null;
  onPreview: (checkpointId: string, label: string, downloadUrl: string) => void;
}

interface CheckpointCardProps {
  // testid for the <li> wrapper. File rows use 'history-item';
  // project-snapshot rows use 'project-checkpoint-item'.
  testId: string;
  // Extra data-* attributes on the <li>. Currently used to carry
  // `data-kind` for file-checkpoint rows.
  dataAttrs?: Record<string, string>;
  label: string;
  // Pre-formatted single-line meta — date for file rows, "N files ·
  // date" for project rows.
  meta: string;
  // 'auto' subdues the label (italic + lighter colour) so user-named
  // checkpoints stay prominent. File rows pick this for kind=auto_open.
  variant?: 'default' | 'auto';
  // When set, the card's title+meta become a single click-to-preview
  // button with the historical `history-item-btn` testid (file rows).
  // Project rows leave this undefined.
  onPreview?: () => void;
  // Action row rendered below the title+meta. Project rows pass
  // Restore + Delete buttons (with their own per-id testids); file
  // rows omit this. `false` (from `canWrite && (...)`) renders nothing.
  actions?: ReactNode | false;
}

// Shared card layout for both project-snapshot rows and per-file
// checkpoint rows. The two lists used to maintain near-identical
// markup separately; consolidating here makes divergent maintenance
// (e.g. the "Show auto" toggle on file rows but not project rows)
// less likely to silently re-fork.
function CheckpointCard({
  testId,
  dataAttrs,
  label,
  meta,
  variant = 'default',
  onPreview,
  actions,
}: CheckpointCardProps): JSX.Element {
  const labelClass =
    variant === 'auto'
      ? 'truncate text-xs italic text-muted'
      : 'truncate text-xs font-medium text-body-2';
  const inner = (
    <>
      <div className={labelClass}>{label}</div>
      <div className="text-[10px] text-muted">{meta}</div>
    </>
  );
  return (
    <li data-testid={testId} {...dataAttrs} className="border-b border-hairline px-3 py-2">
      {onPreview ? (
        <button
          type="button"
          className="w-full text-left"
          onClick={onPreview}
          data-testid="history-item-btn"
        >
          {inner}
        </button>
      ) : (
        inner
      )}
      {actions && <div className="mt-1 flex gap-2">{actions}</div>}
    </li>
  );
}

export function HistoryPanel({ docId, canWrite, currentFile, onPreview }: HistoryPanelProps) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [projectCheckpoints, setProjectCheckpoints] = useState<ProjectCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [showForm, setShowForm] = useState<null | 'file' | 'project'>(null);
  // Which project snapshot has its two-step confirm open, and for which
  // action. Restore and delete both confirm inline: restore overwrites
  // every file, delete is irreversible.
  const [confirmAction, setConfirmAction] = useState<{
    id: string;
    action: 'restore' | 'delete';
  } | null>(null);
  // Project snapshot id whose restore/delete request is in flight. Disables
  // every row's actions so a second click cannot start a parallel request.
  const [working, setWorking] = useState<string | null>(null);
  // Hide auto-open checkpoints by default isn't the right call —
  // the whole point of the feature is to show "where someone else
  // was" — but a toggle here lets users de-clutter once the trail
  // gets long.
  const [showAuto, setShowAuto] = useState(true);

  // Build the ?fileId= suffix once. When null, the API defaults to
  // main.{tex,typ} — back-compat with the original UX.
  const fileQuery = currentFile ? `?fileId=${encodeURIComponent(currentFile.id)}` : '';

  const loadCheckpoints = useCallback(async () => {
    try {
      const [files, projects] = await Promise.all([
        api.get<{ checkpoints: Checkpoint[] }>(
          `/docs/${encodeURIComponent(docId)}/checkpoints${fileQuery}`,
        ),
        api.get<{ project_checkpoints: ProjectCheckpoint[] }>(
          `/docs/${encodeURIComponent(docId)}/project-checkpoints`,
        ),
      ]);
      setCheckpoints(files.checkpoints);
      setProjectCheckpoints(projects.project_checkpoints);
    } catch {
      toastStore.push({ kind: 'error', message: 'Failed to load checkpoints' });
    } finally {
      setLoading(false);
    }
  }, [docId, fileQuery]);

  useEffect(() => {
    void loadCheckpoints();
  }, [loadCheckpoints]);

  const createProjectCheckpoint = useCallback(async () => {
    const label = labelInput.trim();
    if (!label) return;
    setCreating(true);
    try {
      await api.post(`/docs/${encodeURIComponent(docId)}/project-checkpoints`, { label });
      toastStore.push({ kind: 'success', message: 'Project snapshot created' });
      setLabelInput('');
      setShowForm(null);
      await loadCheckpoints();
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to create project snapshot',
      });
    } finally {
      setCreating(false);
    }
  }, [docId, labelInput, loadCheckpoints]);

  const restoreProjectCheckpoint = useCallback(
    async (id: string) => {
      setWorking(id);
      try {
        const res = await api.post<{ files_restored: number }>(
          `/docs/${encodeURIComponent(docId)}/project-checkpoints/${encodeURIComponent(id)}/restore`,
          {},
        );
        toastStore.push({
          kind: 'success',
          message: `Restored ${res.files_restored} file${res.files_restored === 1 ? '' : 's'}`,
        });
        setConfirmAction(null);
        await loadCheckpoints();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Restore failed',
        });
      } finally {
        setWorking(null);
      }
    },
    [docId, loadCheckpoints],
  );

  const deleteProjectCheckpoint = useCallback(
    async (id: string) => {
      setWorking(id);
      try {
        await api.delete(
          `/docs/${encodeURIComponent(docId)}/project-checkpoints/${encodeURIComponent(id)}`,
        );
        toastStore.push({ kind: 'success', message: 'Project snapshot deleted' });
        setConfirmAction(null);
        await loadCheckpoints();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Delete failed',
        });
      } finally {
        setWorking(null);
      }
    },
    [docId, loadCheckpoints],
  );

  const createCheckpoint = useCallback(async () => {
    const label = labelInput.trim();
    if (!label) return;
    setCreating(true);
    try {
      await api.post(`/docs/${encodeURIComponent(docId)}/checkpoints${fileQuery}`, { label });
      toastStore.push({ kind: 'success', message: 'Checkpoint created' });
      setLabelInput('');
      setShowForm(null);
      await loadCheckpoints();
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Failed to create checkpoint',
      });
    } finally {
      setCreating(false);
    }
  }, [docId, fileQuery, labelInput, loadCheckpoints]);

  const handlePreview = useCallback(
    async (cp: Checkpoint) => {
      try {
        const res = await api.get<{
          checkpoint: { download_url: string };
        }>(`/docs/${encodeURIComponent(docId)}/checkpoints/${encodeURIComponent(cp.id)}`);
        onPreview(cp.id, cp.label, res.checkpoint.download_url);
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Failed to load checkpoint',
        });
      }
    },
    [docId, onPreview],
  );

  return (
    <div
      data-testid="history-panel"
      className="flex h-full flex-col border-r border-hairline-strong bg-surface"
    >
      <div className="flex items-center justify-between border-b border-hairline-strong px-3 py-2">
        <span
          className="text-xs font-semibold uppercase tracking-wide text-body-2"
          data-testid="history-scope"
          title={currentFile ? `Checkpoints for ${currentFile.path}` : 'Checkpoints for main file'}
        >
          History ·{' '}
          <span className="font-mono lowercase tracking-normal text-muted">
            {currentFile?.path ?? 'main'}
          </span>
        </span>
        {canWrite && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowForm((v) => (v === 'file' ? null : 'file'))}
              data-testid="history-create-toggle"
              title="Checkpoint just this file"
            >
              {showForm === 'file' ? 'Cancel' : 'File'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowForm((v) => (v === 'project' ? null : 'project'))}
              data-testid="history-project-toggle"
              title="Snapshot every text file in the project"
            >
              {showForm === 'project' ? 'Cancel' : 'Project'}
            </Button>
          </div>
        )}
      </div>

      {showForm && canWrite && (
        <div
          className="border-b border-hairline-strong px-3 py-2"
          data-testid="history-create-form"
        >
          <input
            type="text"
            maxLength={120}
            placeholder={showForm === 'project' ? 'Project snapshot label…' : 'Checkpoint label…'}
            aria-label={showForm === 'project' ? 'Project snapshot label' : 'Checkpoint label'}
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (showForm === 'project') {
                void createProjectCheckpoint();
              } else {
                void createCheckpoint();
              }
            }}
            className="mb-2 w-full rounded border border-hairline-strong px-2 py-1 text-xs text-body-2 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
            data-testid="history-label-input"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={creating || !labelInput.trim()}
            onClick={() => {
              if (showForm === 'project') void createProjectCheckpoint();
              else void createCheckpoint();
            }}
            data-testid="history-create-btn"
          >
            {creating
              ? 'Saving…'
              : showForm === 'project'
                ? 'Save project snapshot'
                : 'Save checkpoint'}
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-xs text-muted">Loading…</div>
        ) : (
          <>
            {projectCheckpoints.length > 0 && (
              <div data-testid="project-checkpoints-section">
                <div className="border-b border-hairline-strong bg-page px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  Project snapshots
                </div>
                <ul data-testid="project-checkpoints-list">
                  {projectCheckpoints.map((p) => (
                    <CheckpointCard
                      key={p.id}
                      testId="project-checkpoint-item"
                      label={p.label}
                      meta={`${p.file_count} file${p.file_count === 1 ? '' : 's'} · ${formatDateTime(p.created_at)}`}
                      actions={
                        canWrite &&
                        (confirmAction?.id === p.id ? (
                          <ConfirmInline
                            message={
                              confirmAction.action === 'delete'
                                ? 'Delete this snapshot? This cannot be undone.'
                                : 'Restore every file to this snapshot?'
                            }
                            confirmLabel={
                              confirmAction.action === 'delete'
                                ? working === p.id
                                  ? 'Deleting…'
                                  : 'Delete'
                                : working === p.id
                                  ? 'Restoring…'
                                  : 'Restore all'
                            }
                            destructive={confirmAction.action === 'delete'}
                            pending={working === p.id}
                            onConfirm={() =>
                              void (confirmAction.action === 'delete'
                                ? deleteProjectCheckpoint(p.id)
                                : restoreProjectCheckpoint(p.id))
                            }
                            onCancel={() => setConfirmAction(null)}
                            testId={`project-${confirmAction.action}-${p.id}`}
                          />
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={working !== null}
                              onClick={() => setConfirmAction({ id: p.id, action: 'restore' })}
                              data-testid={`project-restore-${p.id}`}
                              title="Restore every file to this snapshot"
                            >
                              Restore all
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={working !== null}
                              onClick={() => setConfirmAction({ id: p.id, action: 'delete' })}
                              data-testid={`project-delete-${p.id}`}
                            >
                              Delete
                            </Button>
                          </>
                        ))
                      }
                    />
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-between border-b border-hairline-strong bg-page px-3 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                File checkpoints
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={showAuto}
                  onChange={(e) => setShowAuto(e.target.checked)}
                  data-testid="history-show-auto"
                />
                <span>Show auto</span>
              </label>
            </div>
            {(() => {
              const visible = showAuto
                ? checkpoints
                : checkpoints.filter((c) => c.kind !== 'auto_open');
              if (visible.length === 0) {
                return (
                  <div className="p-3 text-xs text-muted" data-testid="history-empty">
                    {checkpoints.length > 0
                      ? 'Auto checkpoints are hidden. Turn on Show auto to see them.'
                      : 'No checkpoints yet.'}
                  </div>
                );
              }
              return (
                <ul data-testid="history-list">
                  {visible.map((cp) => {
                    const auto = cp.kind === 'auto_open';
                    return (
                      <CheckpointCard
                        key={cp.id}
                        testId="history-item"
                        dataAttrs={{ 'data-kind': cp.kind ?? 'user' }}
                        label={cp.label}
                        meta={formatDateTime(cp.created_at)}
                        variant={auto ? 'auto' : 'default'}
                        onPreview={() => void handlePreview(cp)}
                      />
                    );
                  })}
                </ul>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
