import { formatCounts, wordCount } from './word-count.js';

const text = process.argv.slice(2).join(' ');
console.log(formatCounts(wordCount(text)));
