import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('viral_school.db');

// Add your actual friends' handles here
const friends = [
  { handle: 'Gursharan Singh', grade: 11, avatar: '😎', password: 'gursharn123' },
  { handle: 'Piyush', grade: 11, avatar: '🔥', password: 'piyush123' },
  { handle: 'Harsh Pawar', grade: 11, avatar: '🦊', password: 'harsh123' },
  { handle: 'Altaf', grade: 11, avatar: '👑', password: 'altaf2002' }
];

const insert = db.prepare('INSERT INTO users (handle, password, grade, avatar, invite_code) VALUES (?, ?, ?, ?, ?)');

db.transaction(() => {
  for (const f of friends) {
    try {
      const hash = bcrypt.hashSync(f.password, 10);
      const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      insert.run(f.handle, hash, f.grade, f.avatar, inviteCode);
      console.log(`✅ Created @${f.handle} (Password: ${f.password})`);
    } catch (err) {
      console.log(`⚠️ Skipped @${f.handle} (Already exists)`);
    }
  }
})();

console.log("🚀 Class 11 Seed Complete! The app is now fully playable.");