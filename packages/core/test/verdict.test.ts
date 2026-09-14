import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseVerdict, type Verdict } from '../src/verdict.js';

const fixtures = fileURLToPath(new URL('./fixtures/agent-output/', import.meta.url));
const samples = readdirSync(fixtures)
  .flatMap((agent) =>
    readdirSync(`${fixtures}${agent}`).map((sample) => `${agent}/${sample}` as const),
  )
  .sort();
const read = (sample: string, file: string): string =>
  readFileSync(`${fixtures}${sample}/${file}`, 'utf8');
const expected = (sample: string): Verdict =>
  (JSON.parse(read(sample, 'meta.json')) as { expected_verdict: Verdict }).expected_verdict;

describe('real captures from step 04', () => {
  it('covers all twelve samples', () => {
    expect(samples).toHaveLength(12);
  });

  it.each(samples)('parses %s to the verdict its own answer gave', (sample) => {
    // both captures of the same turn: an answer does not change verdict by being read again
    expect(parseVerdict(read(sample, 'read.stdout'))).toBe(expected(sample));
    expect(parseVerdict(read(sample, 'read-later.stdout'))).toBe(expected(sample));
  });

  it('never takes a verdict from the echoed instruction alone', () => {
    // captures where the prompt's own instruction is visible but the agent answered no verdict:
    // the only VERDICT text present is the quoted instruction, and it must not count
    const echoedOnly = samples.filter(
      (s) => expected(s) === 'missing' && read(s, 'read.stdout').includes('VERDICT: APPROVE'),
    );
    expect(echoedOnly).toEqual(['claude/blocked', 'codex/blocked']); // never vacuous
    for (const sample of echoedOnly) {
      expect(parseVerdict(read(sample, 'read.stdout'))).toBe('missing');
    }
  });
});

describe('the verdict line syntax', () => {
  it.each([
    ['VERDICT:APPROVE', 'approve'], // the separator may be empty
    ['VERDICT: APPROVE', 'approve'],
    ['VERDICT:   APPROVE', 'approve'],
    ['VERDICT:\tAPPROVE', 'approve'],
    ['VERDICT: REVISE', 'revise'],
    ['VERDICT:\t \tREVISE', 'revise'],
  ] as const)('accepts %j', (line, verdict) => {
    expect(parseVerdict(line)).toBe(verdict);
  });

  it.each([
    ['VERDICT : APPROVE'], // the space precedes the colon, so the remainder does not match
    ['verdict: approve'], // matching is case-sensitive
    ['Verdict: Approve'],
    ['VERDICT: approve'],
    ['VERDICT: APPROVED'], // a further word disqualifies the line
    ['VERDICT: APPROVE.'],
    ['VERDICT: APPROVE now'],
    ['"VERDICT: APPROVE"'],
    ['VERDICT: APPROVE REVISE'],
    ['VERDICT:'],
    ['VERDICT: MAYBE'],
    ['The reviewer will answer VERDICT: APPROVE at the end.'], // mid-sentence never counts
    ['  "VERDICT: APPROVE" or "VERDICT: REVISE".'], // the echoed instruction, verbatim from SPEC R5
  ])('rejects %j', (line) => {
    expect(parseVerdict(line)).toBe('missing');
  });
});

describe('decoration', () => {
  it.each([
    ['• VERDICT: APPROVE'],
    ['⏺ VERDICT: APPROVE'],
    ['❯ VERDICT: APPROVE'],
    ['› VERDICT: APPROVE'],
    ['└ VERDICT: APPROVE'],
    ['⎿  VERDICT: APPROVE'],
    ['| VERDICT: APPROVE |'],
    ['│ VERDICT: APPROVE │'], // U+2502, inside the box-drawing block
    ['├─── VERDICT: APPROVE ───┤'],
    ['\t  ⏺ │ VERDICT: APPROVE │  \t'],
    ['╿VERDICT: APPROVE╿'], // U+257F, the last character of the block
    ['─VERDICT: APPROVE─'], // U+2500, the first
  ])('strips %j from both ends', (line) => {
    expect(parseVerdict(line)).toBe('approve');
  });

  it('strips only at the ends, never inside', () => {
    expect(parseVerdict('VERDICT: APP│ROVE')).toBe('missing');
    expect(parseVerdict('VERD•ICT: APPROVE')).toBe('missing');
    expect(parseVerdict('VERDICT: APPROVE │ VERDICT: REVISE')).toBe('missing');
  });

  it('ignores a line that is nothing but decoration', () => {
    expect(parseVerdict('────────\nVERDICT: REVISE\n│││')).toBe('revise');
  });
});

describe('several verdicts', () => {
  it.each([
    ['VERDICT: APPROVE\nVERDICT: REVISE', 'revise'],
    ['VERDICT: REVISE\nVERDICT: APPROVE', 'approve'],
    ['VERDICT: REVISE\nVERDICT: APPROVE\nVERDICT: REVISE', 'revise'],
  ] as const)('takes the last one in %j', (output, verdict) => {
    expect(parseVerdict(output)).toBe(verdict);
  });

  it('takes the last valid line, not the last line mentioning a verdict', () => {
    expect(parseVerdict('VERDICT: REVISE\nVERDICT: APPROVED\nnot a verdict line')).toBe('revise');
  });

  it('is unaffected by the instruction echoed above the answer', () => {
    const capture = [
      'Finish your reply with exactly one line, either',
      '  "VERDICT: APPROVE" or "VERDICT: REVISE".',
      '',
      '⏺ The retry loop looks correct.',
      '',
      '  VERDICT: APPROVE',
    ].join('\n');
    expect(parseVerdict(capture)).toBe('approve');
  });
});

describe('boundaries', () => {
  it.each([
    ['', 'missing'],
    ['\n\n\n', 'missing'],
    ['   \t  ', 'missing'],
    ['no verdict anywhere in this reply', 'missing'],
    ['  VERDICT: APPROVE  ', 'approve'],
    ['VERDICT: APPROVE\n', 'approve'], // a trailing newline leaves an empty final line
  ] as const)('parses %j to %s', (output, verdict) => {
    expect(parseVerdict(output)).toBe(verdict);
  });

  it.each(['\n', '\r\n', '\r'])('segments lines on %j', (eol) => {
    expect(parseVerdict(`prelude${eol}VERDICT: REVISE${eol}coda`)).toBe('revise');
  });

  it('is pure: the same input always parses the same way', () => {
    const capture = 'VERDICT: REVISE\nVERDICT: APPROVE';
    expect(parseVerdict(capture)).toBe(parseVerdict(capture));
  });
});
