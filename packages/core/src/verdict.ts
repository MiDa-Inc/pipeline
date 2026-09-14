/**
 * The verdict parser (SPEC R5).
 *
 * **Callers must supply turn-attributable text.** Parsing establishes nothing about ownership or
 * completion: it cannot tell whose turn a line belongs to, and a `missing` result is not evidence
 * that a turn finished without answering. Handed a shared, unbounded capture, this function will
 * happily return a previous turn's verdict, because the last matching line is all it looks for.
 * Establishing that the text belongs to the current turn, and that the turn is complete, is the
 * runtime's and the engine's job (SPEC R5 "Verdict ownership", R12).
 *
 * The parser assumes no normalisation beyond that. Terminal decoration is stripped here, because
 * captures arrive with it attached.
 */

export type Verdict = 'approve' | 'revise' | 'missing';

/**
 * Decoration stripped from the **ends** of a line, never from inside it (SPEC R5 step 1):
 * horizontal whitespace; the glyphs U+2022 `•`, U+23FA `⏺`, U+276F `❯`, U+203A `›`, U+2514 `└`,
 * U+23BF `⎿` and `|`; and every character in the box-drawing block U+2500-U+257F.
 */
const DECORATION = /[ \t\u2022\u23FA\u276F\u203A\u2514\u23BF|\u2500-\u257F]/u;

/**
 * The remainder must match this exactly (SPEC R5 step 2): case-sensitive, the separator may be
 * empty, and nothing may follow. `VERDICT : APPROVE` fails because the space precedes the colon.
 */
const VERDICT_LINE = /^VERDICT:[ \t]*(APPROVE|REVISE)$/;

const stripDecoration = (line: string): string => {
  let start = 0;
  let end = line.length;
  while (start < end && DECORATION.test(line.charAt(start))) start += 1;
  while (end > start && DECORATION.test(line.charAt(end - 1))) end -= 1;
  return line.slice(start, end);
};

/**
 * The outcome named by the **last** verdict line in `output`, or `missing` if it holds none.
 *
 * Lines are split on LF, CRLF or a lone CR. That is line segmentation, which R5 does not define,
 * and it is deliberately kept separate from decoration stripping: a carriage return is not in R5's
 * strip set, so it is consumed as a line ending and never trimmed from a line's end.
 */
export function parseVerdict(output: string): Verdict {
  let verdict: Verdict = 'missing';
  for (const line of output.split(/\r\n|[\n\r]/)) {
    const matched = VERDICT_LINE.exec(stripDecoration(line))?.[1];
    if (matched !== undefined) verdict = matched === 'APPROVE' ? 'approve' : 'revise';
  }
  return verdict;
}
