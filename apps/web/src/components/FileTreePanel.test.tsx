import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { FileTreePanel, type ProjectFile } from './FileTreePanel.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(responder: (url: string, init?: RequestInit) => Response): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({
        url: u,
        method: init?.method ?? 'GET',
        body: init?.body,
      });
      return responder(u, init);
    }),
  );
  return { calls };
}

const FILES: ProjectFile[] = [
  {
    id: 'file-main',
    path: 'main.tex',
    kind: 'text',
    yjs_doc_id: 'yjs-main',
    size_bytes: null,
    mime_type: null,
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
  },
  {
    id: 'file-intro',
    path: 'chapters/intro.tex',
    kind: 'text',
    yjs_doc_id: 'yjs-intro',
    size_bytes: null,
    mime_type: null,
    created_at: '2026-05-01T11:00:00Z',
    updated_at: '2026-05-01T11:00:00Z',
  },
  {
    id: 'file-logo',
    path: 'images/logo.png',
    kind: 'blob',
    yjs_doc_id: null,
    size_bytes: 12_345,
    mime_type: 'image/png',
    created_at: '2026-05-01T12:00:00Z',
    updated_at: '2026-05-01T12:00:00Z',
  },
];

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('FileTreePanel', () => {
  beforeEach(() => {
    installFetchMock((url, init) => {
      if (url.endsWith('/files') && (init?.method ?? 'GET') === 'GET') {
        return okJson({ files: FILES });
      }
      if (url.endsWith('/files') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            file: {
              id: 'file-new',
              path: 'new.tex',
              kind: 'text',
              yjs_doc_id: 'yjs-new',
              created_at: '2026-05-01T13:00:00Z',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });
  });

  it('renders folders + files grouped by path', async () => {
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    // main.tex sits at the root.
    expect(screen.getByTestId('file-tree-file-main.tex')).toBeTruthy();
    // chapters/ folder + nested file.
    expect(screen.getByTestId('file-tree-folder-chapters')).toBeTruthy();
    expect(screen.getByTestId('file-tree-file-chapters/intro.tex')).toBeTruthy();
    // images/ folder + blob.
    expect(screen.getByTestId('file-tree-folder-images')).toBeTruthy();
    expect(screen.getByTestId('file-tree-file-images/logo.png')).toBeTruthy();
  });

  it('clicks a text file → onSelectFile fires; blobs are not selectable', async () => {
    const onSelect = vi.fn();
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={onSelect} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    const intro = screen.getByTestId('file-tree-file-chapters/intro.tex');
    fireEvent.click(intro.querySelector('button')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('file-intro');

    const logo = screen.getByTestId('file-tree-file-images/logo.png');
    const logoBtn = logo.querySelector('button')!;
    expect(logoBtn).toBeTruthy();
    expect((logoBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('✕ opens an inline confirm naming the file; DELETE only after confirm', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body });
        if (u.endsWith('/files') && (init?.method ?? 'GET') === 'GET') {
          return okJson({ files: FILES });
        }
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response('{}', { status: 404 });
      }),
    );
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    fireEvent.click(screen.getByTestId('file-tree-delete-chapters/intro.tex'));
    expect(screen.getByTestId('file-tree-delete-confirm').textContent).toContain(
      'Delete chapters/intro.tex?',
    );
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    // Cancel closes it without a request.
    fireEvent.click(screen.getByTestId('file-tree-delete-confirm-cancel'));
    expect(screen.queryByTestId('file-tree-delete-confirm')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('file-tree-delete-chapters/intro.tex'));
    fireEvent.click(screen.getByTestId('file-tree-delete-confirm-confirm'));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
        '/api/docs/doc-1/files/file-intro',
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('file-tree-delete-confirm')).toBeNull();
    });
  });

  it('main.tex has no delete button; non-main text files do', async () => {
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    expect(screen.queryByTestId('file-tree-delete-main.tex')).toBeNull();
    expect(screen.queryByTestId('file-tree-delete-chapters/intro.tex')).toBeTruthy();
  });

  it('folder picker uploads each File, stripping the picked-folder prefix', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        const body = init?.body;
        let path: string | undefined;
        if (body instanceof FormData) {
          const p = body.get('path');
          if (typeof p === 'string') path = p;
        }
        calls.push({ url: u, method: init?.method ?? 'GET', body: path });
        if (u.endsWith('/files') && (init?.method ?? 'GET') === 'GET') {
          return okJson({ files: FILES });
        }
        if (u.endsWith('/files/upload') && init?.method === 'POST') {
          return new Response('{}', { status: 201 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    const input = screen.getByTestId('file-tree-folder-input') as HTMLInputElement;
    // Construct two Files with webkitRelativePath set to a
    // "myproject/<rel>" pattern. Browsers populate the property at
    // pick time; we set it via Object.defineProperty for the test.
    const f1 = new File(['hello'], 'intro.tex', { type: 'text/plain' });
    Object.defineProperty(f1, 'webkitRelativePath', {
      value: 'myproject/chapters/intro.tex',
      configurable: true,
    });
    const f2 = new File(['hi'], 'logo.png', { type: 'image/png' });
    Object.defineProperty(f2, 'webkitRelativePath', {
      value: 'myproject/images/logo.png',
      configurable: true,
    });
    Object.defineProperty(input, 'files', {
      value: [f1, f2],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => {
      const uploads = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/files/upload'));
      expect(uploads).toHaveLength(2);
      expect(uploads.map((c) => c.body).sort()).toEqual(['chapters/intro.tex', 'images/logo.png']);
    });
  });

  // #82: OS files dropped onto a FOLDER row upload into that folder
  // (path prefixed), not to the project root. jsdom has no real
  // DataTransferItem/webkitGetAsEntry, so this exercises the
  // `dataTransfer.files` fallback branch — the same one a browser
  // takes for programmatic drops.
  it('dropping an OS file onto a folder row uploads it into that folder', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        const body = init?.body;
        let path: string | undefined;
        if (body instanceof FormData) {
          const p = body.get('path');
          if (typeof p === 'string') path = p;
        }
        calls.push({ url: u, method: init?.method ?? 'GET', body: path });
        if (u.endsWith('/files') && (init?.method ?? 'GET') === 'GET') {
          return okJson({ files: FILES });
        }
        if (u.endsWith('/files/upload') && init?.method === 'POST') {
          return new Response('{}', { status: 201 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    const folder = screen.getByTestId('file-tree-folder-images');
    const dropped = new File(['bytes'], 'diagram.png', { type: 'image/png' });
    fireEvent.drop(folder, {
      dataTransfer: {
        types: ['Files'],
        items: [],
        files: [dropped],
        getData: () => '',
      },
    });
    await waitFor(() => {
      const uploads = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/files/upload'));
      expect(uploads).toHaveLength(1);
      expect(uploads[0].body).toBe('images/diagram.png');
    });
  });

  it('POST /files happens when "Create" is submitted', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body });
        if (u.endsWith('/files') && (init?.method ?? 'GET') === 'GET') {
          return okJson({ files: FILES });
        }
        if (u.endsWith('/files') && init?.method === 'POST') {
          return new Response('{}', { status: 201 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    fireEvent.click(screen.getByTestId('file-tree-new-toggle'));
    const input = screen.getByTestId('file-tree-new-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new.tex' } });
    fireEvent.click(screen.getByTestId('file-tree-new-submit'));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/files'));
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body as string)).toEqual({ path: 'new.tex' });
    });
  });
});

