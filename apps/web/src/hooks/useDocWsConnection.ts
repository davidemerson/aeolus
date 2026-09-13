import { useEffect, useRef, useState, type RefObject } from 'react';

import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { wsBaseUrl } from '../lib/runtime-config.js';
import { editorThemeExtension, setEditorTheme, type EditorThemeName } from '../lib/editor-theme.js';
import { collabUserFor } from '../lib/collab-colors.js';
import { api } from '../lib/api.js';
import { commentsHighlightExtensions } from '../lib/comments-decoration.js';
import { useSession } from '../lib/session.js';
import {
  attachTicketRefresh,
  type MintResult,
  type TicketRefreshHandle,
} from '../lib/ws-ticket.js';

// 'reconnecting' is a disconnect after a session had been established; the
// provider retries on its own, so the indicator says so instead of reverting
// to the first-load wording.
export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface AuthFailed {
  reason: string;
  closeCode: number;
}

export interface UseDocWsConnectionOptions {
  docId: string;
  // Switching files tears the editor down + rebuilds against a
  // different yjs_doc_id. null = main entrypoint (back-compat).
  currentFileId: string | null;
  // null = active doc, ISO timestamp = archived. Drives the editor's
  // read-only state.
  archivedAt: string | null;
  docLoaded: boolean;
  // Theme change re-mounts the EditorView (CodeMirror has no clean
  // hot-swap path for the theme extension).
  editorThemeName: EditorThemeName;
  /** The app's resolved polarity — what `auto` means right now. */
  appIsDark: boolean;
  // Container the EditorView attaches to. Caller renders it.
  editorHostRef: RefObject<HTMLDivElement | null>;
}

export interface UseDocWsConnectionResult {
  // Live Y.Doc held by the editor effect. Exposed so child
  // components (CommentsPanel) can subscribe to its sub-types.
  // Bumped via setYdoc so re-mount on file switch propagates.
  ydoc: Y.Doc | null;
  wsStatus: WsStatus;
  // Set when the connection is genuinely unrecoverable: the server
  // rejected a freshly-minted ticket (1008), or the ticket mint
  // itself came back 403/404 (access revoked / doc deleted). The
  // route surfaces a "reload required" banner when this is non-null.
  // Stale-ticket rejections never land here — they re-mint and retry
  // (see lib/ws-ticket.ts).
  authFailed: AuthFailed | null;
  // The mounted EditorView. Read by AI / comments / synctex
  // handlers in the route to reach the current selection.
  editorViewRef: RefObject<EditorView | null>;
}

