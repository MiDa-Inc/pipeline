import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@pipeline/runtime', () => {
  it('reports its own package name', () => {
    expect(packageName).toBe('@pipeline/runtime');
  });
});
