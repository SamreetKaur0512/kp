import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { normalizeName, findUserByName, passwordMatches } from '../auth.js';

const legacyDb = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, salt TEXT, hash TEXT);
    INSERT INTO users(name, salt, hash) VALUES('Alice', 'salt', 'hash');
  `);
  return db;
};

test('legacy registrations can still be found when login uses a different case', () => {
  const db = legacyDb();
  const user = findUserByName(db, 'alice');
  assert.ok(user);
  assert.equal(user.name, 'Alice');
});

test('names are normalized consistently', () => {
  assert.equal(normalizeName('  Alice  '), 'alice');
  assert.equal(normalizeName('  ALICE '), 'alice');
});
