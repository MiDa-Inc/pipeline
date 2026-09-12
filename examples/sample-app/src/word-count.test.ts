import { describe, expect, it } from 'vitest';

import { formatCounts, wordCount } from './word-count.js';

describe('wordCount', () => {
  it('counts words case-insensitively and ignores punctuation', () => {
    expect([...wordCount('The cat, the CAT!')]).toEqual([
      ['the', 2],
      ['cat', 2],
    ]);
  });

  it('returns nothing for text without words', () => {
    expect(wordCount('  ... ').size).toBe(0);
  });
});

describe('formatCounts', () => {
  it('sorts by count, then alphabetically', () => {
    expect(formatCounts(wordCount('b a a'))).toBe('2\ta\n1\tb');
  });
});
