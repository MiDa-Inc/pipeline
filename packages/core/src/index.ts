/** Schema, validation, engine, run log, verdict parser and templates. */
export type { Verdict } from './verdict.js';
export { parseVerdict } from './verdict.js';
export * from './runlog/index.js';
export * from './skeleton/index.js';

export const packageName = '@pipeline/core';
