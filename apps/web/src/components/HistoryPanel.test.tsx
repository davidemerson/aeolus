import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HistoryPanel } from './HistoryPanel.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      // /project-checkpoints has to match before /checkpoints
      // (substring would otherwise match both).
      if (u.includes('/project-checkpoints')) {
        return new Response(JSON.stringify({ project_checkpoints: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/checkpoints')) {
        return new Response(
          JSON.stringify({
            checkpoints: [
              {
                id: 'cp1',
                label: 'Q1 & Q2 <draft>',
                created_by: 'u1',
                created_at: '2026-05-01T12:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

describe('HistoryPanel label rendering', () => {
  it('renders labels as literal text without HTML entity escaping', async () => {
    render(<HistoryPanel docId="doc1" canWrite={false} currentFile={null} onPreview={() => {}} />);
    const item = await waitFor(() => screen.getByTestId('history-item-btn'));
    // React already escapes JSX text children. Manual escapeHtml() on
    // top would have produced "Q1 &amp; Q2 &lt;draft&gt;" in the DOM.
    expect(item.textContent).toContain('Q1 & Q2 <draft>');
    expect(item.textContent).not.toContain('&amp;');
    expect(item.textContent).not.toContain('&lt;');
  });
});

describe('HistoryPanel project snapshot actions', () => {
  const PROJECT = {
    id: 'pc1',
    label: 'Before the rewrite',
    file_count: 3,
    created_by: 'u1',
    created_at: '2026-05-02T09:00:00Z',
  };

  function installFetch(onDelete: () => Response | Promise<Response>): {
    calls: { url: string; method: string }[];
  } {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        const method = init?.method ?? 'GET';
        calls.push({ url: u, method });
        if (method === 'DELETE') return onDelete();
        if (u.includes('/project-checkpoints')) {
          return new Response(JSON.stringify({ project_checkpoints: [PROJECT] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/checkpoints')) {
          return new Response(JSON.stringify({ checkpoints: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    return { calls };
  }

  it('delete asks to confirm and only calls the API after confirm', async () => {
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    render(<HistoryPanel docId="doc1" canWrite={true} currentFile={null} onPreview={() => {}} />);
    const del = await waitFor(() => screen.getByTestId('project-delete-pc1'));

    fireEvent.click(del);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    // The inline confirm replaces the row actions; focus is on Cancel.
    expect(screen.getByText('Delete this snapshot? This cannot be undone.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('project-delete-pc1-cancel'));

    fireEvent.click(screen.getByTestId('project-delete-pc1-confirm'));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    });
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(
      '/api/docs/doc1/project-checkpoints/pc1',
    );
  });

  it('cancelling the delete confirm makes no request', async () => {
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    render(<HistoryPanel docId="doc1" canWrite={true} currentFile={null} onPreview={() => {}} />);
    fireEvent.click(await waitFor(() => screen.getByTestId('project-delete-pc1')));
    fireEvent.click(screen.getByTestId('project-delete-pc1-cancel'));
    expect(screen.queryByTestId('project-delete-pc1-confirm')).toBeNull();
    expect(screen.getByTestId('project-delete-pc1')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('disables the confirm buttons while the request is in flight', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    installFetch(
      () =>
        new Promise<Response>((resolve) => {
          gate.release = () => resolve(new Response(null, { status: 204 }));
        }),
    );
    render(<HistoryPanel docId="doc1" canWrite={true} currentFile={null} onPreview={() => {}} />);
    fireEvent.click(await waitFor(() => screen.getByTestId('project-delete-pc1')));
    fireEvent.click(screen.getByTestId('project-delete-pc1-confirm'));

    await waitFor(() => {
      const confirm = screen.getByTestId('project-delete-pc1-confirm') as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      expect(confirm.textContent).toBe('Deleting…');
    });
    expect((screen.getByTestId('project-delete-pc1-cancel') as HTMLButtonElement).disabled).toBe(
      true,
    );
    gate.release?.();
    await waitFor(() => {
      expect(screen.queryByTestId('project-delete-pc1-confirm')).toBeNull();
    });
  });

  it('restore also confirms inline before posting', async () => {
    const { calls } = installFetch(() => new Response(null, { status: 204 }));
    render(<HistoryPanel docId="doc1" canWrite={true} currentFile={null} onPreview={() => {}} />);
    fireEvent.click(await waitFor(() => screen.getByTestId('project-restore-pc1')));
    expect(screen.getByText('Restore every file to this snapshot?')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(screen.getByTestId('project-restore-pc1-confirm').textContent).toBe('Restore all');
  });
});

describe('HistoryPanel empty state', () => {
  it('says the filter is hiding checkpoints when only auto ones exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('/project-checkpoints')) {
          return new Response(JSON.stringify({ project_checkpoints: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            checkpoints: [
              {
                id: 'auto1',
                label: 'Opened by Ada',
                kind: 'auto_open',
                created_by: 'u1',
                created_at: '2026-05-01T12:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    render(<HistoryPanel docId="doc1" canWrite={false} currentFile={null} onPreview={() => {}} />);
    await waitFor(() => screen.getByTestId('history-list'));
    expect(screen.queryByTestId('history-empty')).toBeNull();

    fireEvent.click(screen.getByTestId('history-show-auto'));
    expect(screen.getByTestId('history-empty').textContent).toBe(
      'Auto checkpoints are hidden. Turn on Show auto to see them.',
    );
  });

  it('says "No checkpoints yet." when there are none at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        const body = u.includes('/project-checkpoints')
          ? { project_checkpoints: [] }
          : { checkpoints: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    render(<HistoryPanel docId="doc1" canWrite={false} currentFile={null} onPreview={() => {}} />);
    const empty = await waitFor(() => screen.getByTestId('history-empty'));
    expect(empty.textContent).toBe('No checkpoints yet.');
  });
});
