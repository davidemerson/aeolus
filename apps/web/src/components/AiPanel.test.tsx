import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AiPanel, AiQuotaIndicator } from './AiPanel.js';
import { setUnauthenticatedHandler } from '../lib/api.js';

afterEach(() => {
  cleanup();
  setUnauthenticatedHandler(null);
  vi.unstubAllGlobals();
});

// One SSE frame per (event, data) pair, exactly as the API writes them.
function sse(frames: [string, unknown][]): string {
  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

function streamResponse(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Two chunks so the parser exercises its line-buffer path.
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function stubAssist(responder: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u === '/api/ai/assist') return responder();
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPanel(onAccept: (text: string) => void = () => {}) {
  return render(
    <AiPanel
      docId="doc-1"
      selection="\\section{Intro}"
      instruction="Tighten this"
      onAccept={onAccept}
      onDismiss={() => {}}
    />,
  );
}

describe('AiPanel', () => {
  it('keeps the error state and never offers Accept when the stream reports an error', async () => {
    stubAssist(() =>
      streamResponse(
        sse([
          ['chunk', { text: 'partial ' }],
          ['error', { error: 'Hourly quota exhausted' }],
        ]),
      ),
    );
    renderPanel();

    const err = await waitFor(() => screen.getByTestId('ai-error'));
    expect(err.textContent).toBe('Hourly quota exhausted');
    // Give the read loop time to reach end-of-stream, where the old code
    // downgraded error → done.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('ai-error').textContent).toBe('Hourly quota exhausted');
    expect(screen.queryByTestId('ai-accept')).toBeNull();
  });

  it('shows Accept after a clean stream and hands the full text to onAccept', async () => {
    stubAssist(() =>
      streamResponse(
        sse([
          ['chunk', { text: 'Hello ' }],
          ['chunk', { text: 'world' }],
          ['done', {}],
        ]),
      ),
    );
    const onAccept = vi.fn();
    renderPanel(onAccept);

    const accept = await waitFor(() => screen.getByTestId('ai-accept'));
    fireEvent.click(accept);
    expect(onAccept).toHaveBeenCalledWith('Hello world');
    expect(screen.queryByTestId('ai-error')).toBeNull();
  });

  it('announces streamed output through a polite live region', async () => {
    stubAssist(() =>
      streamResponse(
        sse([
          ['chunk', { text: 'x' }],
          ['done', {}],
        ]),
      ),
    );
    renderPanel();
    expect(screen.getByTestId('ai-response').getAttribute('aria-live')).toBe('polite');
    await waitFor(() => screen.getByTestId('ai-accept'));
  });

  it('routes a 401 from the raw SSE fetch through the global unauthenticated hook', async () => {
    stubAssist(
      () =>
        new Response(JSON.stringify({ error: 'unauthenticated', message: 'Not signed in' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const onUnauth = vi.fn();
    setUnauthenticatedHandler(onUnauth);
    renderPanel();
    await waitFor(() => screen.getByTestId('ai-error'));
    expect(onUnauth).toHaveBeenCalledTimes(1);
  });
});

describe('AiQuotaIndicator', () => {
  it('names Claude, reads as a sentence, and explains the allowance in the tooltip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ hourly: { used: 2, limit: 30 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    render(<AiQuotaIndicator />);
    const quota = await waitFor(() => screen.getByTestId('ai-quota'));
    expect(quota.textContent).toBe('Claude: 28 of 30 this hour');
    expect(quota.getAttribute('title')).toMatch(/allowance of 30 an hour/);
  });
});
