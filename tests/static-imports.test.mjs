import assert from 'node:assert/strict';
import test from 'node:test';
import { staticImports } from '../scripts/static-imports.mjs';

test('vendor graph follows static imports and shared re-exports, including multiline statements', () => {
  const source = `
import './side-effect.js';
import value from './default.js';
import {
  foo as bar,
} from './named.js';
export { decodeSvgText } from './shared/svg-text.js';
export * from './all.js';
export * as codecs from './codecs.js';
export {
  first, second as renamed,
} from './more.js';
export { decodeSvgText } from './shared/svg-text.js';
export const message = 'ordinary text';
export function example() { return import('./dynamic.js'); }
`;
  assert.deepEqual(staticImports(source), ['./side-effect.js', './default.js', './named.js',
    './shared/svg-text.js', './all.js', './codecs.js', './more.js']);
});
