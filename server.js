// Karan Patel Role-Play (fan-made). One Node server: login, lobby, games, AI, scoring, leaderboard.
import express from 'express';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { findUserByName, passwordMatches } from './auth.js';
import multer from 'multer';
import { isRoleplayMediaMessage, roleplaySystemPrompt, roleplayTurnPrompt } from './roleplay.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dir, 'data.db');
const MEDIA_DIR = path.join(path.dirname(DB_PATH), 'fan-media');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GKEY = process.env.GEMINI_API_KEY;
const KEY = process.env.ANTHROPIC_API_KEY;
const PROVIDER = process.env.AI_PROVIDER || (GKEY && !KEY ? 'gemini' : 'claude'); // 'gemini' (free tier) or 'claude'
const GMODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const RPM = +process.env.AI_RPM || (PROVIDER === 'gemini' ? 12 : 0);   // free Gemini 3.5 Flash-Lite allows about 15 requests/min
const JUDGES = +process.env.JUDGES || (PROVIDER === 'gemini' ? 1 : 2);
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const FAKE = PROVIDER === 'gemini' ? !GKEY : !KEY; // no key = fake AI for local testing only
const TEST_SECONDS = +process.env.TEST_SECONDS || 0;
if (FAKE) console.warn('WARNING: no API key set for provider ' + PROVIDER + '. Using FAKE AI (testing only).');
else console.log('AI provider:', PROVIDER);

// ---------- database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, pub TEXT UNIQUE, salt TEXT, hash TEXT, wins INTEGER DEFAULT 0, played INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS results(game TEXT, uid INTEGER, pct REAL, detail TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS fan_chat(id INTEGER PRIMARY KEY, uid INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fan_chat_media(id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, filename TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fan_chat_blocks(uid INTEGER PRIMARY KEY, blocked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const q = {
  byId: db.prepare('SELECT * FROM users WHERE id=?'),
  bySid: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=?'),
};
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newPub = () => { for (;;) { const p = 'KP' + (1000 + crypto.randomInt(9000)); if (!db.prepare('SELECT 1 FROM users WHERE pub=?').get(p)) return p; } };
const newSession = uid => { const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, uid, Date.now()); return t; };
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(x => x[0] === name)?.[1];

