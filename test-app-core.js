import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, escapeHtml, isValidBackup, uniqueNames } from './app-core.js';

test('escapeHtml protects rendered student names', () => {
  assert.equal(escapeHtml('<Ali & "Siti">'), '&lt;Ali &amp; &quot;Siti&quot;&gt;');
});

test('csvCell protects formulas and quotes', () => {
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell('Ali "Samad"'), '"Ali ""Samad"""');
});

test('uniqueNames strips list numbers and removes duplicates', () => {
  assert.deepEqual(uniqueNames('1. Ali\nAli\n2) Siti\nSiti', ['Ali']), ['Siti']);
});

test('backup validator accepts supported backup shape', () => {
  assert.equal(isValidBackup({ app: 'Hadir Wajah', students: [], attendance: {} }), true);
  assert.equal(isValidBackup({ app: 'Other', students: [], attendance: {} }), false);
});
