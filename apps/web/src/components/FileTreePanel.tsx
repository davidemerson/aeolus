import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, ConfirmInline, toastStore } from '@aeolus/shared/ui';

import { api, ApiRequestError, reportUnauthenticated } from '../lib/api.js';

// Browser-only File System Entry types from the (non-standard but
// universally-supported) webkitGetAsEntry surface. We type the
// minimum we use; lib.dom only types these on certain TS targets,
// so declare them here instead of pulling a polyfill.
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FsFileEntry extends FsEntry {
  isFile: true;
  file(success: (file: File) => void, error?: (err: unknown) => void): void;
}
interface FsDirectoryEntry extends FsEntry {
  isDirectory: true;
  createReader(): FsDirectoryReader;
}
interface FsDirectoryReader {
  readEntries(success: (entries: FsEntry[]) => void, error?: (err: unknown) => void): void;
}

// Walk a FileSystemEntry tree and return [{ file, path }] for every
// leaf file. Path is relative to the dropped directory's root (no
// leading /). Bounded recursion: most LaTeX projects nest 2-3 deep.
async function readEntryTree(
  entry: FsEntry,
  basePath: string,
): Promise<{ file: File; path: string }[]> {
  if (entry.isFile) {
    const fileEntry = entry as FsFileEntry;
    return new Promise((resolve, reject) => {
      fileEntry.file(
        (f) => resolve([{ file: f, path: basePath ? `${basePath}/${entry.name}` : entry.name }]),
        (err) => reject(err),
      );
    });
  }
  if (!entry.isDirectory) return [];
  const dir = entry as FsDirectoryEntry;
  const reader = dir.createReader();
  // readEntries can return chunks of children — keep calling until
  // it returns an empty array.
  const children: FsEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    const readMore = (): void => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve();
          return;
        }
        children.push(...entries);
        readMore();
      }, reject);
    };
    readMore();
  });
  const here = basePath ? `${basePath}/${entry.name}` : entry.name;
  const nested = await Promise.all(children.map((c) => readEntryTree(c, here)));
  return nested.flat();
}