// ---------- http ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
// Home page with absolute photo URL so WhatsApp/Instagram/etc show the photo as a tappable preview card
const page = f => (req, res) => { const base = `${req.protocol}://${req.get('host')}`; res.type('html').send(fs.readFileSync(path.join(__dir, 'public', f), 'utf8').replaceAll('__BASE__', base)); };
app.get(['/', '/index.html'], page('index.html'));
app.get('/p', page('poster.html'));
app.use('/uploads', express.static(MEDIA_DIR, { index: false, setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(path.join(__dir, 'public')));
const setCookie = (req, res, t) => res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.secure ? '; Secure' : ''}`);
const pubUser = u => ({ name: u.name, id: u.pub, wins: u.wins });
app.post('/api/register', (req, res) => {
  const { name = '', password = '' } = req.body || {};
  const cleanName = name.trim();
  if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(cleanName)) return res.status(400).json({ error: 'Name must be 2-20 letters/numbers.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (findUserByName(db, cleanName)) return res.status(400).json({ error: 'That name is already taken.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO users(name,pub,salt,hash) VALUES(?,?,?,?)').run(cleanName, newPub(), salt, hash(password, salt));
  setCookie(req, res, newSession(r.lastInsertRowid));
  res.json(pubUser(q.byId.get(r.lastInsertRowid)));
});
app.post('/api/login', (req, res) => {
  const { name = '', password = '' } = req.body || {};
  const u = findUserByName(db, name);
  if (!u || !passwordMatches(password, u)) return res.status(401).json({ error: 'Wrong name or password.' });
  setCookie(req, res, newSession(u.id));
  res.json(pubUser(u));
});
app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(cookie(req, 'sid') || ''); res.json({ ok: 1 }); });
app.get('/api/me', (req, res) => { const u = q.bySid.get(cookie(req, 'sid') || ''); u ? res.json(pubUser(u)) : res.status(401).json({}); });

// ---------- public fan chat ----------
const mediaExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(18).toString('hex') + mediaExtensions[file.mimetype]),
  }),
  fileFilter: (_req, file, cb) => mediaExtensions[file.mimetype] ? cb(null, true) : cb(new Error('Attach an image or video file.')),
});
const uploadFanMedia = (req, res, next) => upload.array('media', 5)(req, res, error => error ? res.status(400).json({ error: error.message }) : next());
const signedIn = (req, res, next) => {
  const u = q.bySid.get(cookie(req, 'sid') || '');
  if (!u) return res.status(401).json({ error: 'Log in to use the fan chat.' });
  if (db.prepare('SELECT 1 FROM fan_chat_blocks WHERE uid=?').get(u.id)) return res.status(403).json({ error: 'Your fan chat access is blocked.' });
  req.user = u;
  next();
};
const fanChatRows = () => {
  const rows = db.prepare(`SELECT m.id,m.uid,m.body,m.created_at,u.name FROM fan_chat m JOIN users u ON u.id=m.uid ORDER BY m.id DESC LIMIT 100`).all().reverse();
  const media = db.prepare('SELECT id,message_id,filename,original_name,mime FROM fan_chat_media WHERE message_id=?');
  return rows.map(row => ({ ...row, media: media.all(row.id).map(file => ({ id: file.id, url: '/uploads/' + file.filename, name: file.original_name, mime: file.mime })) }));
};
app.get('/api/fan-chat', (_req, res) => res.json({ messages: fanChatRows(), members: db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM fan_chat').get().n }));
app.post('/api/fan-chat', signedIn, uploadFanMedia, (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  const files = req.files || [];
  const discardFiles = () => files.forEach(file => fs.rm(file.path, { force: true }, () => {}));
  if (!body && !files.length) { discardFiles(); return res.status(400).json({ error: 'Write a message or attach media.' }); }
  const last = db.prepare('SELECT created_at FROM fan_chat WHERE uid=? ORDER BY id DESC LIMIT 1').get(req.user.id);
  if (last && Date.now() - last.created_at < 1000) { discardFiles(); return res.status(429).json({ error: 'Please wait a moment before posting again.' }); }
  const insertMessage = db.prepare('INSERT INTO fan_chat(uid,body,created_at) VALUES(?,?,?)');
  const insertMedia = db.prepare('INSERT INTO fan_chat_media(message_id,filename,original_name,mime) VALUES(?,?,?,?)');
  const addMessage = db.transaction(() => {
    const messageId = insertMessage.run(req.user.id, body, Date.now()).lastInsertRowid;
    files.forEach(file => insertMedia.run(messageId, file.filename, path.basename(file.originalname).slice(0, 180), file.mimetype));
  });
  try { addMessage(); } catch (error) { discardFiles(); throw error; }
  res.status(201).json({ ok: true });
});

// Moderator access is independent of public user accounts and requires ADMIN_PASSWORD.
const adminCookie = req => cookie(req, 'adminsid') || '';
const setAdminCookie = (req, res, token) => res.setHeader('Set-Cookie', `adminsid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${req.secure ? '; Secure' : ''}`);
const clearAdminCookie = req => `adminsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`;
const validAdminSession = req => ADMIN_PASSWORD && db.prepare('SELECT 1 FROM admin_sessions WHERE token=? AND created_at>?').get(adminCookie(req), Date.now() - 86400000);
const requireAdmin = (req, res, next) => {
  if (!validAdminSession(req)) return res.status(403).json({ error: 'Moderator sign-in required.' });
  next();
};
app.get('/api/admin/session', (req, res) => res.json({ configured: Boolean(ADMIN_PASSWORD), authenticated: Boolean(validAdminSession(req)) }));
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Set ADMIN_PASSWORD in the server environment first.' });
  const supplied = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
  const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'Incorrect moderator password.' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO admin_sessions VALUES(?,?)').run(token, Date.now());
  setAdminCookie(req, res, token);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { db.prepare('DELETE FROM admin_sessions WHERE token=?').run(adminCookie(req)); res.setHeader('Set-Cookie', clearAdminCookie(req)); res.json({ ok: true }); });
app.get('/api/admin/blocks', requireAdmin, (_req, res) => res.json({ users: db.prepare('SELECT u.id,u.name FROM fan_chat_blocks b JOIN users u ON u.id=b.uid ORDER BY u.name').all() }));
app.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const files = db.prepare('SELECT filename FROM fan_chat_media WHERE message_id=?').all(id);
  if (!db.prepare('SELECT 1 FROM fan_chat WHERE id=?').get(id)) return res.status(404).json({ error: 'Message not found.' });
  db.transaction(() => { db.prepare('DELETE FROM fan_chat_media WHERE message_id=?').run(id); db.prepare('DELETE FROM fan_chat WHERE id=?').run(id); })();
  files.forEach(file => fs.rm(path.join(MEDIA_DIR, file.filename), { force: true }, () => {}));
  res.json({ ok: true });
});
app.post('/api/admin/blocks/:uid', requireAdmin, (req, res) => {
  const uid = Number(req.params.uid);
  if (!q.byId.get(uid)) return res.status(404).json({ error: 'User not found.' });
  db.prepare('INSERT OR IGNORE INTO fan_chat_blocks(uid,blocked_at) VALUES(?,?)').run(uid, Date.now());
  res.json({ ok: true });
});
app.delete('/api/admin/blocks/:uid', requireAdmin, (req, res) => { db.prepare('DELETE FROM fan_chat_blocks WHERE uid=?').run(Number(req.params.uid)); res.json({ ok: true }); });

// ---------- AI ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ai(system, content, max = 400) {
  if (FAKE) {
    if (/Return ONLY JSON/.test(content)) {
      if (/"answers"/.test(content)) return JSON.stringify({ answers: [{ q: 'Q1', answer: 'x', verdict: 'correct', truth: '' }, { q: 'Q2', answer: 'y', verdict: 'wrong', truth: 'z' }], note: 'fake' });
      const c = { score: 6, evidence: 'fake' };
      return JSON.stringify({ character: c, emotion: c, dialogue: c, action: c, consistency: c, strengths: ['fake a'], improve: ['fake b'], note: 'fake judge' });
    }
    return '(Fake AI) Mr. Bajaj: Yeh kya ho raha hai? (looks around angrily)';
  }
  await slot();
  if (PROVIDER === 'gemini') return gemini(system, content, max);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw new Error('AI error ' + r.status);
  return (await r.json()).content.map(c => c.text || '').join('');
}
// global limiter: free tiers allow only a few requests per minute, so calls are spaced out
let nextAt = 0;
async function slot() { if (!RPM) return; const gap = 60000 / RPM, now = Date.now(), t = Math.max(now, nextAt); nextAt = t + gap; if (t > now) await sleep(t - now); }
async function gemini(system, content, max, retry = 1) {
  const wantJSON = /Return ONLY JSON/.test(content);
  const gc = { maxOutputTokens: max + (wantJSON ? 600 : 200), temperature: wantJSON ? 0.3 : 0.9 };
  if (wantJSON) gc.responseMimeType = 'application/json';
  if (/2\.5/.test(GMODEL)) gc.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GMODEL}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': GKEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: content }] }], generationConfig: gc }),
  });
  if (r.status === 429 && retry > 0) { await sleep(15000); await slot(); return gemini(system, content, max, retry - 1); }
  if (!r.ok) throw new Error('AI error ' + r.status);
  const j = await r.json();
  const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!t) throw new Error('AI returned nothing');
  return t;
}
const parseJSON = s => JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));

// ---------- game state ----------
const games = new Map();       // id -> game
const online = new Map();      // uid -> Set<ws>
const MODES = { serial: 'Serial Role-Play', quiz: 'Karan Patel Quiz' };
const clamp = (s, n) => String(s ?? '').trim().slice(0, n);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const sendUser = (uid, o) => online.get(uid)?.forEach(ws => send(ws, o));
const broadcast = o => online.forEach(set => set.forEach(ws => send(ws, o)));
const activeGameOf = uid => [...games.values()].find(g => g.status !== 'done' && g.players.get(uid));
const joined = g => [...g.players].filter(([, p]) => p.status === 'joined');

function gamePayload(g) {
  return { id: g.id, title: g.title, mode: g.mode, mins: g.mins, status: g.status, host: g.host, solo: g.solo, endsAt: g.endsAt, now: Date.now(),
    players: [...g.players].map(([uid, p]) => ({ uid, name: p.name, char: p.char, status: p.status })) };
}
const pushState = g => g.players.forEach((_, uid) => sendUser(uid, { t: 'game', g: gamePayload(g) }));
function leaderboard() {
  return db.prepare('SELECT name,pub,wins FROM users WHERE wins>0 ORDER BY wins DESC, name LIMIT 5').all();
}
function pushLobby() {
  const list = [...games.values()].filter(g => g.status === 'lobby' && !g.solo).map(g => ({ id: g.id, host: g.players.get(g.host).name, title: g.title, mins: g.mins, n: joined(g).length }));
  broadcast({ t: 'lobby', list, board: leaderboard() });
}
const addMsg = (g, m) => { m.ts = Date.now(); g.msgs.push(m); g.players.forEach((_, uid) => sendUser(uid, { t: 'msg', m })); };

function sysPrompt(g) {
  const characters = joined(g).map(([, p]) => p.char);
  return roleplaySystemPrompt({ mode: g.mode, show: g.show, lang: g.lang, characters });
}
const transcript = g => g.msgs.map(m => `${m.who}: ${m.t}`).join('\n');

async function aiTurn(g, first = false) {
  if (g.aiBusy) { g.aiAgain = true; return; }
  g.aiBusy = true;
  try {
    do {
      g.aiAgain = false;
      await sleep(first ? 200 : 1200);
      if (g.status !== 'live') break;
      const latestPlayerTurn = [...g.msgs].reverse().find(m => m.uid !== 0);
      const out = await ai(sysPrompt(g), roleplayTurnPrompt({
        transcript: transcript(g),
        latestPlayerTurn: latestPlayerTurn ? `${latestPlayerTurn.who}: ${latestPlayerTurn.t}` : '',
        first: g.msgs.length === 0,
      }), 600);
      addMsg(g, { uid: 0, who: 'AI', t: out.trim() });
      first = false;
    } while (g.aiAgain);
  } catch (e) { addMsg(g, { uid: 0, who: 'System', t: '(AI had a problem. Send another line to continue.)' }); }
  g.aiBusy = false;
}

// ---------- scoring ----------
const CR = [['character', 'Character accuracy', .3], ['emotion', 'Emotion & acting', .2], ['dialogue', 'Dialogue quality', .2], ['action', 'Actions in (brackets)', .15], ['consistency', 'Consistency', .15]];
const verdict = p => p >= 85 ? 'Outstanding' : p >= 70 ? 'Very good' : p >= 55 ? 'Good' : p >= 40 ? 'Average' : 'Needs practice';
async function judge(g, uid, p) {
  const mine = g.msgs.filter(m => m.uid === uid);
  if (!mine.length) return { pct: 0, verdict: 'No performance', det: [], strengths: [], improve: [], note: '', extra: 'You did not play any lines, so there is nothing to score.' };
  const tr = transcript(g), det = [];
  if (g.mode === 'quiz') {
    const r = parseJSON(await ai('You are a strict fact-checking judge.', `Quiz about the Indian TV actor Karan Patel. Judge ONLY the answers of "${p.char}" (lines starting with that name). For every question give verdict "correct", "wrong" or "unsure". Use "unsure" whenever you are not confident of the true fact; never guess. Return ONLY JSON: {"answers":[{"q":"","answer":"","verdict":"correct|wrong|unsure","truth":""}],"note":""}\n\nConversation:\n${tr}`, 1500));
    const a = r.answers || [], c = a.filter(x => x.verdict === 'correct').length, w = a.filter(x => x.verdict === 'wrong').length;
    if (c + w === 0) return { pct: 0, verdict: 'Not enough answers', det: [], strengths: [], improve: [], note: r.note || '', extra: 'No answer could be verified, so no score.' };
    const pct = c / (c + w) * 100;
    a.forEach(x => det.push(['Q: ' + x.q, x.verdict, 'Your answer: ' + x.answer + (x.truth ? ' | Truth: ' + x.truth : '')]));
    return { pct, verdict: verdict(pct), det, strengths: [], improve: [], note: r.note || '', extra: `${c} correct, ${w} wrong, ${a.length - c - w} unsure (unsure are not counted). Score = correct / (correct + wrong).` };
  }
  const P = `You are a strict but fair acting judge for a fan role-play game about Indian TV. Judge ONLY the lines spoken by the player playing "${p.char}" (lines starting with "${p.char}:").\n${sysPrompt(g).split('\n').find(l => l.startsWith('SCENARIO')) || ''}\nScore each criterion 0-10 using these anchors: 0-2 off-character or irrelevant; 3-4 weak; 5-6 acceptable/average; 7-8 good; 9-10 exceptional (rare). Do not inflate: typical casual players land between 4 and 7. Criteria: character (matches this character's personality, relationships, speaking style), emotion (believable range and reactions), dialogue (natural, relevant, moves the scene, suits the language), action (uses (bracket) actions/expressions, scene awareness), consistency (stays in role). For each give "evidence": a quote of at most 12 words from the player's own lines, or "no evidence". If unsure about the real show's characterisation, judge on internal consistency and say so in "note". Write feedback in English. Return ONLY JSON: {"character":{"score":0,"evidence":""},"emotion":{"score":0,"evidence":""},"dialogue":{"score":0,"evidence":""},"action":{"score":0,"evidence":""},"consistency":{"score":0,"evidence":""},"strengths":["",""],"improve":["",""],"note":""}\n\nScene transcript:\n${tr}`;
  const rs = (await Promise.all(Array.from({ length: JUDGES }, () => ai('You are an acting judge.', P, 900)))).map(parseJSON);
  let base = 0;
  CR.forEach(([k, l, w]) => {
    const s = rs.reduce((a, r) => a + Math.max(0, Math.min(10, +r[k]?.score || 0)), 0) / rs.length;
    base += s / 10 * w; det.push([l, s.toFixed(1) + '/10', rs[0][k]?.evidence || '']);
  });
  const exp = Math.max(3, Math.round(g.mins * 1.2)), f = .6 + .4 * Math.min(1, mine.length / exp), pct = Math.max(0, Math.min(100, base * 100 * f));
  return { pct, verdict: verdict(pct), det, strengths: rs[0].strengths || [], improve: rs[0].improve || [], note: rs[0].note || '',
    extra: `Score = ${JUDGES === 1 ? 'one AI judge' : 'average of ' + JUDGES + ' independent AI judges'}, weighted (character 30%, emotion 20%, dialogue 20%, actions 15%, consistency 15%), times a participation factor of ${f.toFixed(2)} (${mine.length} lines played, about ${exp} expected for ${g.mins} min).` };
}
async function endGame(g) {
  if (g.status !== 'live') return;
  g.status = 'scoring'; clearTimeout(g.timer); pushState(g);
  const ps = joined(g);
  const res = await Promise.all(ps.map(async ([uid, p]) => { try { return [uid, p, await judge(g, uid, p)]; } catch (e) { return [uid, p, { pct: null, verdict: 'Could not score', det: [], strengths: [], improve: [], note: '', extra: 'The AI judge had a problem. Please try again later.' }]; } }));
  let top = null;
  res.forEach(([uid, p, r]) => { if (r.pct != null && (!top || r.pct > top.pct)) top = { name: p.name, id: q.byId.get(uid).pub, pct: r.pct, uid }; });
  if (top && ps.length > 1) db.prepare('UPDATE users SET wins=wins+1 WHERE id=?').run(top.uid);
  res.forEach(([uid, , r]) => {
    db.prepare('UPDATE users SET played=played+1 WHERE id=?').run(uid);
    if (r.pct != null) db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(g.id, uid, r.pct, JSON.stringify(r), Date.now());
    // everyone sees ONLY the top player; each player sees only their own full result
    const msg = { t: 'result', mine: r, top: ps.length > 1 && top ? { name: top.name, id: top.id, pct: top.pct } : null };
    g.results.set(uid, msg); sendUser(uid, msg);
  });
  g.status = 'done'; pushState(g); pushLobby();
  setTimeout(() => games.delete(g.id), 30 * 60000);
}

// ---------- websocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
const startServer = () => {
  server.listen(PORT, () => console.log('Listening on http://localhost:' + PORT));
};
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) startServer();