describe('FileTreePanel — load failure', () => {
  it('shows the error with a Retry button instead of Loading… forever, and Retry reloads', async () => {
    let failing = true;
    const { calls } = installFetchMock((url, init) => {
      if (url.endsWith('/files') && (init?.method ?? 'GET') === 'GET') {
        return failing
          ? new Response(
              JSON.stringify({ error: 'upstream', message: 'The file list is unavailable' }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            )
          : okJson({ files: FILES });
      }
      return new Response('{}', { status: 404 });
    });
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    const err = await waitFor(() => screen.getByTestId('file-tree-error'));
    expect(err.textContent).toContain('The file list is unavailable');
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByTestId('file-tree-root')).toBeNull();

    failing = false;
    fireEvent.click(screen.getByTestId('file-tree-retry'));
    await waitFor(() => screen.getByTestId('file-tree-root'));
    expect(screen.queryByTestId('file-tree-error')).toBeNull();
    expect(calls.filter((c) => c.url.endsWith('/files') && c.method === 'GET')).toHaveLength(2);
  });
});

describe('FileTreePanel — new path input', () => {
  beforeEach(() => {
    installFetchMock((url, init) => {
      if (url.endsWith('/files') && (init?.method ?? 'GET') === 'GET')
        return okJson({ files: FILES });
      return new Response('{}', { status: 404 });
    });
  });

  it('labels the path field for each create mode', async () => {
    render(
      <FileTreePanel docId="doc-1" canWrite={true} selectedFileId={null} onSelectFile={() => {}} />,
    );
    await waitFor(() => screen.getByTestId('file-tree-root'));
    fireEvent.click(screen.getByTestId('file-tree-new-toggle'));
    expect(screen.getByLabelText('New file path')).toBe(screen.getByTestId('file-tree-new-input'));
    fireEvent.click(screen.getByTestId('file-tree-new-folder-toggle'));
    expect(screen.getByLabelText('New folder name')).toBe(
      screen.getByTestId('file-tree-new-input'),
    );
  });
});
