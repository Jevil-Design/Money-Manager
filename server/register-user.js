/* Create a user and print an API token.  Usage: npm run register -- you@example.com "Your Name" */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const email = process.argv[2];
const name = process.argv[3] || '';
if (!email) {
  console.error('Usage: npm run register -- you@example.com "Your Name"');
  process.exit(1);
}

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'money-manager.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const token = crypto.randomBytes(24).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const now = new Date().toISOString();
const id = crypto.randomBytes(9).toString('hex');

const existing = db.prepare('SELECT id FROM user WHERE email = ?').get(email);
if (existing) {
  db.prepare('UPDATE user SET token_hash = ?, name = ?, updated_at = ? WHERE id = ?').run(tokenHash, name, now, existing.id);
  console.log(`Rotated the token for ${email}.`);
} else {
  db.prepare('INSERT INTO user (id, email, name, token_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, email, name, tokenHash, now, now);
  console.log(`Created ${email}.`);
}

console.log('\nAPI token (store it now — only its hash is kept):\n');
console.log('  ' + token + '\n');
console.log('Paste it into the app: Settings → Cloud backup & sync → API token.');
