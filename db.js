import Database from 'better-sqlite3';
const db = new Database('viral_school.db');

// Base tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT UNIQUE NOT NULL,
    grade INTEGER NOT NULL,
    avatar TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    referred_by TEXT,
    invites_earned INTEGER DEFAULT 0,
    bio TEXT DEFAULT '',
    city TEXT DEFAULT 'Bathinda',
    feed_drops INTEGER DEFAULT 0,
    referral_rewarded BOOLEAN DEFAULT 0,
    institute TEXT DEFAULT 'Kapil Institute',
    coaching_hub TEXT DEFAULT 'Ajit Road Hub',
    stream TEXT DEFAULT '11th Medical'
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
    is_saved BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

// Safe column migrations for existing SQLite databases
const safeAddColumn = (colDef) => {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${colDef}`);
  } catch (_) {}
};

safeAddColumn("city TEXT DEFAULT 'Bathinda'");
safeAddColumn("feed_drops INTEGER DEFAULT 0");
safeAddColumn("referral_rewarded BOOLEAN DEFAULT 0");
safeAddColumn("institute TEXT DEFAULT 'Kapil Institute'");
safeAddColumn("coaching_hub TEXT DEFAULT 'Ajit Road Hub'");
safeAddColumn("stream TEXT DEFAULT '11th Medical'");

// Seed or augment tuition-focused polls
const count = db.prepare('SELECT count(*) AS c FROM polls').get();
const tuitionPolls = [
  ["Always sleeps through 5 PM Physics?", 0],
  ["Most likely to crack NEET on the first attempt?", 0],
  ["Spends more time at the Maggi point than in class?", 0],
  ["Solves HC Verma questions during recess?", 0],
  ["Has handwritten formula cheat sheets everyone borrows?", 0],
  ["Sells their Allen/Aakash test series analysis for samosas?", 0],
  ["Secret crush in the coaching batch", 1],
  ["Biggest drip at Ajit Road", 0],
  ["Most likely to become an AIIMS doctor", 0]
];

if (count.c === 0) {
  const insert = db.prepare('INSERT INTO polls (question, is_crush_poll) VALUES (?, ?)');
  db.transaction((polls) => {
    for (const p of polls) insert.run(p[0], p[1]);
  })(tuitionPolls);
} else {
  // Insert any tuition polls that do not already exist
  const checkPoll = db.prepare('SELECT id FROM polls WHERE question = ?');
  const insertPoll = db.prepare('INSERT INTO polls (question, is_crush_poll) VALUES (?, ?)');
  for (const p of tuitionPolls) {
    if (!checkPoll.get(p[0])) {
      try {
        insertPoll.run(p[0], p[1]);
      } catch (_) {}
    }
  }
}

export default db;