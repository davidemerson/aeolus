// The in-app user Guide (/guide).
//
// A sticky left table-of-contents plus a single reading column. Each entry is
// its own deep-linkable route (/guide/compiling, /guide/history, …) rendered one
// section at a time, so an empty state or an error message can point straight at
// the answer. Content is authored as structured React: the bundle stays
// self-contained, with no markdown runtime and no CDN.
//
// Screenshots live in apps/web/public/guide/*.png and are captured by
// scripts/capture-guide-screenshots.mjs, which drives the real app against a
// seeded harness with invented names — never a mockup, never real user data.
// One canonical set, captured in the light theme: a guide teaches where things
// are, not what colour they are, and § Appearance under Your settings says so.
// A figure whose image is not served removes itself, so the prose has to work
// without it.
//
// This file documents ONLY what the shipped product does, verified against the
// code and a driven walkthrough. If behaviour changes, change this in the same
// pull request: a guide that describes an older version is worse than none.

import { useEffect, useState, type ReactNode } from 'react';

import { TopBar } from '../components/TopBar.js';
import { useSession } from '../lib/session.js';
import { Link, useRouter } from '../router.js';

/* ------------------------------------------------------------------ prose */

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
      {'// '}
      {children}
    </div>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="group mt-9 scroll-mt-24 text-[15px] font-semibold tracking-tight text-body"
    >
      <a href={`#${id}`} className="no-underline">
        {children}
        <span className="ml-2 font-mono text-[12px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
          #
        </span>
      </a>
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[14px] leading-relaxed text-body-2">{children}</p>;
}

function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-3 space-y-1.5 pl-5 text-[14px] leading-relaxed text-body-2 [&>li]:list-disc">
      {children}
    </ul>
  );
}

function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="mt-3 space-y-2 pl-5 text-[14px] leading-relaxed text-body-2 marker:font-mono marker:text-muted [&>li]:list-decimal">
      {children}
    </ol>
  );
}

// Inline code, key names, paths.
function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-badge bg-fill-warm px-1.5 py-0.5 font-mono text-[12px] text-body-2">
      {children}
    </code>
  );
}

// A keyboard chord. Rendered with the Cmd glyph — every binding in the app
// accepts either Cmd (macOS) or Ctrl, so both are shown once in § Shortcuts
// and the compact form is used everywhere else.
function K({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-btn-sm border border-hairline-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] text-body-2">
      {children}
    </kbd>
  );
}

/**
 * A screenshot, if there is one.
 *
 * The images are captured from a running instance by
 * `scripts/capture-guide-screenshots.mjs` and committed; a fork that has not
 * run it yet, or has just added a section, has none. Rather than leave a
 * broken image in the middle of an explanation, the whole figure removes
 * itself when the file is not served. The prose has to stand on its own
 * either way — that is the rule for writing one of these.
 */
function Shot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <figure className="mt-5">
      <div className="overflow-hidden rounded-card border border-hairline-strong bg-surface shadow-soft-lift">
        <img
          src={src}
          alt={alt}
          className="block w-full"
          loading="lazy"
          onError={() => setMissing(true)}
        />
      </div>
      <figcaption className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted">
        {'// '}
        {caption}
      </figcaption>
    </figure>
  );
}

type NoteTone = 'neutral' | 'warning' | 'info' | 'success';

function Note({ tone = 'neutral', children }: { tone?: NoteTone; children: ReactNode }) {
  const ring: Record<NoteTone, string> = {
    neutral: 'border-hairline-strong bg-paper',
    warning: 'border-warning-border bg-warning-bg-alt',
    info: 'border-info-border bg-info-bg-alt',
    success: 'border-success-border bg-success-bg-alt',
  };
  return (
    <div
      className={`mt-4 rounded-box border px-4 py-3 text-[13px] leading-relaxed text-body-2 ${ring[tone]}`}
    >
      {children}
    </div>
  );
}

function RTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-box border border-hairline">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-hairline bg-paper">
            {head.map((h) => (
              <th
                key={h}
                className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-hairline align-top last:border-0">
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-[13px] text-body-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A cross-reference to another guide section.
function See({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={`/guide/${to}`}
      className="font-mono text-[12px] text-accent-text no-underline hover:underline"
    >
      {children} →
    </Link>
  );
}

/* --------------------------------------------------------------- sections */

function Overview() {
  return (
    <>
      <P>
        Aeolus is a collaborative editor for <strong>LaTeX</strong> and <strong>Typst</strong>{' '}
        documents. You write source on the left, a compiled PDF appears on the right, and anyone you
        invite to a document can type in it at the same time as you.
      </P>
      <P>
        It is deliberately smaller than Overleaf. There are no plan tiers and no public sharing:
        someone runs this instance, an administrator creates your account, and documents are shared
        with named people.
      </P>

      <H2 id="objects">The object model</H2>
      <P>Five things, and everything else is a property of one of them:</P>
      <RTable
        head={['Thing', 'What it is']}
        rows={[
          [
            <strong key="d">Document</strong>,
            'A project, not a single file. It owns a file tree, a compiled PDF, its comments and its history. Has one engine, fixed when it is created.',
          ],
          [
            <strong key="f">File</strong>,
            <>
              A text file or an uploaded asset inside a document. Every document has one entrypoint
              — <C>main.tex</C> or <C>main.typ</C> — which is the file the compiler is pointed at.
            </>,
          ],
          [
            <strong key="t">Template</strong>,
            'An admin-curated starting point. You fork one to get a new document with the branding already in place.',
          ],
          [
            <strong key="c">Collaborator</strong>,
            <>
              Someone added to a document as <C>editor</C> or <C>viewer</C>. The person who created
              it is the owner.
            </>,
          ],
          [
            <strong key="ck">Checkpoint</strong>,
            'A named snapshot you can read and restore. Per-file, or across the whole project.',
          ],
        ]}
      />

      <H2 id="first-run">Your first ten minutes</H2>
      <OL>
        <li>
          Sign in with the email and passphrase an administrator gave you. There is no self-service
          registration — <See to="signing-in">signing in</See>.
        </li>
        <li>
          On <strong>Workspace</strong>, either fork a template or create a blank document.
          Templates are the better default if one fits, because the branding and preamble are
          already right — <See to="templates">templates</See>.
        </li>
        <li>
          Type. Your first compile fires automatically when the document opens; after that press{' '}
          <K>⌘S</K> — <See to="compiling">compiling</See>.
        </li>
        <li>
          Add the people who need it, as editor or viewer —{' '}
          <See to="collaboration">collaboration</See>.
        </li>
      </OL>
      <Shot
        src="/guide/workspace.png"
        alt="The Workspace page listing templates to fork and the active documents"
        caption="workspace — templates to fork on top, your documents below"
      />

      <H2 id="not-here">What Aeolus does not do</H2>
      <P>Said plainly, so you do not go looking:</P>
      <UL>
        <li>
          <strong>No public links.</strong> There is no way to share a document with someone outside
          the app, or to publish one read-only. Access is the collaborator list.
        </li>
        <li>
          <strong>No WYSIWYG mode.</strong> You edit source. A rich-text mode is an open request,
          not a feature.
        </li>
        <li>
          <strong>No compile-as-you-type.</strong> Compiles happen when you ask —{' '}
          <See to="compiling">why</See>.
        </li>
        <li>
          <strong>You cannot change a document&apos;s engine.</strong> Pick it at creation;
          switching means forking a template of the other engine and moving the text across.
        </li>
      </UL>
    </>
  );
}

function SigningIn() {
  return (
    <>
      <P>
        Sign-in is an <strong>email and a passphrase</strong>, checked by this instance itself.
        There is no identity provider and nothing leaves the server.
      </P>
      <P>
        Accounts are created by an administrator, who hands you a generated passphrase. The first
        time you use it the app asks you to replace it with one only you know, and nothing else in
        the app works until you do.
      </P>
      <H2 id="choosing-a-passphrase">Choosing a passphrase</H2>
      <P>
        A passphrase, not a password: at least sixteen characters, and either four or more words or
        a single string of twenty-four. There are no rules about capitals, digits or punctuation,
        because those rules produce worse secrets, and there is no expiry. Four unrelated words are
        easier to remember and much harder to guess than <C>P@ssw0rd!</C>. The setup screen offers a
        generated one if you would rather not choose.
      </P>
      <P>
        Ten wrong attempts lock the account for fifteen minutes. If you forget it there is no
        emailed reset link — a self-hosted instance may have no mail server at all. An administrator
        issues you a new one from <strong>Admin → Users</strong>, and you choose your own again at
        the next sign-in.
      </P>
      <H2 id="sessions">Staying signed in</H2>
      <P>
        A session lasts 30 days, and idles out after 12 hours without use. Signing out from the
        header ends it immediately. The session travels with the browser, so signing in on your
        laptop does not sign you in on your phone.
      </P>
    </>
  );
}

function Documents() {
  return (
    <>
      <P>
        A document is a whole project: a file tree, a compiled PDF, comments and history. Everything
        lives under <strong>Workspace</strong>.
      </P>

      <H2 id="creating">Creating one</H2>
      <P>
        <strong>New document</strong> makes an empty project. The control beside it picks the{' '}
        <strong>engine</strong> — LaTeX or Typst — and this is the one decision you cannot revise
        later, because the engine is fixed at creation. LaTeX is preselected.
      </P>
      <P>
        A blank LaTeX document starts with one file, <C>main.tex</C>; a Typst one starts with{' '}
        <C>main.typ</C>. That file is the entrypoint the compiler runs.
      </P>
      <Note tone="warning">
        Creating documents and templates is <strong>admin-only</strong>. If you do not see the{' '}
        <strong>New document</strong> button, fork a template instead — that path is open to
        everyone.
      </Note>

      <H2 id="engines">LaTeX or Typst?</H2>
      <RTable
        head={['', 'LaTeX', 'Typst']}
        rows={[
          ['Engine', 'Tectonic', 'Typst'],
          ['Entrypoint', <C key="a">main.tex</C>, <C key="b">main.typ</C>],
          [
            'Click between PDF and source',
            'Yes',
            <>
              No — Typst emits no SyncTeX data, so <strong>show in pdf</strong> and <K>⌘J</K> are
              unavailable on a Typst document
            </>,
          ],
          [
            'Best for',
            'Anything with an existing LaTeX preamble, a bibliography, or a house template',
            'New documents where you would rather not fight LaTeX',
          ],
        ]}
      />

      <H2 id="renaming">Renaming, archiving, deleting</H2>
      <P>
        Click the title in the editor to rename the document. On a Workspace card, hover (or tab to
        it) to reveal two icon buttons: archive and delete.
      </P>
      <UL>
        <li>
          <strong>Archive</strong> is reversible and makes the document read-only. Use it for things
          that are finished — <See to="archive">archiving</See>.
        </li>
        <li>
          <strong>Delete</strong> asks for confirmation and then removes it from your workspace.
        </li>
      </UL>
    </>
  );
}

function Templates() {
  return (
    <>
      <P>
        A template is a starting point an administrator has already got right: the branding, the
        preamble, the fonts, whatever every document of that kind needs. Forking one copies its
        whole file tree into a new document you own.
      </P>

      <H2 id="forking">Forking one</H2>
      <OL>
        <li>
          On <strong>Workspace</strong>, published templates appear above your documents, each with
          a <strong>fork →</strong> button.
        </li>
        <li>
          Click it. You are asked for a title; the default appends a timestamp so two forks never
          collide.
        </li>
        <li>
          <strong>Create</strong> drops you into the new document. It is yours — editing it cannot
          affect the template or anyone else&apos;s fork.
        </li>
      </OL>
      <P>
        The fork inherits the template&apos;s engine. This is the only way to get a blank Typst
        document if you are not an administrator.
      </P>

      <H2 id="publishing">Publishing one (admin)</H2>
      <P>
        Templates are created as <strong>drafts</strong> and are invisible on Workspace — including
        to administrators — until published. That is deliberate: it means the publish toggle has a
        visible effect, and a half-finished template is never offered to anyone.
      </P>
      <OL>
        <li>
          <strong>Admin → Templates</strong>, name it, pick the engine, and{' '}
          <strong>Create template</strong>. You land in its editor.
        </li>
        <li>Write the preamble and upload whatever assets it needs.</li>
        <li>
          Back on <strong>Admin → Templates</strong>, press <strong>Publish</strong>. The badge
          flips from <strong>Draft</strong> to <strong>Published</strong> and it appears on
          everyone&apos;s Workspace.
        </li>
      </OL>
      <Shot
        src="/guide/admin-templates.png"
        alt="The admin Templates page with a create form and existing templates showing Draft and Published badges"
        caption="admin → templates — create, then publish"
      />
      <Note tone="info">
        A template is edited in the ordinary document editor, so everything in this guide about
        files, compiling and history applies to it too.
      </Note>
    </>
  );
}

function Files() {
  return (
    <>
      <P>
        A document holds as many files as you like. Open the tree with <strong>files</strong> in the
        editor toolbar.
      </P>
      <Shot
        src="/guide/file-tree.png"
        alt="The files panel showing folders, text files and an uploaded image"
        caption="the files panel — text files, folders and uploaded assets"
      />

      <H2 id="entrypoint">The entrypoint is special</H2>
      <P>
        <C>main.tex</C> / <C>main.typ</C> is what the compiler runs, and it cannot be renamed or
        deleted. Every other file is reached from it the normal way for your engine —{' '}
        <C>\input{'{chapters/intro}'}</C>, <C>\includegraphics{'{images/diagram.png}'}</C>, and so
        on. Relative paths work, so a file at <C>images/diagram.png</C> is referenced at that path.
      </P>

      <H2 id="adding">Adding files</H2>
      <UL>
        <li>
          <strong>+ file</strong> and <strong>+ folder</strong> create empty ones. Type a path with
          slashes and the folders are implied.
        </li>
        <li>
          <strong>↑ file</strong> and <strong>↑ folder</strong> upload from disk. A whole folder
          keeps its structure.
        </li>
        <li>
          <strong>Drag and drop</strong> onto the panel does the same, folders included.
        </li>
      </UL>
      <P>
        Uploads accept images (<C>.png</C>, <C>.jpg</C>), <C>.pdf</C>, bibliography and class files
        (<C>.bib</C>, <C>.cls</C>, <C>.sty</C>), fonts (<C>.ttf</C>, <C>.otf</C>) and <C>.csv</C>.
        The ceiling is 25 MB per file and 200 MB per document.
      </P>
      <Note tone="warning">
        A duplicate upload does not overwrite: <C>logo.png</C> uploaded twice becomes{' '}
        <C>logo-2.png</C>. If you meant to replace the file, delete the old one first.
      </Note>

      <H2 id="editing-many">Editing more than one file</H2>
      <P>
        Click any text file to open it. Each file has its own collaborative session, so two people
        can be in different files of the same document without seeing each other&apos;s cursors —
        and both sets of edits land in the same compile.
      </P>
      <P>
        Renaming a folder rewrites the paths of everything inside it. Deleting a folder refuses
        while it still has contents, so a mis-click cannot take a chapter with it.
      </P>
    </>
  );
}

function Collaboration() {
  return (
    <>
      <P>
        Everyone in a document edits the same live text. There is no save button for prose and no
        lock: two people typing in one paragraph both keep their words.
      </P>

      <H2 id="roles">Who can do what</H2>
      <RTable
        head={['Role', 'Read', 'Edit text', 'Compile', 'Manage collaborators']}
        rows={[
          ['Owner', 'Yes', 'Yes', 'Yes', 'Yes'],
          ['editor', 'Yes', 'Yes', 'Yes', 'No'],
          ['viewer', 'Yes', 'No', 'Yes', 'No'],
          ['Administrator', 'Any document', 'Yes', 'Yes', 'Yes'],
        ]}
      />
      <P>
        The owner is whoever created the document. Administrators resolve to owner on every
        document, which is how a project survives someone leaving.
      </P>

      <H2 id="connection">The connection indicator</H2>
      <P>Beside the document title, next to the engine badge:</P>
      <RTable
        head={['Shows', 'Means']}
        rows={[
          ['Connecting…', 'Still establishing the live session. Brief on a normal load.'],
          ['Connected', 'Your edits are reaching the server.'],
          [
            'Reconnecting…',
            'The live session dropped and is being re-established. Edits queue in this tab meanwhile.',
          ],
          [
            'Offline',
            'The live session failed. Your typing is being kept in this browser only — reload before doing more work.',
          ],
        ]}
      />
      <Note tone="warning">
        If a banner tells you the session could not be authorised, <strong>reload</strong> rather
        than carrying on. Edits made while disconnected live in the tab and are not saved anywhere
        else.
      </Note>
      <P>
        A known rough edge: on a first visit the editor occasionally comes up blank. A reload fixes
        it. It is a race in the connection setup, and it is tracked.
      </P>
    </>
  );
}

function Compiling() {
  return (
    <>
      <P>
        Compiling turns your source into the PDF on the right. It runs on the server, not in your
        browser.
      </P>

      <H2 id="triggers">When it runs</H2>
      <UL>
        <li>
          <strong>When you open a document</strong>, if the existing PDF is out of date. If nothing
          has changed since the last compile, the previous PDF is shown immediately and nothing is
          re-run.
        </li>
        <li>
          <K>⌘S</K> / <K>Ctrl S</K> — the normal way. The browser&apos;s own save dialog is
          suppressed.
        </li>
        <li>
          The <strong>Compile</strong> button.
        </li>
      </UL>
      <P>
        There is deliberately <strong>no compile-as-you-type</strong>. A compile is a real process
        on a shared worker; firing one per keystroke would make the queue useless for everyone. The
        status line at the bottom left always says where you are: <C>ready</C>, <C>compiling…</C>,
        or <C>compiled · pdf ready</C>.
      </P>
      <Shot
        src="/guide/editor.png"
        alt="The editor with source on the left and the compiled PDF preview on the right"
        caption="the editor — source left, compiled PDF right"
      />

      <H2 id="errors">When it fails</H2>
      <P>
        The right pane switches itself to <strong>logs</strong> and the status line turns to the
        error. The compiler&apos;s output is parsed into a list rather than left as a wall of text:
        you get a count, each error with the line it happened on, and the first one highlighted.{' '}
        <strong>click to jump</strong> on an error puts your cursor on that line.
      </P>
      <P>
        <strong>Show raw log</strong> expands the compiler&apos;s untrimmed output for the cases the
        parser cannot help with, and <strong>Copy</strong> takes the whole thing to your clipboard —
        that is the single most useful thing to hand to whoever you ask for help.
      </P>
      <Shot
        src="/guide/compile-logs.png"
        alt="The logs tab showing a failed compile with the error and an Ask Claude to fix button"
        caption="logs — a failed compile, with Ask Claude to fix"
      />
      <P>
        <strong>Ask Claude to fix</strong> sends the error and the surrounding source for a
        suggested repair — <See to="claude">Claude</See>.
      </P>
      <Note tone="info">
        Some messages are about the deployment, not your document. If you are told an engine is not
        installed or cannot be started, that is a server problem and it says so — tell an
        administrator rather than editing your source.
      </Note>

      <H2 id="preview">The preview</H2>
      <UL>
        <li>
          <strong>pdf ✓</strong> hides and shows the preview pane; the divider between the panes can
          be dragged.
        </li>
        <li>
          <strong>↓ pdf</strong> saves the compiled PDF. It is greyed out until one exists.
        </li>
        <li>
          <strong>↓ zip</strong> downloads every file in the project.
        </li>
      </UL>

      <H2 id="synctex">Clicking between source and PDF (LaTeX only)</H2>
      <P>
        On a LaTeX document, <strong>show in pdf</strong> (or <K>⌘J</K>) jumps from the cursor to
        the matching page, and clicking a rendered page puts the cursor on the line that produced
        it.
      </P>
      <P>
        Typst emits no SyncTeX data, so the preview shows <C>synctex off</C> and the button is
        absent. That is the engine, not a fault.
      </P>
    </>
  );
}

function Comments() {
  return (
    <>
      <P>
        Comments attach to a passage of text, so a note about one sentence stays with that sentence.
      </P>
      <OL>
        <li>
          Select the text you want to talk about. This part is not optional — with nothing selected,{' '}
          <strong>+ comment</strong> tells you to select something first rather than making an
          unanchored note.
        </li>
        <li>
          Press <strong>+ comment</strong> in the toolbar.
        </li>
        <li>
          Type the note into the prompt your browser shows, and confirm. The thread appears in the
          comments panel, which opens itself.
        </li>
      </OL>
      <P>
        Each thread carries the passage it is anchored to, the note, who wrote it and when, and{' '}
        <strong>Reply</strong>, <strong>Resolve</strong> and <strong>Delete</strong>. The panel
        header counts the open ones.
      </P>
      <Shot
        src="/guide/comments.png"
        alt="The comments panel beside the editor showing a thread on a highlighted passage"
        caption="comments — anchored to the passage they are about"
      />
      <P>
        Anyone who can read the document sees the thread, and can reply. Resolving a thread hides
        it; <strong>show resolved</strong> brings resolved threads back into view.
      </P>
      <Note tone="warning">
        If the text a comment was attached to is deleted, the thread survives but its anchor no
        longer resolves, and the panel marks it as such. Nothing is lost — but the comment no longer
        points at anything, so resolve or re-anchor it.
      </Note>
    </>
  );
}

function History() {
  return (
    <>
      <P>
        <strong>history</strong> in the toolbar opens the document&apos;s history. There are two
        kinds of snapshot, and the difference matters when you restore.
      </P>
      <Shot
        src="/guide/history.png"
        alt="The history panel listing project snapshots and per-file checkpoints"
        caption="history — project snapshots above, checkpoints for the open file below"
      />

      <H2 id="kinds">Checkpoints vs project snapshots</H2>
      <RTable
        head={['', 'Checkpoint', 'Project snapshot']}
        rows={[
          ['Covers', 'The one file you have open', 'Every text file in the document'],
          [
            'Restore brings back',
            'That file, at that moment',
            'All files, plus the set of uploaded assets as it was',
          ],
          [
            'Use it when',
            'You are about to rewrite a section',
            'You are about to restructure the project',
          ],
        ]}
      />
      <H2 id="making">Making one</H2>
      <P>
        Two buttons at the top of the panel: <strong>File</strong> takes a checkpoint of the file
        named in the header, <strong>Project</strong> takes a snapshot of everything. Either asks
        for a label — up to 120 characters — and <K>Enter</K> creates it.
      </P>
      <P>
        Aeolus also takes a checkpoint quietly every time you open a file, so there is something to
        go back to even if you did not think to make one. Those are listed in italics as{' '}
        <em>Opened by …</em> and are <strong>shown by default</strong>; untick{' '}
        <strong>Show auto</strong> to hide them and leave only the ones you named.
      </P>

      <H2 id="restoring">Reading and restoring</H2>
      <OL>
        <li>Click any entry to open it read-only beside your live text.</li>
        <li>
          <strong>Restore</strong> asks you to confirm, then puts that content back.
        </li>
      </OL>
      <Note tone="info">
        Restoring is <strong>not</strong> destructive to your history: it lands as a new edit on
        top, so every checkpoint you had still exists — including one from just before the restore.
        You can undo a restore by restoring the newer entry.
      </Note>
    </>
  );
}

function Claude() {
  return (
    <>
      <P>
        Claude is wired into the editor for rewriting and for fixing compile errors. It never edits
        your document on its own: every suggestion is shown for you to accept or dismiss.
      </P>

      <H2 id="palette">The command palette</H2>
      <P>
        <K>⌘K</K> (or the <strong>llm</strong> button) opens it. Select text first — the selection
        is what Claude is given.
      </P>
      <Shot
        src="/guide/palette.png"
        alt="The Claude command palette listing preset actions over a filter box"
        caption="⌘K — presets, or your own instruction"
      />
      <P>The presets are the common jobs:</P>
      <UL>
        <li>
          <strong>Ask Claude about selection</strong> — a question rather than a rewrite.
        </li>
        <li>
          <strong>Tighten this paragraph</strong>.
        </li>
        <li>
          <strong>Clean up code</strong>.
        </li>
        <li>
          <strong>Convert to theorem environment</strong>.
        </li>
        <li>
          <strong>Fix bibliography</strong>.
        </li>
      </UL>
      <P>
        Or type your own instruction. The response streams into a panel with <strong>Accept</strong>{' '}
        and <strong>Dismiss</strong>; accepting replaces your selection.
      </P>

      <H2 id="quota">Your quota</H2>
      <P>
        The bottom right of the editor shows what you have left — <C>AI: 30/30 hr</C>. Defaults are{' '}
        <strong>30 requests an hour</strong>, <strong>200 a day</strong>, and{' '}
        <strong>50,000 tokens a day</strong>.
      </P>
      <P>
        Exceeding a limit is a plain refusal that tells you which one you hit; the hourly window
        rolls, so waiting fixes it. There is also a whole-app daily spend cap. If that trips, Claude
        is unavailable for everyone until it resets — the message says so rather than pretending
        your request was malformed.
      </P>
    </>
  );
}

function Archive() {
  return (
    <>
      <P>
        Archiving is for documents that are done. It is not deletion and it is not a permissions
        change.
      </P>
      <P>
        An archived document moves to the <strong>Archived</strong> tab on Workspace and becomes{' '}
        <strong>read-only for everyone, owner included</strong>. You can still open it, read it,
        compile it, and download the PDF or the ZIP. You cannot type in it, add files, or comment.
        The editor shows a banner saying so.
      </P>
      <P>
        Unarchive from the <strong>Archived</strong> tab and it is editable again. Nothing is lost
        in either direction.
      </P>
      <RTable
        head={['', 'Archive', 'Delete']}
        rows={[
          ['Reversible', 'Yes', 'No'],
          ['Still readable', 'Yes', 'No'],
          ['Still compiles', 'Yes', '—'],
          ['Where it goes', 'The Archived tab', 'Out of your workspace'],
        ]}
      />
    </>
  );
}

function FocusMode() {
  return (
    <>
      <P>
        Focus mode hides everything except the text: the header, both sidebars, the toolbar, the
        status line and the PDF preview all go away.
      </P>
      <P>
        Enter it with the <strong>focus</strong> button in the toolbar or <K>⌘.</K>. Leave with{' '}
        <K>Esc</K> or the <strong>exit focus</strong> button in the corner. Your text is untouched —
        it is only the chrome that hides, and your place in the document is kept.
      </P>
      <Shot
        src="/guide/focus.png"
        alt="The editor in focus mode, chrome hidden, with an exit focus button in the corner"
        caption="focus mode — Esc to leave"
      />
      <P>
        At a narrow window the toolbar collapses into a <strong>more ▾</strong> menu and the focus
        button moves inside it, along with the other secondary actions.
      </P>
    </>
  );
}

function Walkthroughs() {
  return (
    <>
      <P>The jobs people actually do, start to finish, from an empty workspace.</P>

      <H2 id="first-doc">Write and share a document</H2>
      <OL>
        <li>
          <strong>Workspace</strong>. If a template fits, press <strong>fork →</strong> on it, name
          the document, <strong>Create</strong>. Otherwise pick an engine beside{' '}
          <strong>New document</strong> and press it.
        </li>
        <li>Click the title and give it a real name.</li>
        <li>
          Write. Press <K>⌘S</K>. The PDF appears on the right; if it does not, the right pane will
          have switched to <strong>logs</strong> with the reason.
        </li>
        <li>
          Add whoever needs it as <C>editor</C>, or <C>viewer</C> for someone who should only read.
        </li>
        <li>When it is finished, archive it — it stays readable and stops being editable.</li>
      </OL>

      <H2 id="split-up">Split a long document into chapters</H2>
      <OL>
        <li>
          <strong>files</strong>, then <strong>+ folder</strong>, and make <C>chapters</C>.
        </li>
        <li>
          <strong>+ file</strong> and enter <C>chapters/intro.tex</C>. Repeat per chapter.
        </li>
        <li>
          In <C>main.tex</C>, pull each one in — <C>\input{'{chapters/intro}'}</C>.
        </li>
        <li>
          <K>⌘S</K>. The compiler sees every file in the project, not only the one you have open.
        </li>
      </OL>
      <Note tone="info">
        Before a restructure this size, take a <strong>project snapshot</strong> first — it captures
        every file at once, so one restore undoes the whole thing.
      </Note>

      <H2 id="add-figure">Add a figure</H2>
      <OL>
        <li>
          <strong>files</strong>, then <strong>↑ file</strong> (or drop the image onto the panel).
        </li>
        <li>
          Note the path it lands at — <C>diagram.png</C>, or <C>images/diagram.png</C> if you
          uploaded a folder.
        </li>
        <li>
          Reference it at that path: <C>\includegraphics{'{images/diagram.png}'}</C> for LaTeX,{' '}
          <C>#image(&quot;images/diagram.png&quot;)</C> for Typst.
        </li>
        <li>
          <K>⌘S</K>.
        </li>
      </OL>

      <H2 id="recover">Get back something you overwrote</H2>
      <OL>
        <li>
          Open the file you broke, then <strong>history</strong>.
        </li>
        <li>
          Find the entry from before the damage. If you never made one by hand, turn on{' '}
          <strong>show auto</strong> — there is an automatic checkpoint from when you opened the
          file.
        </li>
        <li>Click it to read it beside your live text and confirm it is the right one.</li>
        <li>
          <strong>Restore</strong>, and confirm. If you restored the wrong entry, restore again from
          the newer one — nothing was thrown away.
        </li>
      </OL>

      <H2 id="fix-error">Work out why a compile failed</H2>
      <OL>
        <li>
          Read the status line first. If it names an engine that is not installed or cannot be
          started, stop — that is a server problem, and an administrator needs to hear about it.
        </li>
        <li>
          Otherwise open <strong>logs</strong> and read the first error. Later errors are usually
          consequences of it.
        </li>
        <li>
          <strong>show raw log</strong> if the trimmed version is not enough.
        </li>
        <li>
          <strong>Ask Claude to fix</strong> for a suggested repair, which you accept or dismiss.
        </li>
        <li>
          A missing-file error is nearly always a path: check the file panel for where it actually
          landed.
        </li>
      </OL>
    </>
  );
}

function Settings() {
  return (
    <>
      <P>
        <strong>Settings</strong> in the header. Everything here is yours alone.
      </P>
      <Shot
        src="/guide/settings.png"
        alt="The Settings page with profile, appearance and editor theme sections"
        caption="settings — profile, appearance, editor theme"
      />

      <H2 id="profile">Profile</H2>
      <P>
        <strong>Display name</strong> is what collaborators see; edit it and press{' '}
        <strong>Save</strong>. <strong>Email</strong> is read-only here — it is the identity the app
        keys on, and an administrator changes it. <strong>Change passphrase</strong> under Security
        is where you replace your own.
      </P>

      <H2 id="appearance">Appearance</H2>
      <P>
        Light, dark, or follow your operating system. The default follows the OS. The same control
        is the half-disc mark in the header, so you can flip it from any page. Your choice is
        remembered per device you sign in from.
      </P>
      <Note tone="info">
        <strong>Screenshots in this guide are all in light theme.</strong> Every screen works in
        both; a guide is for learning where things are, so there is one canonical set rather than
        two of everything.
      </Note>

      <H2 id="editor-theme">Editor theme</H2>
      <P>
        The editor itself uses the Solarized palette. By default it follows the app&apos;s
        appearance, but you can pin it — <strong>Solarized dark</strong> or{' '}
        <strong>Solarized light</strong> — if you want a dark editor beside a light interface, or
        the reverse. This one is saved to the browser rather than your account.
      </P>
    </>
  );
}

function Admin() {
  return (
    <>
      <P>
        <strong>Admin</strong> appears in the header for administrators only. Four surfaces.
      </P>

      <H2 id="users">Users</H2>
      <P>
        Every account, with when it was last seen. You can promote and demote administrators,
        disable an account (an immediate lock — every request from them fails, including loading
        their own profile), re-enable it, rename someone, and delete an account.
      </P>
      <Shot
        src="/guide/admin-users.png"
        alt="The admin Users table with promote, disable and delete controls"
        caption="admin → users"
      />
      <Note tone="info">
        Deleting a user <strong>transfers every document they owned to you</strong>, in the same
        operation — drafts included. Offboarding someone never destroys their work.
      </Note>

      <H2 id="admin-templates">Templates</H2>
      <P>
        Create, edit, publish and delete the branded starting points, and see drafts —{' '}
        <See to="templates">templates</See>.
      </P>

      <H2 id="audit">Audit log</H2>
      <P>
        The last 30 days of activity, filterable by kind: authentication, documents, templates,
        administration. Each row carries who, what, when, and the address the request came from.
      </P>
      <Shot
        src="/guide/admin-audit.png"
        alt="The admin audit log with a filter and rows of recorded actions"
        caption="admin → audit log"
      />

      <H2 id="diagnostics">Diagnostics</H2>
      <P>
        For answering &quot;is compiling broken, or is it my document?&quot;.{' '}
        <strong>Run smoke compile</strong> pushes a tiny document through the same queue, worker and
        engine that a user compile takes, and reports each step — including a persistence self-check
        that proves the text reached the database before the worker read it. Run this first when
        several people report compile trouble.
      </P>
      <P>
        <strong>Mint bot session</strong> issues a long-lived, non-rotating session for operator
        tooling. It predates the API and is now for local debugging only — if you want to drive
        Aeolus from a script, mint a token at <strong>Tokens</strong> and use <C>/api/v1</C>{' '}
        instead. A token is scoped, individually revocable, rate-limited and audited; a bot session
        is none of those. Revoke one by deleting its row from <C>sessions</C>.
      </P>
      <Shot
        src="/guide/admin-diagnostics.png"
        alt="The Smoke compile card showing a failed run: the engine is not installed on the worker, plus the persistence self-check figures"
        caption="admin → diagnostics — a failed run, saying plainly that it is the deployment"
      />
      <P>
        The capture above is a <em>failing</em> run, because that is the case worth recognising: the
        engine was missing on the worker, and the result says so in those words rather than leaving
        you to decode an errno. A healthy run reports <C>status: success</C> with an elapsed time
        and a PDF key.
      </P>
      <P>
        Below both cards is a live <strong>Snapshot</strong> — queue depth, compiles in the last
        hour by status, the most recent jobs, and any persistence errors the collaboration server
        has recorded. <strong>Refresh</strong> re-reads it.
      </P>
    </>
  );
}

function Shortcuts() {
  return (
    <>
      <P>
        Every chord takes <K>⌘</K> on macOS or <K>Ctrl</K> elsewhere.
      </P>
      <RTable
        head={['Keys', 'Does', 'Where']}
        rows={[
          [<K key="s">⌘S</K>, 'Compile. Suppresses the browser save dialog.', 'Editor'],
          [<K key="k">⌘K</K>, 'Open the Claude command palette.', 'Editor'],
          [
            <K key="j">⌘J</K>,
            'Jump from the cursor to the matching PDF page. LaTeX only.',
            'Editor',
          ],
          [<K key="d">⌘.</K>, 'Toggle focus mode.', 'Editor'],
          [<K key="esc">Esc</K>, 'Leave focus mode; close the palette.', 'Editor'],
          [
            <K key="a">⌘A</K>,
            'Select the whole document. Works even when focus is on a toolbar button rather than the text.',
            'Editor',
          ],
        ]}
      />
      <Note tone="info">
        There is no shortcut that deletes anything, and none that compiles automatically.
      </Note>
    </>
  );
}

function RefTables() {
  return (
    <>
      <H2 id="compile-states">Compile status</H2>
      <RTable
        head={['Status line', 'Means']}
        rows={[
          [<C key="a">ready</C>, 'No compile has run yet this session.'],
          [<C key="b">compiling…</C>, 'Queued or running on the worker.'],
          [<C key="c">compiled · pdf ready</C>, 'Succeeded; the preview is current.'],
          [
            'An error message',
            'Failed. The right pane has switched to logs with the compiler output.',
          ],
        ]}
      />

      <H2 id="conn-states">Connection status</H2>
      <RTable
        head={['Shows', 'Means']}
        rows={[
          ['Connecting…', 'Establishing the live session.'],
          ['Connected', 'Edits are reaching the server.'],
          ['Reconnecting…', 'Dropped; retrying on its own.'],
          ['Offline', 'Not saving. Reload.'],
        ]}
      />

      <H2 id="file-kinds">File kinds</H2>
      <RTable
        head={['Kind', 'What it is', 'Editable here']}
        rows={[
          ['text', 'Source you type in — .tex, .typ, .bib, .cls, .sty', 'Yes'],
          ['folder', 'A grouping. Deleting one refuses while it has contents.', '—'],
          ['blob', 'An uploaded asset — image, PDF, font, CSV', 'No, replace it'],
        ]}
      />

      <H2 id="limits">Limits</H2>
      <RTable
        head={['Limit', 'Value']}
        rows={[
          ['Upload, per file', '25 MB'],
          ['Upload, per document', '200 MB'],
          ['Claude requests per hour', '30'],
          ['Claude requests per day', '200'],
          ['Claude tokens per day', '50,000'],
          ['Checkpoint label', '120 characters'],
          ['Session, absolute', '30 days'],
          ['Session, idle', '12 hours'],
          ['Audit log retention shown', '30 days'],
        ]}
      />

      <H2 id="roles-table">Roles</H2>
      <RTable
        head={['Role', 'Granted by', 'Can edit']}
        rows={[
          ['Owner', 'Creating the document', 'Yes'],
          ['editor', 'The owner adding you', 'Yes'],
          ['viewer', 'The owner adding you', 'No'],
          ['Administrator', 'Another administrator', 'Every document'],
        ]}
      />
    </>
  );
}

function Troubleshooting() {
  return (
    <>
      <H2 id="blank">The editor came up blank</H2>
      <P>
        Reload. This is a known race in the live-session setup on a first visit, and a reload
        reliably fixes it. If a reload does not, check the connection indicator beside the title —
        if it says <C>error</C>, the live session is failing rather than the page.
      </P>

      <H2 id="not-saving">Are my changes being saved?</H2>
      <P>
        Look at the indicator beside the title. <C>Connected</C> means yes, continuously — there is
        no save button for text. If it reads <C>Offline</C>, or a banner says the session could not
        be authorised, then no: reload before typing anything else.
      </P>

      <H2 id="no-pdf">I pressed compile and nothing happened</H2>
      <OL>
        <li>
          If the status line reads <C>compiled · pdf ready</C> but the pane looks empty, the preview
          may be hidden — check <strong>pdf ✓</strong> in the toolbar.
        </li>
        <li>
          If it names a missing or unstartable engine, that is the server. Tell an administrator; an
          administrator can confirm with <strong>Admin → Diagnostics → Run smoke compile</strong>.
        </li>
        <li>
          Otherwise open <strong>logs</strong> and read the first error.
        </li>
      </OL>

      <H2 id="missing-file">&quot;File not found&quot; but I uploaded it</H2>
      <P>
        Nearly always the path. Open <strong>files</strong> and check where it actually landed — an
        uploaded folder keeps its structure, so the file may be at <C>images/diagram.png</C> and not{' '}
        <C>diagram.png</C>. Also check you are not referencing a duplicate: a second upload of the
        same name became <C>…-2.png</C>.
      </P>

      <H2 id="cant-edit">I cannot type in a document</H2>
      <UL>
        <li>
          <strong>Is it archived?</strong> There is a banner if so. Unarchive it from the{' '}
          <strong>Archived</strong> tab.
        </li>
        <li>
          <strong>Are you a viewer?</strong> Viewers read and compile; they do not edit. The owner
          can change your role.
        </li>
        <li>
          <strong>Is the connection in error?</strong> Then nothing you type is being saved. Reload.
        </li>
      </UL>

      <H2 id="no-typst">I cannot make a Typst document</H2>
      <P>
        Creating blank documents is admin-only. Fork a Typst template instead — if there is not one,
        an administrator has to publish it. And an existing document&apos;s engine cannot be
        switched: fork a template of the other engine and move the text.
      </P>

      <H2 id="no-jump">Clicking the PDF does not move my cursor</H2>
      <P>
        Check the engine badge. This works on LaTeX only — Typst produces no SyncTeX data, and the
        preview says <C>synctex off</C>.
      </P>

      <H2 id="claude-refused">Claude refused my request</H2>
      <P>
        Read which limit it names. A per-hour limit rolls, so waiting clears it. If it says the
        whole-app cap is reached, Claude is off for everyone until it resets. If it says nothing was
        selected, select the text first — the selection is what gets sent.
      </P>

      <H2 id="lost-comment">A comment is not pointing at anything</H2>
      <P>
        The text it was anchored to was deleted. The thread is intact and the panel marks the anchor
        as stale. Read it, then resolve it or make a fresh comment on the replacement text.
      </P>

      <H2 id="who-to-ask">Nothing here covers it</H2>
      <P>
        Tell an administrator what you did, what you expected, and what the status line said. If it
        is a compile problem, the <strong>logs</strong> tab has a <strong>Copy</strong> button —
        that output is the most useful thing you can hand over.
      </P>
    </>
  );
}

function Automation() {
  return (
    <>
      <P>
        Aeolus has a REST API, so a script can do what you do: file a draft, sync a chapter in,
        compile on merge, pull the PDF. It lives on this same address under <C>/api/v1</C>.
      </P>

      <H2 id="api-token">Get a token</H2>
      <P>
        <strong>Tokens</strong> in the header. Give it a name that says what will use it, choose{' '}
        <strong>read</strong> or <strong>read &amp; write</strong>, and copy the value{' '}
        <em>then and there</em> — it is shown once and stored only as a hash, so nobody can recover
        it for you afterwards. Send it as <C>Authorization: Bearer aeolus_…</C> on every request.
      </P>
      <Note tone="warning">
        <strong>A token acts as you.</strong> It carries your document permissions, so anything you
        can reach it can reach, and every change it makes is recorded under your name. Mint the
        narrowest scope that does the job, and revoke one the moment its job is over. Anyone signed
        in can see and revoke any token, deliberately — a token writes to shared documents, so
        revoking must never wait on one person being reachable.
      </Note>

      <H2 id="api-scope">Scope is not permission</H2>
      <P>
        These are two separate gates and both apply. <strong>Scope</strong> is about the credential:
        a read token is refused on any write, whoever minted it. <strong>Permission</strong> is the
        document ACL: a write token minted by someone with viewer access still cannot edit that
        document. A write-scope token is not a promotion.
      </P>

      <H2 id="api-reference">The reference</H2>
      <P>
        Open <C>/api/v1/reference</C> for a browsable reference you can read in a browser, or{' '}
        <C>/api/v1/openapi.json</C> to point a client generator at it. Both are readable without a
        token — needing a credential to read the page that explains how to get one would be a
        circle. The description is generated from the same definitions the server validates against,
        so it cannot describe something the API does not do.
      </P>
      <P>
        Longer prose, including the parts worth reading twice — how a Claude request reports a
        failure once it has started streaming, and why the collaboration ticket needs a write token
        — lives in <C>docs/API.md</C> in the repository.
      </P>

      <H2 id="api-limits">Limits</H2>
      <UL>
        <li>
          <strong>120 requests a minute</strong> per token. Past that you get <C>429</C> and a{' '}
          <C>retry-after</C> header. Compiling and downloading a project zip are capped far lower,
          at six a minute, because each is a whole machine-minute or a whole project loaded into
          memory.
        </li>
        <li>
          <strong>Claude quota is per person, not per token.</strong> A batch job spends the same
          allowance you spend in the editor. Check <C>/api/v1/ai/quota</C> before starting one.
        </li>
      </UL>
    </>
  );
}

/* --------------------------------------------------------------- registry */

interface GSection {
  slug: string;
  title: string;
  blurb: string;
  body: () => ReactNode;
}
interface GGroup {
  label: string;
  items: GSection[];
}

const GROUPS: GGroup[] = [
  {
    label: 'Getting started',
    items: [
      {
        slug: 'overview',
        title: 'Overview & mental model',
        blurb: 'What Aeolus is and how the pieces fit',
        body: Overview,
      },
      {
        slug: 'signing-in',
        title: 'Signing in',
        blurb: 'Passphrases, lockout, sessions',
        body: SigningIn,
      },
    ],
  },
  {
    label: 'Concepts',
    items: [
      {
        slug: 'documents',
        title: 'Documents & engines',
        blurb: 'Creating one, LaTeX vs Typst, renaming',
        body: Documents,
      },
      {
        slug: 'templates',
        title: 'Templates',
        blurb: 'Forking a branded start; publishing one',
        body: Templates,
      },
      {
        slug: 'files',
        title: 'Files & the file tree',
        blurb: 'Multi-file projects, uploads, the entrypoint',
        body: Files,
      },
      {
        slug: 'collaboration',
        title: 'Collaboration',
        blurb: 'Live editing, roles, the connection indicator',
        body: Collaboration,
      },
      {
        slug: 'compiling',
        title: 'Compiling & the PDF',
        blurb: 'Triggers, logs, source↔PDF jumps',
        body: Compiling,
      },
      {
        slug: 'comments',
        title: 'Comments',
        blurb: 'Anchored threads, resolving, stale anchors',
        body: Comments,
      },
      {
        slug: 'history',
        title: 'History & restoring',
        blurb: 'Checkpoints, project snapshots, undoing a restore',
        body: History,
      },
      {
        slug: 'claude',
        title: 'Claude',
        blurb: 'The command palette, fixing errors, quota',
        body: Claude,
      },
      {
        slug: 'archive',
        title: 'Archiving',
        blurb: 'Read-only, reversible, not deletion',
        body: Archive,
      },
      {
        slug: 'focus',
        title: 'Focus mode',
        blurb: 'Hide everything but the text',
        body: FocusMode,
      },
    ],
  },
  {
    label: 'How-to',
    items: [
      {
        slug: 'walkthroughs',
        title: 'Step-by-step walkthroughs',
        blurb: 'The common jobs, numbered',
        body: Walkthroughs,
      },
      {
        slug: 'settings',
        title: 'Your settings',
        blurb: 'Display name, appearance, editor theme',
        body: Settings,
      },
    ],
  },
  {
    label: 'Automation',
    items: [
      {
        slug: 'api',
        title: 'The API',
        blurb: 'Tokens, scope, the reference, limits',
        body: Automation,
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        slug: 'admin',
        title: 'Admin surfaces',
        blurb: 'Users, templates, audit log, diagnostics',
        body: Admin,
      },
    ],
  },
  {
    label: 'Reference',
    items: [
      {
        slug: 'shortcuts',
        title: 'Keyboard shortcuts',
        blurb: 'All six of them',
        body: Shortcuts,
      },
      {
        slug: 'tables',
        title: 'Reference tables',
        blurb: 'Statuses, file kinds, limits, roles',
        body: RefTables,
      },
      {
        slug: 'troubleshooting',
        title: 'Troubleshooting / FAQ',
        blurb: '"Is it saving?" and friends',
        body: Troubleshooting,
      },
    ],
  },
];

const FLAT: GSection[] = GROUPS.flatMap((g) => g.items);

export function guideSlugs(): string[] {
  return FLAT.map((s) => s.slug);
}

/* ------------------------------------------------------------- page shell */

function Toc({ slug }: { slug: string }) {
  return (
    <nav className="mt-3 space-y-5 lg:mt-0" aria-label="Guide contents">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <Eyebrow>{g.label}</Eyebrow>
          <ul className="mt-1.5 space-y-0.5">
            {g.items.map((s) => {
              const active = s.slug === slug;
              return (
                <li key={s.slug}>
                  <Link
                    to={`/guide/${s.slug}`}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-badge px-2 py-1 text-[13px] no-underline transition-colors ${
                      active
                        ? 'bg-fill-warm font-medium text-body'
                        : 'text-body-2 hover:bg-page hover:text-body'
                    }`}
                  >
                    {s.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function GuideRoute({ section }: { section?: string }) {
  const session = useSession();
  const { path } = useRouter();
  const slug = section && FLAT.some((s) => s.slug === section) ? section : 'overview';
  const current = FLAT.find((s) => s.slug === slug)!;
  const idx = FLAT.findIndex((s) => s.slug === slug);
  const prev = idx > 0 ? FLAT[idx - 1] : null;
  const next = idx < FLAT.length - 1 ? FLAT[idx + 1] : null;

  // Top of the section on navigation, unless the URL names an anchor.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const el = document.getElementById(hash);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        return;
      }
    }
    window.scrollTo({ top: 0 });
  }, [path]);

  return (
    <>
      {/* The guide is readable while signed out — a lost user may be looking at
          the login page. TopBar renders its signed-out shape when user is null. */}
      <TopBar user={session.status === 'authenticated' ? session.user : null} />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Eyebrow>guide</Eyebrow>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-body">Aeolus guide</h1>

        {/* Mobile: the TOC collapses into a disclosure. */}
        <details className="mb-5 mt-6 rounded-card border border-hairline bg-surface p-4 lg:hidden">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-widest text-body-2">
            {'// '}contents
          </summary>
          <Toc slug={slug} />
        </details>

        <div className="mt-6 flex gap-8">
          <aside className="hidden w-60 shrink-0 lg:block">
            <div className="sticky top-6">
              <Toc slug={slug} />
            </div>
          </aside>

          <article className="min-w-0 flex-1">
            <div className="rounded-card border border-hairline bg-surface p-6 shadow-soft-lift sm:p-8">
              <Eyebrow>{current.title.toLowerCase()}</Eyebrow>
              <h2 className="mt-1 text-lg font-semibold tracking-tight text-body">
                {current.title}
              </h2>
              <p className="mt-1 text-[13px] text-muted">{current.blurb}</p>
              <div className="mt-3 border-t border-hairline" />
              {current.body()}
            </div>

            <nav className="mt-6 flex items-stretch justify-between gap-3">
              {prev ? (
                <Link
                  to={`/guide/${prev.slug}`}
                  className="flex-1 rounded-box border border-hairline bg-surface px-4 py-3 no-underline transition-colors hover:border-accent-border"
                >
                  <Eyebrow>prev</Eyebrow>
                  <div className="mt-0.5 text-[14px] text-body-2">{prev.title}</div>
                </Link>
              ) : (
                <span className="flex-1" />
              )}
              {next ? (
                <Link
                  to={`/guide/${next.slug}`}
                  className="flex-1 rounded-box border border-hairline bg-surface px-4 py-3 text-right no-underline transition-colors hover:border-accent-border"
                >
                  <Eyebrow>next</Eyebrow>
                  <div className="mt-0.5 text-[14px] text-body-2">{next.title}</div>
                </Link>
              ) : (
                <span className="flex-1" />
              )}
            </nav>
          </article>
        </div>
      </main>
    </>
  );
}
