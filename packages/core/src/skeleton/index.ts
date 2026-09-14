export type { SkeletonAgent, SkeletonConfig, SkeletonGate } from './config.js';
export { ConfigError, loadSkeletonConfig, parseSkeletonConfig } from './config.js';

export type { SkeletonOutcome, SkeletonRun, UnsupportedReason } from './engine.js';
export { runSkeleton, UnsupportedPath } from './engine.js';
