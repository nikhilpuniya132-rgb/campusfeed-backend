import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('viral_school.db');
const targetHandle = process.argv[2];
const newPassword = process.argv[3];

if (!targetHandle || !newPassword) {
  console.log("❌ Usage: node reset.js <handle> <new_password>");
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE handle = ?').get(targetHandle);
if (!user) {
  console.log(`❌ User @${targetHandle} not found!`);
  process.exit(1);
}

const hashedPassword = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE users SET password = ? WHERE handle = ?').run(hashedPassword, targetHandle);

console.log(`✅ Password for @${targetHandle} successfully changed to: ${newPassword}`);