// Owns the y-websocket + Y.Doc + EditorView lifecycle for a single
// open doc/file pair. Extracted from doc-editor.tsx (issue #46) —
// the route had ~150 lines of provider-mount-and-cleanup logic
// inline; pulling it here means the route reads as composition
// instead of a setup script.
export function useDocWsConnection(opts: UseDocWsConnectionOptions): UseDocWsConnectionResult {
  const { docId, currentFileId, archivedAt, docLoaded, editorThemeName, appIsDark, editorHostRef } =
    opts;
  const session = useSession();
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [authFailed, setAuthFailed] = useState<AuthFailed | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  // The live provider, so the theme effect below can re-publish the
  // collaborator colour for the new ground without a remount.
  const providerRef = useRef<WebsocketProvider | null>(null);
  // Who this tab is, for remote carets (#68). Read from the session at
  // mount; the awareness field is (re)set below.
  const me = session.status === 'authenticated' ? session.user : null;
  // The connect effect below reads the theme and identity only to seed the
  // editor and the awareness field; later changes are applied in place by
  // the theme effect. Carrying them through a ref keeps them out of the
  // connect effect's dependencies honestly, instead of omitting them with
  // a comment — listing them would remount the editor (and reconnect the
  // collaborative session) on every appearance toggle.
  const initial = useRef({ editorThemeName, appIsDark, me });
  useEffect(() => {
    initial.current = { editorThemeName, appIsDark, me };
  }, [editorThemeName, appIsDark, me]);

  useEffect(() => {
    if (session.status !== 'authenticated' || !docLoaded) return;
    const {
      editorThemeName: themeAtMount,
      appIsDark: darkAtMount,
      me: meAtMount,
    } = initial.current;
    const host = editorHostRef.current;
    // Unreachable under React 18's commit-then-effect ordering (the host
    // div is rendered unconditionally once authenticated, and refs attach
    // during commit). #55 shipped a console probe here in May 2026 that
    // never fired in four months; the probes are gone, the guard stays.
    if (!host) return;

    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    setYdoc(doc);
    // A remount (file switch, theme-driven session change) starts a
    // fresh connection with a fresh ticket — don't keep a stale
    // banner latched across it.
    setAuthFailed(null);

    // Where ws lives, from the config the server stamped into the page — not
    // a build-time constant, so one image serves any hostname. Defaults to
    // this origin at /ws, which is what the compose stack's reverse proxy and
    // the Vite dev proxy both provide.
    const wsUrl = wsBaseUrl();

    // Browsers don't send api's host-only session cookie to the ws
    // subdomain, so cookie auth on the upgrade fails silently. Fetch
    // a ticket from api first (cookie-gated, same origin) and pass it
    // on the WS URL. Tickets are bound to this docId and multi-use
    // for 5 minutes; attachTicketRefresh below re-mints at half-TTL
    // and around reconnects so the provider never re-dials with an
    // expired one (POST /api/ws/ticket).
    let provider: WebsocketProvider | null = null;
    let ticketRefresh: TicketRefreshHandle | null = null;
    let view: EditorView | null = null;
    let cancelled = false;

    const mintTicket = async (): Promise<MintResult> => {
      const t = await api.post<{ ticket: string; expires_at: string }>('/ws/ticket', {
        doc_id: docId,
      });
      return { ticket: t.ticket, expiresAtMs: Date.parse(t.expires_at) };
    };

    // Wait for the ticket round-trip before the provider opens.
    // Until it lands the WS status reads "connecting"; if minting
    // fails (no session, doc 404, network) the editor flips to
    // "error" instead of silently churning forever.
    void (async () => {
      try {
        const initialTicket = await mintTicket();
        if (cancelled) return;
        // Pass fileId on the URL when the user has a non-main file
        // open. The ws upgrade resolves it to that file's
        // yjs_doc_id; without fileId the upgrade defaults to the
        // project's main entrypoint (back-compat).
        const wsParams: Record<string, string> = {
          docId,
          ticket: initialTicket.ticket,
        };
        if (currentFileId) wsParams.fileId = currentFileId;
        provider = new WebsocketProvider(wsUrl, '', doc, {
          params: wsParams,
          connect: true,
        });
        providerRef.current = provider;
        // Name + colour for this tab's caret in everyone else's editor
        // (#68). y-codemirror.next reads `state.user`; without it every
        // participant is the same cyan "Anonymous". Deterministic per
        // user id, so a person is one colour to the whole room and
        // across reloads; the variant follows the editor ground.
        if (meAtMount) {
          provider.awareness.setLocalStateField('user', collabUserFor(meAtMount, darkAtMount));
        }
        provider.on('status', ({ status: next }: { status: string }) => {
          if (next === 'connected') setWsStatus('connected');
          else if (next === 'disconnected') {
            setWsStatus((prev) =>
              prev === 'connected' || prev === 'reconnecting' ? 'reconnecting' : 'connecting',
            );
          }
        });
        provider.on('connection-error', () => setWsStatus('error'));

        // Keeps provider.params.ticket fresh across reconnects
        // (half-TTL timer, close events, tab wake) and decides when a
        // 1008 close is genuinely unrecoverable: only rejections of
        // just-minted tickets latch the banner — stale-ticket
        // rejections re-mint and retry. Stopping the provider on
        // terminal matters: retrying forever just hides edits in the
        // local Y.Doc without them ever reaching the server.
        ticketRefresh = attachTicketRefresh(provider, initialTicket, {
          mint: mintTicket,
          // The route renders a persistent banner with a Reload button
          // from authFailed; no toast on top of it — the same event
          // announced twice, once transiently, only muddies it.
          onTerminal: ({ reason, closeCode }) => {
            setWsStatus('error');
            setAuthFailed({ reason, closeCode });
          },
        });

        // LaTeX/stex highlighting is the default for both engines
        // today (Typst's grammar lands later). The theme below
        // colours stex tokens via the standard Lezer tag set; when
        // lang-typst lands we swap StreamLanguage(stex) for it
        // without touching the theme.
        const state = EditorState.create({
          doc: ytext.toString(),
          extensions: [
            lineNumbers(),
            // Soft-wrap long lines at the editor's current width.
            // Prose-heavy LaTeX/Typst sources routinely run past any
            // sensible viewport; without this the editor scrolls
            // horizontally on every paragraph. CodeMirror's wrapping
            // breaks at whitespace first and only fragments a token
            // when a single word exceeds the line, and re-flows on
            // host resize, so the split-pane drag stays responsive.
            EditorView.lineWrapping,
            // Undo/redo go through the Yjs UndoManager that yCollab
            // wires by default — CodeMirror's local history() would
            // produce a *new* Y.Text edit on Cmd+Z instead of
            // reversing the prior one, so we drop history() and
            // historyKeymap entirely and use yUndoManagerKeymap.
            keymap.of([...defaultKeymap, ...yUndoManagerKeymap]),
            StreamLanguage.define(stex),
            yCollab(ytext, provider.awareness),
            ...commentsHighlightExtensions(),
            // In a Compartment so the theme can be swapped in place. This used
            // to be a plain extension with editorThemeName in the effect deps,
            // which meant a colour change tore down the EditorView — and with
            // it the Y.Doc and the yjs WebSocket. See lib/editor-theme.ts.
            editorThemeExtension(themeAtMount, darkAtMount),
            // Archived docs are read-only at the API surface
            // (assertCanWrite throws DocArchivedError → 422). Mirror
            // that in the editor so the user can't even type — server
            // would reject persists, the local Y.Doc would diverge.
            ...(archivedAt !== null ? [EditorState.readOnly.of(true)] : []),
          ],
        });
        view = new EditorView({ state, parent: host });
        editorViewRef.current = view;
      } catch {
        if (!cancelled) setWsStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      editorViewRef.current = null;
      providerRef.current = null;
      setYdoc(null);
      if (view) view.destroy();
      if (ticketRefresh) ticketRefresh.detach();
      if (provider) provider.destroy();
      doc.destroy();
    };
    // currentFileId IS in the deps because switching files is the
    // legitimate reason to tear down + reopen on a different
    // yjs_doc_id. The cleanup below disposes the previous Y.Doc
    // and provider, and the next pass loads the freshly-selected
    // file's content.
    //
    // editorThemeName and appIsDark are read through `initial` above and
    // are deliberately not dependencies. They used to be, with the note
    // that CodeMirror "doesn't support hot-swapping a theme extension
    // cleanly without losing the local view state". A Compartment is
    // exactly that mechanism, and the view state is untouched — so a
    // theme change is a dispatch (the effect below) instead of a full
    // remount that also destroyed the Y.Doc and reconnected the
    // collaborative WebSocket.
    //
    // That mattered enough to fix: with the editor following the app's
    // theme, remount-on-change would mean the appearance toggle kicks
    // you off the session mid-sentence.
  }, [docId, session.status, docLoaded, currentFileId, archivedAt, editorHostRef]);

  // Theme changes: reconfigure in place. Runs on the app flipping polarity
  // (including the OS flipping while the setting is `auto`) and on the user
  // choosing an explicit editor theme.
  useEffect(() => {
    const view = editorViewRef.current;
    if (view) setEditorTheme(view, editorThemeName, appIsDark);
    // The caret colour has a variant per ground; re-publish it so the
    // room sees the one that reads on the new polarity.
    const provider = providerRef.current;
    if (provider && me) provider.awareness.setLocalStateField('user', collabUserFor(me, appIsDark));
  }, [editorThemeName, appIsDark, me]);

  return { ydoc, wsStatus, authFailed, editorViewRef };
}
