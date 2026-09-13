import { Card } from '@aeolus/shared/ui';

import { Link } from '../router.js';

export function NotFoundRoute() {
  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <Card title="Page not found">
        <p className="text-sm text-muted">The page you requested doesn&apos;t exist.</p>
        <Link to="/docs" className="mt-4 inline-block text-sm font-medium text-body underline">
          Back to documents
        </Link>
      </Card>
    </main>
  );
}
