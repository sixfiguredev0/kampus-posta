import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFirstPage } from '../app/list-merge.mjs';

const row = uid => ({ id: 'm' + uid, uid, epoch: '7' });
const range = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => row(from - i));

test('first-page refresh keeps pages loaded with "Зареди още" and their cursor', () => {
  const loaded = range(50, 1); // two pages loaded, nothing more on the server
  const result = mergeFirstPage(loaded, null, { messages: range(52, 28), cursor: { before: 28, epoch: '7' } });
  assert.deepEqual(result.rows.map(r => r.uid), range(52, 1).map(r => r.uid));
  assert.equal(result.cursor, null);
});

test('first-page refresh with only one page loaded keeps continuity after new mail arrives', () => {
  const result = mergeFirstPage(range(50, 26), { before: 26, epoch: '7' }, { messages: range(51, 27), cursor: { before: 27, epoch: '7' } });
  assert.deepEqual(result.rows.map(r => r.uid), range(51, 26).map(r => r.uid));
  assert.deepEqual(result.cursor, { before: 26, epoch: '7' });
});

test('UIDVALIDITY change or an empty refresh replaces the list', () => {
  const changed = { messages: [{ ...row(3), epoch: '8' }], cursor: null };
  assert.equal(mergeFirstPage(range(50, 1), null, changed).rows.length, 1);
  assert.equal(mergeFirstPage(range(5, 1), null, { messages: [], cursor: null }).rows.length, 0);
});
