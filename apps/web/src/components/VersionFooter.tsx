// Version stamp (minor-app standard 2026-07-02): every page ends
// with `aeolus · rev <sha12>` so "what exactly is deployed here?"
// is answerable without opening the console. __GIT_SHA__ is a Vite
// define — the 12-hex short commit baked in by CI (see
// Dockerfile.api / deploy-api.yml); 'dev' when building locally.
export function VersionFooter() {
  return (
    <footer className="py-5 text-center font-mono text-[10px] tracking-[.08em] text-muted print:hidden">
      aeolus · rev <span className="text-body-2">{__GIT_SHA__}</span>
    </footer>
  );
}