wss.on('connection', (ws, req) => {
  const u = q.bySid.get(cookie(req, 'sid') || '');
  if (!u) { ws.close(4001); return; }
  const uid = u.id; ws.uid = uid; ws.last = 0;
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(ws);
  pushLobby();
  const g0 = activeGameOf(uid) || [...games.values()].find(g => g.results.get(uid) && Date.now() - (g.endsAt || 0) < 30 * 60000);
  if (g0) { send(ws, { t: 'game', g: gamePayload(g0) }); send(ws, { t: 'history', msgs: g0.msgs }); if (g0.results.get(uid)) send(ws, g0.results.get(uid)); }
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const err = e => send(ws, { t: 'err', e });
    try {
      const me = q.byId.get(uid);
      if (m.t === 'host') {
        if (activeGameOf(uid)) return err('You are already in a game.');
        const mode = MODES[m.mode] ? m.mode : 'serial', show = clamp(m.show, 60), char = clamp(m.char, 40);
        if (!char || (mode === 'serial' && !show)) return err('Choose a show and a character.');
        let id; do { id = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (games.has(id));
        const mins = Math.max(1, Math.min(30, +m.mins || 5));
        const g = { id, host: uid, mode, show, lang: clamp(m.lang, 30) || 'Hinglish', mins, solo: !!m.solo, status: 'lobby', title: mode === 'serial' ? show : MODES[mode], players: new Map([[uid, { name: me.name, char, status: 'joined' }]]), msgs: [], results: new Map() };
        games.set(id, g);
        if (g.solo) startGame(g); else { pushState(g); pushLobby(); }
      } else if (m.t === 'join') {
        const g = games.get(m.gid); if (!g || g.status !== 'lobby') return err('Game not found, or it has already started.');
        if (activeGameOf(uid)) return err('You are already in a game.');
        const char = clamp(m.char, 40); if (!char) return err('Enter your character first.');
        if ([...g.players.values()].some(p => p.char.toLowerCase() === char.toLowerCase())) return err('That character is already taken. Choose another.');
        g.players.set(uid, { name: me.name, char, status: 'requested' }); pushState(g);
      } else if (m.t === 'accept' || m.t === 'reject') {
        const g = games.get(m.gid); if (!g || g.host !== uid || g.status !== 'lobby') return;
        const p = g.players.get(+m.uid); if (!p || p.status !== 'requested') return;
        if (m.t === 'accept') p.status = 'joined'; else { g.players.delete(+m.uid); sendUser(+m.uid, { t: 'kicked' }); }
        pushState(g); pushLobby();
      } else if (m.t === 'start') {
        const g = games.get(m.gid); if (g && g.host === uid && g.status === 'lobby') startGame(g);
      } else if (m.t === 'say') {
        const g = games.get(m.gid), p = g?.players.get(uid);
        if (!g || g.status !== 'live' || p?.status !== 'joined') return;
        const now = Date.now(); if (now - ws.last < 1000) return err('Slow down a little.'); ws.last = now;
        if (isRoleplayMediaMessage(m)) return err('Role-play chat is text-only. Images and videos are not supported.');
        if (typeof m.t2 !== 'string') return err('Role-play chat is text-only. Images and videos are not supported.');
        const t = clamp(m.t2, 500); if (!t || g.msgs.length > 300) return;
        addMsg(g, { uid, who: p.char, t }); aiTurn(g);
      } else if (m.t === 'end') {
        const g = games.get(m.gid); if (g && g.host === uid) endGame(g);
      } else if (m.t === 'leave') {
        const g = games.get(m.gid); if (!g) return;
        if (g.status === 'lobby') { if (g.host === uid) { g.players.forEach((_, id) => sendUser(id, { t: 'kicked' })); games.delete(g.id); } else { g.players.delete(uid); pushState(g); } pushLobby(); }
        else if (g.status === 'done') { /* just closing results */ }
      }
    } catch (e) { console.error(e); err('Something went wrong.'); }
  });
  ws.on('close', () => { online.get(uid)?.delete(ws); });
});
function startGame(g) {
  [...g.players].forEach(([id, p]) => { if (p.status !== 'joined') { g.players.delete(id); sendUser(id, { t: 'kicked' }); } });
  g.status = 'live'; g.endsAt = Date.now() + (TEST_SECONDS ? TEST_SECONDS * 1000 : g.mins * 60000);
  g.timer = setTimeout(() => endGame(g), g.endsAt - Date.now());
  pushState(g); pushLobby(); aiTurn(g, true);
}
