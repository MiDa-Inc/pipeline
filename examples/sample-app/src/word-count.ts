/** Counts how often each word occurs, ignoring case and punctuation. */
export function wordCount(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/** Renders a word count as `<count>\t<word>` lines, most frequent first. */
export function formatCounts(counts: Map<string, number>): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word, count]) => `${count}\t${word}`)
    .join('\n');
}
