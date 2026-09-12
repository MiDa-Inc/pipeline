import { describe, expect, it } from 'vitest';

import { packageName } from './index.js';

describe('@pipeline/cli', () => {
  it('reports its own package name', () => {
    expect(packageName).toBe('@pipeline/cli');
  });
});
