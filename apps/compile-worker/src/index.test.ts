import { describe, expect, it } from 'vitest';

import { COMPILE_QUEUE_NAME } from './index.js';

describe('@aeolus/compile-worker', () => {
  it('has a stable queue name', () => {
    expect(COMPILE_QUEUE_NAME).toBe('aeolus.compile');
  });
});
