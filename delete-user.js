import Database from 'better-sqlite3';

const db = new Database('viral_school.db');
const targetHandle = process.argv[2];

if (!targetHandle) {
  console.log("❌ Usage: node delete-user.js <handle>");
  process.exit(1);
}

const user = db.prepare('SELECT id FROM users WHERE handle = ?').get(targetHandle);

if (!user) {
  console.log(`❌ User @${targetHandle} not found in the database.`);
  process.exit(1);
}

// Wrap in a transaction so if one part fails, the whole deletion cancels
db.transaction(() => {
  // 1. Delete all handshakes related to their votes
  db.prepare(`
    DELETE FROM handshakes 
    WHERE vote_id IN (SELECT id FROM votes WHERE voter_id = ? OR receiver_id = ?)
  `).run(user.id, user.id);

  // 2. Delete all votes they cast or received
  db.prepare('DELETE FROM votes WHERE voter_id = ? OR receiver_id = ?').run(user.id, user.id);

  // 3. Delete their profile
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
})();

console.log(`✅ User @${targetHandle} and all their votes have been permanently wiped.`);