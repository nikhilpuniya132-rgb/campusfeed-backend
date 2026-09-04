import Database from 'better-sqlite3';
const db = new Database('viral_school.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT UNIQUE NOT NULL,
    grade INTEGER NOT NULL,
    avatar TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    referred_by TEXT,
    invites_earned INTEGER DEFAULT 0,
    bio TEXT DEFAULT '' -- NEW: 50 word limit handled on frontend
  );

  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    is_crush_poll BOOLEAN DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER,
    voter_id INTEGER,
    receiver_id INTEGER,
    status TEXT DEFAULT 'locked',
    is_saved BOOLEAN DEFAULT 0, -- NEW: Prevents auto-deletion
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- NEW: 30-day timer
    FOREIGN KEY(poll_id) REFERENCES polls(id),
    FOREIGN KEY(voter_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS handshakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vote_id INTEGER,
    sender_id INTEGER,
    receiver_id INTEGER,
    status TEXT DEFAULT 'pending' 
  );
`);

const count = db.prepare('SELECT count(*) AS c FROM polls').get();
if (count.c === 0) {
  const insert = db.prepare('INSERT INTO polls (question, is_crush_poll) VALUES (?, ?)');
  const defaultPolls = [
    ["Biggest drip in this class", 0],
    ["Most likely to become a millionaire", 0],
    ["My secret crush", 1],
    ["Best smile", 0],
    ["Always understands the math homework", 0]
  ];
  db.transaction((polls) => { for (const p of polls) insert.run(p[0], p[1]); })(defaultPolls);
}

export default db;