// Upload one file at a specific project-relative path via POST
// /api/docs/:id/files/upload. Errors propagate; the caller decides
// whether to toast each individually.
async function uploadFileAtPath(docId: string, file: File, path: string): Promise<void> {
  const fd = new FormData();
  fd.append('path', path);
  fd.append('file', file);
  const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/files/upload`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    // Raw fetch (multipart cannot go through `api`), so the global
    // 401 → /login hook is invoked by hand here.
    if (res.status === 401) reportUnauthenticated();
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? 'The upload failed.');
  }
}

export interface ProjectFile {
  id: string;
  path: string;
  // 'folder' rows materialise empty folders that don't have any
  // files inside yet — they're persisted server-side per migration
  // 0023 so the user's "New folder" survives a reload.
  kind: 'text' | 'blob' | 'folder';
  yjs_doc_id: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
  updated_at: string;
}

interface FileTreePanelProps {
  docId: string;
  canWrite: boolean;
  // Currently-open text file id (or null when the user hasn't picked
  // one yet; the editor falls back to main.{tex,typ}).
  selectedFileId: string | null;
  // Notified when the user clicks a text file. The host
  // (doc-editor.tsx) tears down its WebsocketProvider and reopens
  // with the file's yjs_doc_id.
  onSelectFile: (file: ProjectFile) => void;
}

// Group files into a tree by '/' separators. Folders are implicit —
// we don't store them; presence of files under a path prefix is
// what creates a folder in the UI. Sorting puts folders first
// (case-insensitive), files second.
interface TreeNode {
  name: string;
  fullPath: string;
  // Either a file or a folder. Folders have children; files have
  // a backing ProjectFile.
  kind: 'folder' | 'file';
  file?: ProjectFile;
  children?: Map<string, TreeNode>;
}

function buildTree(files: readonly ProjectFile[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', kind: 'folder', children: new Map() };
  // First pass: materialise every text/blob file under its path
  // segments, implicitly creating folder nodes along the way.
  for (const f of files) {
    if (f.kind === 'folder') continue;
    const segments = f.path.split('/');
    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      if (!cursor.children) cursor.children = new Map();
      let next = cursor.children.get(seg);
      if (!next) {
        next = isLast
          ? { name: seg, fullPath: f.path, kind: 'file', file: f }
          : {
              name: seg,
              fullPath: segments.slice(0, i + 1).join('/'),
              kind: 'folder',
              children: new Map(),
            };
        cursor.children.set(seg, next);
      }
      cursor = next;
    }
  }
  // Second pass: explicit empty-folder rows from the server. Walk
  // each folder path's segments; create any missing nodes. Attach
  // the ProjectFile so the per-row delete + rename UI knows the
  // server id of the folder.
  for (const f of files) {
    if (f.kind !== 'folder') continue;
    const segments = f.path.split('/');
    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      if (!cursor.children) cursor.children = new Map();
      let next = cursor.children.get(seg);
      if (!next) {
        next = {
          name: seg,
          fullPath: segments.slice(0, i + 1).join('/'),
          kind: 'folder',
          children: new Map(),
        };
        cursor.children.set(seg, next);
      }
      // Attach the ProjectFile to the leaf folder node so it has
      // an actionable id. If a file with the same path already
      // landed (shouldn't happen — server enforces UNIQUE
      // (doc_id, path)), don't clobber.
      if (isLast && next.kind === 'folder' && !next.file) {
        next.file = f;
      }
      cursor = next;
    }
  }
  return root;
}

function sortChildren(node: TreeNode): TreeNode[] {
  if (!node.children) return [];
  const arr = Array.from(node.children.values());
  arr.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return arr;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  selectedFileId: string | null;
  canWrite: boolean;
  renamingFileId: string | null;
  onSelectFile: (file: ProjectFile) => void;
  onDelete: (file: ProjectFile) => void;
  onStartRename: (file: ProjectFile) => void;
  onCommitRename: (file: ProjectFile, newPath: string) => void;
  onCancelRename: () => void;
  onMove: (file: ProjectFile, toFolderPath: string) => void;
  // OS files dropped onto a folder row. The host flattens the
  // DataTransfer (synchronously — entries expire with the event)
  // and uploads each file under `${folderPath}/…`.
  onOsDrop: (e: React.DragEvent, folderPath: string) => void;
}

// HTML5 dnd payload key — uses a custom MIME so OS-file drops don't
// accidentally match it. The dataTransfer string is the file id.
const DND_TYPE = 'application/x-aeolus-doc-file';

// Wrapped in React.memo so unrelated FileTreePanel re-renders
// (dragOver, showCreate, newPath, etc.) don't cascade through the
// whole tree. Handler props are stable via useCallback in the
// parent, and `node`/`tree` are stable via useMemo([files]) — so
// shallow prop comparison correctly preserves untouched subtrees.
const FileTreeNodeView = memo(function FileTreeNodeView({
  node,
  depth,
  selectedFileId,
  canWrite,
  renamingFileId,
  onSelectFile,
  onDelete,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMove,
  onOsDrop,
}: FileTreeNodeProps): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const padding = 4 + depth * 12;
  const sortedChildren = useMemo(() => sortChildren(node), [node]);

  if (node.kind === 'folder') {
    const folderFile = node.file ?? null;
    const folderPath = node.fullPath;
    const isRenaming = folderFile && renamingFileId === folderFile.id;
    const isMainFolder = folderPath === '';

    const handleDragOver = (e: React.DragEvent): void => {
      if (!canWrite) return;
      const isInternal = e.dataTransfer.types.includes(DND_TYPE);
      // OS-file drags advertise 'Files'; accepting them here lets a
      // user drop straight INTO a folder instead of always landing
      // at the project root (#82).
      const isOsFiles = e.dataTransfer.types.includes('Files');
      if (!isInternal && !isOsFiles) return;
      e.preventDefault();
      // Keep the panel's root-level drop highlight off while the
      // cursor is over a folder — this folder is the target.
      e.stopPropagation();
      e.dataTransfer.dropEffect = isInternal ? 'move' : 'copy';
      if (!dragOver) setDragOver(true);
    };
    const handleDragLeave = (): void => setDragOver(false);
    const handleDrop = (e: React.DragEvent): void => {
      e.preventDefault();
      setDragOver(false);
      if (!canWrite) return;
      const draggedId = e.dataTransfer.getData(DND_TYPE);
      if (draggedId) {
        e.stopPropagation();
        // The host (FileTreePanel) resolves the id to a ProjectFile,
        // checks self-into-self moves, and PATCHes.
        onMove({ id: draggedId } as ProjectFile, folderPath);
        return;
      }
      if (e.dataTransfer.files.length > 0 || e.dataTransfer.items.length > 0) {
        // OS files dropped onto this folder: upload INTO it. Stop
        // propagation or the panel's root drop handler would upload
        // the same files a second time, at the root.
        e.stopPropagation();
        onOsDrop(e, folderPath);
      }
    };

    return (
      <div
        data-testid={`file-tree-folder-${node.fullPath || 'root'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={dragOver ? 'bg-accent-bg-alt' : undefined}
      >
        <div
          className="flex items-center gap-1"
          style={isRenaming ? undefined : { paddingLeft: 0 }}
          draggable={canWrite && !isMainFolder && folderFile != null}
          onDragStart={(e) => {
            if (folderFile) {
              e.dataTransfer.setData(DND_TYPE, folderFile.id);
              e.dataTransfer.effectAllowed = 'move';
            }
          }}
        >
          {isRenaming ? (
            <RenameInput
              initialName={node.name}
              padding={padding}
              data-testid={`file-tree-rename-input-${node.fullPath}`}
              onCommit={(name) => {
                if (!folderFile) return;
                const parent = folderPath.includes('/')
                  ? folderPath.slice(0, folderPath.lastIndexOf('/') + 1)
                  : '';
                onCommitRename(folderFile, parent + name);
              }}
              onCancel={onCancelRename}
            />
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{ paddingLeft: `${padding}px` }}
              className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-xs text-body-2 hover:bg-fill-hover"
            >
              <span className="font-mono text-[10px] text-muted">{expanded ? '▾' : '▸'}</span>
              <span className="truncate font-medium">{node.name || '/'}</span>
            </button>
          )}
          {canWrite && folderFile && !isRenaming && !isMainFolder ? (
            <>
              <button
                type="button"
                className="px-1 text-[10px] text-muted hover:text-body-2"
                onClick={() => onStartRename(folderFile)}
                data-testid={`file-tree-rename-${node.fullPath}`}
                aria-label={`Rename ${node.fullPath}`}
                title={`Rename ${node.fullPath}`}
              >
                ✎
              </button>
              <button
                type="button"
                className="px-1 text-[10px] text-muted hover:text-accent-text"
                onClick={() => onDelete(folderFile)}
                data-testid={`file-tree-delete-${node.fullPath}`}
                aria-label={`Delete ${node.fullPath}`}
                title={`Delete ${node.fullPath}`}
              >
                ✕
              </button>
            </>
          ) : null}
        </div>
        {expanded && (
          <div>
            {sortedChildren.map((child) => (
              <FileTreeNodeView
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                selectedFileId={selectedFileId}
                canWrite={canWrite}
                renamingFileId={renamingFileId}
                onSelectFile={onSelectFile}
                onDelete={onDelete}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                onMove={onMove}
                onOsDrop={onOsDrop}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const file = node.file!;
  const selected = selectedFileId === file.id;
  // The main.{tex,typ} entrypoint is locked: it can't be deleted or
  // renamed (the worker resolves it by path). UI hides the delete.
  const isMain = file.path === 'main.tex' || file.path === 'main.typ';
  const isRenaming = renamingFileId === file.id;
  return (
    <div
      data-testid={`file-tree-file-${file.path}`}
      data-file-id={file.id}
      className={`flex items-center gap-1 ${selected ? 'bg-accent-bg-alt' : 'hover:bg-fill-hover'}`}
      draggable={canWrite && !isMain}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_TYPE, file.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {isRenaming ? (
        <RenameInput
          initialName={node.name}
          padding={padding}
          data-testid={`file-tree-rename-input-${file.path}`}
          onCommit={(name) => {
            const parent = file.path.includes('/')
              ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
              : '';
            onCommitRename(file, parent + name);
          }}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          disabled={file.kind !== 'text'}
          onClick={() => file.kind === 'text' && onSelectFile(file)}
          style={{ paddingLeft: `${padding}px` }}
          // min-w-0 lets `truncate` on the inner filename actually
          // clip — without it, the flex parent expands to fit the
          // longest filename and forces the size column off the row.
          className={`flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs ${
            file.kind === 'text' ? 'text-body-2 cursor-pointer' : 'cursor-default text-muted'
          } ${selected ? 'font-semibold text-accent-fg-strong' : ''}`}
          title={file.path}
        >
          <span className="font-mono text-[10px] text-muted">
            {file.kind === 'text' ? '📄' : '📎'}
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {file.size_bytes != null ? (
            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted">
              {formatSize(file.size_bytes)}
            </span>
          ) : null}
        </button>
      )}
      {canWrite && !isMain && !isRenaming ? (
        <>
          <button
            type="button"
            className="px-1 text-[10px] text-muted hover:text-body-2"
            onClick={() => onStartRename(file)}
            data-testid={`file-tree-rename-${file.path}`}
            aria-label={`Rename ${file.path}`}
            title={`Rename ${file.path} — type a path with / to move it (e.g. fonts/${node.name})`}
          >
            ✎
          </button>
          <button
            type="button"
            className="px-1 text-[10px] text-muted hover:text-accent-text"
            onClick={() => onDelete(file)}
            data-testid={`file-tree-delete-${file.path}`}
            aria-label={`Delete ${file.path}`}
            title={`Delete ${file.path}`}
          >
            ✕
          </button>
        </>
      ) : null}
    </div>
  );
});

function RenameInput({
  initialName,
  padding,
  onCommit,
  onCancel,
  ...rest
}: {
  initialName: string;
  padding: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
} & Record<string, unknown>): JSX.Element {
  const [value, setValue] = useState(initialName);
  return (
    <input
      autoFocus
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value.trim());
        else if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onCommit(value.trim())}
      style={{ marginLeft: `${padding}px` }}
      className="flex-1 rounded border border-hairline-strong px-1 py-0.5 font-mono text-xs text-body focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
      {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
    />
  );
}

export function FileTreePanel({
  docId,
  canWrite,
  selectedFileId,
  onSelectFile,
}: FileTreePanelProps): JSX.Element {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  // Why the last list load failed. Rendered in place of the tree (with a
  // Retry button) while nothing has loaded yet; once a tree is on screen a
  // failed refresh toasts instead so the files stay visible.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState<null | 'text' | 'folder'>(null);
  const [newPath, setNewPath] = useState('');
  const [creating, setCreating] = useState(false);
  // The file whose delete is awaiting the inline confirm, and whether the
  // confirmed request is in flight. This used to be a "click ✕ again within
  // four seconds" gesture announced by a toast; the confirm now sits at the
  // top of the panel, names the file, and waits.
  const [pendingDelete, setPendingDelete] = useState<ProjectFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // Separate single-file picker so users can drop a logo / .bib /
  // .cls without having to put it in a folder first. The folder
  // input has webkitdirectory set, which the browser interprets as
  // "directory only" — single-file uploads need a normal input.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadFiles = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<{ files: ProjectFile[] }>(
        `/docs/${encodeURIComponent(docId)}/files`,
      );
      setFiles(res.files);
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? err.message : 'The file list could not be loaded.';
      setLoadError(message);
      setFiles((prev) => {
        if (prev !== null) toastStore.push({ kind: 'error', message });
        return prev;
      });
    }
  }, [docId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const tree = useMemo(() => (files ? buildTree(files) : null), [files]);

  const createFile = useCallback(async () => {
    if (creating || showCreate === null) return;
    const trimmed = newPath.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      await api.post(`/docs/${encodeURIComponent(docId)}/files`, {
        path: trimmed,
        ...(showCreate === 'folder' ? { kind: 'folder' } : {}),
      });
      setNewPath('');
      setShowCreate(null);
      toastStore.push({
        kind: 'success',
        message: showCreate === 'folder' ? 'Folder created' : 'File created',
      });
      await loadFiles();
    } catch (err) {
      toastStore.push({
        kind: 'error',
        message: err instanceof ApiRequestError ? err.message : 'Create failed',
      });
    } finally {
      setCreating(false);
    }
  }, [creating, newPath, showCreate, docId, loadFiles]);

  const uploadBatch = useCallback(
    async (entries: { file: File; path: string }[]) => {
      if (entries.length === 0 || uploading) return;
      setUploading(true);
      let succeeded = 0;
      const failures: { path: string; reason: string }[] = [];
      // Serial upload — the per-doc total-size cap is enforced
      // server-side, so racing a parallel batch could overshoot
      // before the server rejects.
      for (const { file, path: targetPath } of entries) {
        try {
          await uploadFileAtPath(docId, file, targetPath);
          succeeded += 1;
        } catch (err) {
          failures.push({
            path: targetPath,
            reason: err instanceof Error ? err.message : 'Upload failed',
          });
        }
      }
      await loadFiles();
      setUploading(false);
      if (succeeded > 0) {
        toastStore.push({
          kind: 'success',
          message:
            succeeded === entries.length
              ? `Uploaded ${succeeded} file${succeeded === 1 ? '' : 's'}`
              : `Uploaded ${succeeded} of ${entries.length} files`,
        });
      }
      for (const f of failures) {
        toastStore.push({ kind: 'error', message: `${f.path}: ${f.reason}` });
      }
    },
    [docId, uploading, loadFiles],
  );

  // Folder picker via <input type="file" webkitdirectory>. The
  // browser exposes File.webkitRelativePath as
  // "<picked-folder-name>/<relative-path>" — we strip the
  // picked-folder segment so the doc tree mirrors the folder's
  // *contents*, not the folder itself.
  const handleFolderPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? []);
      const entries = picked.map((file) => {
        // webkitRelativePath: "myproject/chapters/intro.tex"
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        const stripped = rel ? rel.split('/').slice(1).join('/') : file.name;
        return { file, path: stripped || file.name };
      });
      void uploadBatch(entries);
      if (folderInputRef.current) folderInputRef.current.value = '';
    },
    [uploadBatch],
  );

  // Single-file picker. Drops the chosen file at the project root
  // using its name as the path. For nested placement, users drag-
  // drop into the panel or upload a folder.
  const handleFilePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? []);
      const entries = picked.map((file) => ({ file, path: file.name }));
      void uploadBatch(entries);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [uploadBatch],
  );

  // Drag-drop of OS files/folders. DataTransferItem.webkitGetAsEntry()
  // is non-standard but supported by every browser we ship to. We
  // recursively flatten directories into a single batch and upload
  // via the same path as the folder picker. `intoFolder` is '' for a
  // drop on the panel itself and the folder's path when the drop
  // landed on a folder row (#82) — every uploaded path is prefixed
  // with it. NOTE: entries must be pulled from the DataTransfer
  // before the first await; they expire with the event.
  const handleOsDrop = useCallback(
    async (e: React.DragEvent, intoFolder: string) => {
      e.preventDefault();
      setDragOver(false);
      if (!canWrite) return;
      const prefix = intoFolder ? `${intoFolder}/` : '';
      const items = Array.from(e.dataTransfer.items);
      const entriesPerItem = await Promise.all(
        items.map((item) => {
          const entry = (
            item as DataTransferItem & {
              webkitGetAsEntry?: () => FsEntry | null;
            }
          ).webkitGetAsEntry?.();
          if (!entry) return Promise.resolve([]);
          // Top-level entries enter at the root: "intro.tex"
          // becomes path "intro.tex"; "chapters/intro.tex" via
          // a dropped chapters/ folder becomes
          // "chapters/intro.tex".
          if (entry.isFile) {
            return readEntryTree(entry, '');
          }
          // For a dropped directory, descend with basePath = '' and
          // the entry name is the directory's own name; we want
          // its CONTENTS at the root, mirror-of-picker semantics.
          // Cast through unknown — lib.dom's FileSystemEntry has a
          // narrower surface than the runtime API we actually use.
          const dir = entry as unknown as FsDirectoryEntry;
          const reader = dir.createReader();
          return new Promise<{ file: File; path: string }[]>((resolve, reject) => {
            const collected: FsEntry[] = [];
            const readMore = (): void => {
              reader.readEntries((children) => {
                if (children.length === 0) {
                  Promise.all(collected.map((c) => readEntryTree(c, ''))).then(
                    (nested) => resolve(nested.flat()),
                    reject,
                  );
                  return;
                }
                collected.push(...children);
                readMore();
              }, reject);
            };
            readMore();
          });
        }),
      );
      const all = entriesPerItem.flat();
      // Fall back to the legacy "files" interface for browsers
      // that don't expose webkitGetAsEntry on a particular item.
      if (all.length === 0) {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          await uploadBatch(files.map((f) => ({ file: f, path: `${prefix}${f.name}` })));
        }
        return;
      }
      await uploadBatch(all.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
    },
    [canWrite, uploadBatch],
  );

  const requestDelete = useCallback((file: ProjectFile) => {
    setPendingDelete(file);
  }, []);

  const deleteFile = useCallback(
    async (file: ProjectFile) => {
      setDeleting(true);
      try {
        await api.delete(`/docs/${encodeURIComponent(docId)}/files/${encodeURIComponent(file.id)}`);
        toastStore.push({ kind: 'success', message: `Deleted ${file.path}` });
        setPendingDelete(null);
        await loadFiles();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Delete failed',
        });
      } finally {
        setDeleting(false);
      }
    },
    [docId, loadFiles],
  );

  // Inline rename. The user clicks ✎, the row swaps to an input,
  // Enter commits, Escape cancels. Server-side validates path
  // collisions (409 path_taken → toast). main.{tex,typ} hides the
  // ✎ entirely.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const startRename = useCallback((file: ProjectFile) => {
    setRenamingId(file.id);
  }, []);
  const cancelRename = useCallback(() => setRenamingId(null), []);
  const commitRename = useCallback(
    async (file: ProjectFile, newPath: string) => {
      setRenamingId(null);
      const trimmed = newPath.trim();
      if (!trimmed || trimmed === file.path) return;
      try {
        await api.patch(`/docs/${encodeURIComponent(docId)}/files/${encodeURIComponent(file.id)}`, {
          path: trimmed,
        });
        toastStore.push({ kind: 'success', message: `Renamed to ${trimmed}` });
        await loadFiles();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Rename failed',
        });
      }
    },
    [docId, loadFiles],
  );

  // void-returning adapter so the memo'd tree rows get a stable
  // reference (FileTreeNodeView relies on shallow prop equality).
  const onFolderOsDrop = useCallback(
    (e: React.DragEvent, folderPath: string) => {
      void handleOsDrop(e, folderPath);
    },
    [handleOsDrop],
  );

  // Drag-drop within the panel: file/folder row → folder row.
  // The drop target sends only the dragged id; we look it up here
  // so we can refuse self-into-self / self-into-descendant moves
  // before issuing a PATCH.
  const moveFile = useCallback(
    async (dragged: ProjectFile, toFolderPath: string) => {
      const all = files ?? [];
      const real = all.find((f) => f.id === dragged.id);
      if (!real) return;
      // Compute the new path. Empty toFolderPath means root.
      const basename = real.path.includes('/')
        ? real.path.slice(real.path.lastIndexOf('/') + 1)
        : real.path;
      const newPath = toFolderPath ? `${toFolderPath}/${basename}` : basename;
      if (newPath === real.path) return;
      // Refuse moving a folder into itself or a descendant.
      if (real.kind === 'folder') {
        if (toFolderPath === real.path || toFolderPath.startsWith(`${real.path}/`)) {
          toastStore.push({
            kind: 'error',
            message: "Can't move a folder into itself.",
          });
          return;
        }
      }
      // main.{tex,typ} can't be moved (rename-locked server-side).
      if (real.path === 'main.tex' || real.path === 'main.typ') {
        toastStore.push({
          kind: 'info',
          message: 'The main file cannot be moved.',
        });
        return;
      }
      try {
        await api.patch(`/docs/${encodeURIComponent(docId)}/files/${encodeURIComponent(real.id)}`, {
          path: newPath,
        });
        toastStore.push({ kind: 'success', message: `Moved to ${newPath}` });
        await loadFiles();
      } catch (err) {
        toastStore.push({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Move failed',
        });
      }
    },
    [docId, files, loadFiles],
  );

  return (
    <div
      data-testid="file-tree-panel"
      className={`flex h-full flex-col border-r border-hairline-strong bg-surface ${
        dragOver ? 'ring-2 ring-inset ring-focus' : ''
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (canWrite) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleOsDrop(e, '')}
    >
      <div className="flex flex-col gap-2 border-b border-hairline-strong px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">// files</span>
        {canWrite ? (
          <div className="flex items-center gap-1">
            <Button
              variant="mono"
              size="xs"
              className="flex-1 whitespace-nowrap"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              data-testid="file-tree-upload-file"
              title="Upload files to the project root — drop files onto a folder to upload into it"
            >
              {uploading ? '…' : '↑ file'}
            </Button>
            <Button
              variant="mono"
              size="xs"
              className="flex-1 whitespace-nowrap"
              disabled={uploading}
              onClick={() => folderInputRef.current?.click()}
              data-testid="file-tree-upload-folder"
              title="Upload an entire folder, preserving its structure"
            >
              ↑ folder
            </Button>
            <Button
              variant="mono"
              size="xs"
              className="flex-1 whitespace-nowrap"
              onClick={() => setShowCreate((v) => (v === 'text' ? null : 'text'))}
              data-testid="file-tree-new-toggle"
            >
              {showCreate === 'text' ? 'cancel' : '+ file'}
            </Button>
            <Button
              variant="mono"
              size="xs"
              className="flex-1 whitespace-nowrap"
              onClick={() => setShowCreate((v) => (v === 'folder' ? null : 'folder'))}
              data-testid="file-tree-new-folder-toggle"
            >
              {showCreate === 'folder' ? 'cancel' : '+ folder'}
            </Button>
            {/* Hidden file inputs. `webkitdirectory` is non-standard
                but supported on every target browser; the
                `directory` attribute is the corresponding spec-
                track. The single-file input is plain — no
                webkitdirectory — so the browser treats setInputFiles
                / a file pick as a regular upload. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFilePick}
              data-testid="file-tree-file-input"
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error — non-standard attribute, accepted
              // by every browser we ship to.
              webkitdirectory=""
              directory=""
              className="hidden"
              onChange={handleFolderPick}
              data-testid="file-tree-folder-input"
            />
          </div>
        ) : null}
      </div>
      {pendingDelete && canWrite ? (
        <ConfirmInline
          className="border-b border-hairline-strong px-3 py-2"
          message={`Delete ${pendingDelete.path}? This cannot be undone.`}
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          destructive
          pending={deleting}
          onConfirm={() => void deleteFile(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
          testId="file-tree-delete-confirm"
        />
      ) : null}
      {showCreate && canWrite ? (
        <div className="border-b border-hairline-strong px-3 py-2" data-testid="file-tree-new-form">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder={showCreate === 'folder' ? 'chapters' : 'path/to/new.tex'}
            aria-label={showCreate === 'folder' ? 'New folder name' : 'New file path'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFile();
            }}
            className="mb-2 w-full rounded border border-hairline-strong px-2 py-1 text-xs text-body focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
            data-testid="file-tree-new-input"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={creating || !newPath.trim()}
            onClick={() => void createFile()}
            data-testid="file-tree-new-submit"
          >
            {creating ? 'Creating…' : showCreate === 'folder' ? 'Create folder' : 'Create file'}
          </Button>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto py-1">
        {files === null && loadError !== null ? (
          <div className="p-3 text-xs" data-testid="file-tree-error">
            <p className="text-danger-fg">{loadError}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => void loadFiles()}
              data-testid="file-tree-retry"
            >
              Retry
            </Button>
          </div>
        ) : files === null ? (
          <div className="p-3 text-xs text-muted">Loading…</div>
        ) : tree && tree.children && tree.children.size > 0 ? (
          <div
            data-testid="file-tree-root"
            // Drop target for the root: a row dragged here moves to
            // the project root (no folder prefix). The per-folder
            // drop targets handle nested moves.
            onDragOver={(e) => {
              if (canWrite && e.dataTransfer.types.includes(DND_TYPE)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(e) => {
              if (!canWrite) return;
              const id = e.dataTransfer.getData(DND_TYPE);
              if (!id) return;
              e.preventDefault();
              e.stopPropagation();
              void moveFile({ id } as ProjectFile, '');
            }}
          >
            {sortChildren(tree).map((node) => (
              <FileTreeNodeView
                key={node.fullPath}
                node={node}
                depth={0}
                selectedFileId={selectedFileId}
                canWrite={canWrite}
                renamingFileId={renamingId}
                onSelectFile={onSelectFile}
                onDelete={requestDelete}
                onStartRename={startRename}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onMove={moveFile}
                onOsDrop={onFolderOsDrop}
              />
            ))}
          </div>
        ) : (
          <div className="p-3 text-xs text-muted">No files yet.</div>
        )}
      </div>
    </div>
  );
}
