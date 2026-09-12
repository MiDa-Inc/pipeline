import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@pipeline/server', () => {
  it('reports its own package name', () => {
    expect(packageName).toBe('@pipeline/server');
  });
});
