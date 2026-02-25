/**
 * TypeForge — Backend Server
 * ──────────────────────────
 * Express + PostgreSQL + bcrypt (username/password auth)
 * Deploy on Render.com
 */

require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcrypt');
const { Pool }   = require('pg');
const pgSession  = require('connect-pg-simple')(session);
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 12;

// ─── DATABASE ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(morgan('combined'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'typeforge-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
}));

// ─── AUTH HELPERS ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function getUser(userId) {
  const { rows } = await pool.query(
    'SELECT id, username, created_at FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

// Sign Up
app.post('/auth/signup', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  if (username.length < 3 || username.length > 30)
    return res.status(400).json({ error: 'Username must be 3–30 characters.' });

  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores.' });

  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exists.rows.length > 0)
      return res.status(409).json({ error: 'Username already taken. Please choose another.' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    req.session.userId = rows[0].id;
    res.json({ user: { id: rows[0].id, username: rows[0].username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Log In
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required.' });

  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    if (rows.length === 0)
      return res.status(401).json({ error: 'Incorrect username or password.' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Incorrect username or password.' });

    req.session.userId = rows[0].id;
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [rows[0].id]);
    res.json({ user: { id: rows[0].id, username: rows[0].username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Log Out
app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Current user
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const user = await getUser(req.session.userId);
    res.json({ user });
  } catch (err) {
    res.json({ user: null });
  }
});

// ─── PARAGRAPHS API ──────────────────────────────────────────────────────────
app.get('/api/paragraphs/:examId', async (req, res) => {
  try {
    const { examId } = req.params;
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      `SELECT id, text, source FROM paragraphs
       WHERE exam_id = $1 AND date_assigned = $2
       ORDER BY id LIMIT 10`,
      [examId, today]
    );
    if (rows.length === 0) {
      const { rows: bank } = await pool.query(
        `SELECT id, text, source FROM paragraphs
         WHERE exam_id = $1 OR exam_id = 'general'
         ORDER BY RANDOM() LIMIT 5`,
        [examId]
      );
      return res.json({ paragraphs: bank, isDaily: false });
    }
    res.json({ paragraphs: rows, isDaily: true, date: today });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ─── ATTEMPTS API ─────────────────────────────────────────────────────────────
app.post('/api/attempts', async (req, res) => {
  try {
    const userId = req.session.userId || null;
    const {
      examId, examName, passageIdx,
      wpm, netWpm, accuracy, kdph,
      totalChars, correctChars, wrongChars,
      correctWords, wrongWords, totalWords,
      backspaces, keystrokes, duration,
      passed, grossWpm, cpm
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO attempts
        (user_id, exam_id, exam_name, passage_idx,
         wpm, net_wpm, accuracy, kdph,
         total_chars, correct_chars, wrong_chars,
         correct_words, wrong_words, total_words,
         backspaces, keystrokes, duration,
         passed, gross_wpm, cpm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id, created_at`,
      [
        userId, examId, examName, passageIdx,
        wpm, netWpm, accuracy, kdph,
        totalChars, correctChars, wrongChars,
        correctWords, wrongWords, totalWords,
        backspaces, keystrokes, duration,
        passed, grossWpm, cpm
      ]
    );
    res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/api/attempts', requireAuth, async (req, res) => {
  try {
    const { examId, limit = 50, offset = 0 } = req.query;
    let q = 'SELECT * FROM attempts WHERE user_id = $1';
    const params = [req.session.userId];
    if (examId) { q += ` AND exam_id = $${params.length + 1}`; params.push(examId); }
    q += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await pool.query(q, params);
    res.json({ attempts: rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ─── DASHBOARD API ───────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const user = await getUser(uid);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { rows: [overall] } = await pool.query(`
      SELECT
        COUNT(*) AS total_attempts,
        COUNT(*) FILTER (WHERE passed) AS passed,
        COUNT(*) FILTER (WHERE NOT passed) AS failed,
        ROUND(AVG(net_wpm)::numeric, 1) AS avg_wpm,
        MAX(net_wpm) AS best_wpm,
        ROUND(AVG(accuracy)::numeric, 1) AS avg_accuracy,
        ROUND(AVG(kdph)::numeric, 0) AS avg_kdph,
        MAX(kdph) AS best_kdph,
        SUM(duration) AS total_time_secs
      FROM attempts WHERE user_id = $1
    `, [uid]);

    const { rows: byExam } = await pool.query(`
      SELECT
        exam_id, exam_name,
        COUNT(*) AS attempts,
        COUNT(*) FILTER (WHERE passed) AS passed,
        ROUND(AVG(net_wpm)::numeric, 1) AS avg_wpm,
        MAX(net_wpm) AS best_wpm,
        ROUND(AVG(accuracy)::numeric, 1) AS avg_accuracy,
        MAX(created_at) AS last_attempt
      FROM attempts WHERE user_id = $1
      GROUP BY exam_id, exam_name
      ORDER BY last_attempt DESC
    `, [uid]);

    const { rows: recent } = await pool.query(`
      SELECT id, exam_id, net_wpm, accuracy, passed, created_at
      FROM attempts WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 30
    `, [uid]);

    // Streak
    const { rows: streakRows } = await pool.query(`
      SELECT DISTINCT DATE(created_at) AS day
      FROM attempts WHERE user_id = $1
      ORDER BY day DESC
    `, [uid]);
    let streak = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < streakRows.length; i++) {
      const day = new Date(streakRows[i].day);
      const expected = new Date(today);
      expected.setDate(expected.getDate() - i);
      if (day.toDateString() === expected.toDateString()) streak++;
      else break;
    }

    res.json({
      user,
      overall: { ...overall, streak },
      byExam,
      recent: recent.reverse(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ─── ADMIN — paragraph bulk insert ───────────────────────────────────────────
app.post('/api/admin/paragraphs', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN)
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const { paragraphs } = req.body;
    const inserts = paragraphs.map(p =>
      pool.query(
        `INSERT INTO paragraphs (exam_id, text, source, date_assigned)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [p.examId, p.text, p.source, p.dateAssigned || null]
      )
    );
    await Promise.all(inserts);
    res.json({ inserted: paragraphs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ TypeForge running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
