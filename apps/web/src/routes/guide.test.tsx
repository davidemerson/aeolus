import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { GuideRoute, guideSlugs } from './guide.js';
import { RouterProvider } from '../router.js';

// The session hook talks to /api/me; the guide is readable signed out, so the
// anonymous shape is the one that matters most here.
vi.mock('../lib/session.js', () => ({
  useSession: () => ({ status: 'anonymous' as const }),
}));

// TopBar pulls in the appearance context and an avatar; none of that is what
// these tests are about.
vi.mock('../components/TopBar.js', () => ({
  TopBar: () => <header data-testid="topbar-stub" />,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

function renderGuide(section?: string) {
  return render(
    <RouterProvider>
      <GuideRoute section={section} />
    </RouterProvider>,
  );
}

describe('GuideRoute', () => {
  // The TOC is rendered twice — once in the mobile <details>, once in the
  // desktop <aside> — so a bare getByText matches the two nav links as well as
  // the heading. Query the heading role: TOC entries are links, not headings.
  it('renders the overview when no section is named', () => {
    renderGuide();
    expect(
      screen.getAllByRole('heading', { name: 'Overview & mental model' }).length,
    ).toBeGreaterThan(0);
  });

  // A bad slug must not blank the page — an out-of-date deep link from an old
  // error message or bookmark should still land somewhere useful.
  it('falls back to the overview for an unknown section', () => {
    renderGuide('does-not-exist');
    expect(
      screen.getAllByRole('heading', { name: 'Overview & mental model' }).length,
    ).toBeGreaterThan(0);
  });

  it('renders each registered section without throwing', () => {
    // Every section is authored prose; a typo in one of them (a bad
    // component reference, an unclosed element) should fail here rather than
    // 404-ing a reader who deep-links into it.
    for (const slug of guideSlugs()) {
      const { unmount } = renderGuide(slug);
      expect(screen.getAllByRole('heading', { name: titleFor(slug) }).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('exposes every section in the table of contents', () => {
    renderGuide('overview');
    for (const slug of guideSlugs()) {
      expect(screen.getAllByText(titleFor(slug)).length).toBeGreaterThan(0);
    }
  });

  // The screenshot manifest. A committed <img> whose file is missing renders a
  // broken image in the middle of the page, which is worse than no screenshot —
  // and the failure is invisible in a diff. This asserts the referenced set
  // matches what the guide asks for; the files themselves live in
  // apps/web/public/guide/ and are asserted by brand-assets-style presence
  // checks in the E2E run.
  it('references only screenshots under /guide/', () => {
    for (const slug of guideSlugs()) {
      const { container, unmount } = renderGuide(slug);
      for (const img of container.querySelectorAll('img')) {
        const src = img.getAttribute('src') ?? '';
        expect(src.startsWith('/guide/')).toBe(true);
        expect(src.endsWith('.png')).toBe(true);
        // Alt text is not decorative here: these images carry the "where is
        // it" information for anyone who cannot see them.
        expect((img.getAttribute('alt') ?? '').length).toBeGreaterThan(10);
      }
      unmount();
    }
  });

  it('keeps the section slugs url-safe and unique', () => {
    const slugs = guideSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
});

// Mirrors the registry's titles without exporting the registry itself.
function titleFor(slug: string): string {
  const map: Record<string, string> = {
    overview: 'Overview & mental model',
    'signing-in': 'Signing in',
    documents: 'Documents & engines',
    templates: 'Templates',
    files: 'Files & the file tree',
    collaboration: 'Collaboration',
    compiling: 'Compiling & the PDF',
    comments: 'Comments',
    history: 'History & restoring',
    claude: 'Claude',
    archive: 'Archiving',
    focus: 'Focus mode',
    walkthroughs: 'Step-by-step walkthroughs',
    settings: 'Your settings',
    api: 'The API',
    admin: 'Admin surfaces',
    shortcuts: 'Keyboard shortcuts',
    tables: 'Reference tables',
    troubleshooting: 'Troubleshooting / FAQ',
  };
  const title = map[slug];
  if (!title) throw new Error(`guide.test.tsx has no title for slug "${slug}" — add it`);
  return title;
}
