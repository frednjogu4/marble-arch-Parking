const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('./db');

test('production database seeds only an administrator with a configured password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-production-'));
  const oldEnv = process.env.NODE_ENV;
  const oldPassword = process.env.SEED_ADMIN_PASSWORD;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.SEED_ADMIN_PASSWORD;
    await assert.rejects(openDatabase(path.join(dir, 'parking.db')), /SEED_ADMIN_PASSWORD/);
    process.env.SEED_ADMIN_PASSWORD = 'correct-horse-battery-staple';
    const db = await openDatabase(path.join(dir, 'parking.db'));
    assert.deepEqual(db.prepare('SELECT username FROM users').all(), [{ username: 'admin' }]);
    db.close();
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldPassword === undefined) delete process.env.SEED_ADMIN_PASSWORD; else process.env.SEED_ADMIN_PASSWORD = oldPassword;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
