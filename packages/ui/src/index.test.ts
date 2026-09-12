import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@pipeline/ui', () => {
  it('reports its own package name', () => {
    expect(packageName).toBe('@pipeline/ui');
  });
});
