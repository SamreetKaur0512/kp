// Karan Patel Role-Play (fan-made). One Node server: login, lobby, games, AI, scoring, leaderboard.
import express from 'express';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
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

// ---------- database (MongoDB Atlas) ----------
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('MONGODB_URI is not set. Put it in .env (local) or Render > Environment.'); process.exit(1); }
const mclient = new MongoClient(MONGO_URI);
await mclient.connect();
const mdb = mclient.db(process.env.MONGODB_DB || 'karan_game');
const Users = mdb.collection('users'), Sessions = mdb.collection('sessions'), Results = mdb.collection('results'), Counters = mdb.collection('counters');
await Users.createIndex({ nameLower: 1 }, { unique: true });
await Users.createIndex({ pub: 1 }, { unique: true });
await Users.createIndex({ wins: -1 });
await Sessions.createIndex({ token: 1 }, { unique: true });
await Sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
console.log('MongoDB connected');
const nextId = async () => (await Counters.findOneAndUpdate({ _id: 'users' }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' })).n;
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newPub = async () => { for (;;) { const p = 'KP' + (1000 + crypto.randomInt(9000)); if (!(await Users.findOne({ pub: p }))) return p; } };
const newSession = async uid => { const t = crypto.randomBytes(24).toString('hex'); await Sessions.insertOne({ token: t, uid, createdAt: new Date() }); return t; };
const userById = id => Users.findOne({ _id: id });
const userBySid = async sid => { if (!sid) return null; const s = await Sessions.findOne({ token: sid }); return s ? Users.findOne({ _id: s.uid }) : null; };
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(x => x[0] === name)?.[1];

// ---------- http ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
// Home page with absolute photo URL so WhatsApp/Instagram/etc show the photo as a tappable preview card
import fs from 'fs';
const page = f => (req, res) => { const base = `${req.protocol}://${req.get('host')}`; res.type('html').send(fs.readFileSync(path.join(__dir, 'public', f), 'utf8').replaceAll('__BASE__', base)); };
app.get(['/', '/index.html'], page('index.html'));
app.get('/p', page('poster.html'));
app.use(express.static(path.join(__dir, 'public')));
const setCookie = (req, res, t) => res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.secure ? '; Secure' : ''}`);
const pubUser = u => ({ name: u.name, id: u.pub, wins: u.wins });
app.post('/api/register', async (req, res) => {
  try {
    const { name = '', password = '' } = req.body || {};
    const nm = String(name).trim();
    if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(nm)) return res.status(400).json({ error: 'Name must be 2-20 letters/numbers.' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const salt = crypto.randomBytes(16).toString('hex'), id = await nextId();
    try { await Users.insertOne({ _id: id, name: nm, nameLower: nm.toLowerCase(), pub: await newPub(), salt, hash: hash(String(password), salt), wins: 0, played: 0 }); }
    catch (e) { if (e.code === 11000) return res.status(400).json({ error: 'That name is already taken.' }); throw e; }
    setCookie(req, res, await newSession(id));
    res.json(pubUser(await userById(id)));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error. Please try again.' }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const { name = '', password = '' } = req.body || {};
    const u = await Users.findOne({ nameLower: String(name).trim().toLowerCase() });
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash(String(password), u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) return res.status(401).json({ error: 'Wrong name or password.' });
    setCookie(req, res, await newSession(u._id));
    res.json(pubUser(u));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error. Please try again.' }); }
});
app.post('/api/logout', async (req, res) => { try { await Sessions.deleteOne({ token: cookie(req, 'sid') || '' }); } catch (e) { console.error(e); } res.json({ ok: 1 }); });
app.get('/api/me', async (req, res) => { try { const u = await userBySid(cookie(req, 'sid')); u ? res.json(pubUser(u)) : res.status(401).json({}); } catch (e) { res.status(500).json({}); } });

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
async function leaderboard() {
  return Users.find({ wins: { $gt: 0 } }).sort({ wins: -1, name: 1 }).limit(5).project({ _id: 0, name: 1, pub: 1, wins: 1 }).toArray();
}
async function pushLobby() {
  const list = [...games.values()].filter(g => g.status === 'lobby' && !g.solo).map(g => ({ id: g.id, host: g.players.get(g.host).name, title: g.title, mins: g.mins, n: joined(g).length }));
  broadcast({ t: 'lobby', list, board: await leaderboard().catch(() => []) });
}
const addMsg = (g, m) => { m.ts = Date.now(); g.msgs.push(m); g.players.forEach((_, uid) => sendUser(uid, { t: 'msg', m })); };

function sysPrompt(g) {
  const humans = joined(g).map(([, p]) => p.char);
  const base = `You run a fan-made acting game about the Indian TV actor Karan Patel. LANGUAGE: reply in the same language AND script the players type (preferred: ${g.lang}). If they write Hinglish in Roman letters, write the dialogue and the (bracket) actions in Hinglish in Roman letters too; do not use long English narration. FORMAT: every line starts with the speaking character's name, then a short (bracket) action, then the dialogue. Use 2 to 3 different characters per reply, each with a distinct voice, in under 100 words in total. ACTING RULES: stay inside the show's world, relationships and tone; address the player's character by relationship (bhai, jiju, beta, maa...) when it fits; react specifically to what the player just said; add tension or a small twist every few turns; never repeat earlier lines. FACTS: use only what you are confident about for real shows and people. If unsure about a character's details, improvise in the spirit of the show and do not present guesses as facts. ${g.notes ? 'HOST NOTES about characters and story (trust these over your memory): ' + g.notes + ' ' : ''}Never claim to be the real Karan Patel; this is fiction. Never invent harmful or private claims about real people.`;
  const who = `Human players play: ${humans.join(', ')}. You (AI) play EVERY other character and never speak for the human characters.`;
  if (g.mode === 'serial') return `${base}\nSCENARIO: The serial "${g.show}". ${who} Capture the show's feel, family drama and dialogue style. Push the scene forward with dramatic situations.`;
  return `${base}\nSCENARIO: Quiz. You are a quiz host asking the players (${humans.join(', ')}) ONE question at a time about Karan Patel: shows, characters, career, friends, family, public life. Vary topics, never repeat. After answers, say briefly if right and give the true answer if wrong (only if confident, otherwise say you are not sure). Then ask the next question.`;
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
      const out = await ai(sysPrompt(g), `Scene so far:\n${transcript(g) || '(nothing yet)'}\n\n` + (g.msgs.length ? 'Continue: react as the AI-played characters.' : 'Start the scene: set it in brackets and let the AI-played characters speak first.'), 350);
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
  const P = `You are a strict but fair acting judge for a fan role-play game about Indian TV. Judge ONLY the lines spoken by the player playing "${p.char}" (lines starting with "${p.char}:").\n${sysPrompt(g).split('\n').find(l => l.startsWith('SCENARIO')) || ''} ${g.notes ? 'Host notes about the characters: ' + g.notes : ''}\nScore each criterion 0-10 using these anchors: 0-2 off-character or irrelevant; 3-4 weak; 5-6 acceptable/average; 7-8 good; 9-10 exceptional (rare). Do not inflate: typical casual players land between 4 and 7. Criteria: character (matches this character's personality, relationships, speaking style), emotion (believable range and reactions), dialogue (natural, relevant, moves the scene, suits the language), action (uses (bracket) actions/expressions, scene awareness), consistency (stays in role). For each give "evidence": a quote of at most 12 words from the player's own lines, or "no evidence". If unsure about the real show's characterisation, judge on internal consistency and say so in "note". Write feedback in English. Return ONLY JSON: {"character":{"score":0,"evidence":""},"emotion":{"score":0,"evidence":""},"dialogue":{"score":0,"evidence":""},"action":{"score":0,"evidence":""},"consistency":{"score":0,"evidence":""},"strengths":["",""],"improve":["",""],"note":""}\n\nScene transcript:\n${tr}`;
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
  for (const [uid, p, r] of res) if (r.pct != null && (!top || r.pct > top.pct)) top = { name: p.name, id: (await userById(uid))?.pub || '', pct: r.pct, uid };
  try { if (top && ps.length > 1) await Users.updateOne({ _id: top.uid }, { $inc: { wins: 1 } }); } catch (e) { console.error(e); }
  for (const [uid, , r] of res) {
    try {
      await Users.updateOne({ _id: uid }, { $inc: { played: 1 } });
      if (r.pct != null) await Results.insertOne({ game: g.id, uid, pct: r.pct, detail: r, ts: new Date() });
    } catch (e) { console.error(e); }
    // everyone sees ONLY the top player; each player sees only their own full result
    const msg = { t: 'result', mine: r, top: ps.length > 1 && top ? { name: top.name, id: top.id, pct: top.pct } : null };
    g.results.set(uid, msg); sendUser(uid, msg);
  }
  g.status = 'done'; pushState(g); pushLobby();
  setTimeout(() => games.delete(g.id), 30 * 60000);
}

// ---------- websocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
wss.on('connection', (ws, req) => {
  ws.last = 0;
  const ready = userBySid(cookie(req, 'sid')).catch(() => null);
  ready.then(u => {
    if (!u) { ws.close(4001); return; }
    const uid = u._id; ws.uid = uid;
    if (!online.has(uid)) online.set(uid, new Set());
    online.get(uid).add(ws);
    pushLobby();
    const g0 = activeGameOf(uid) || [...games.values()].find(g => g.results.get(uid) && Date.now() - (g.endsAt || 0) < 30 * 60000);
    if (g0) { send(ws, { t: 'game', g: gamePayload(g0) }); send(ws, { t: 'history', msgs: g0.msgs }); if (g0.results.get(uid)) send(ws, g0.results.get(uid)); }
  });
  ws.on('message', async raw => {
    const u = await ready; if (!u) return;
    const uid = u._id;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const err = e => send(ws, { t: 'err', e });
    try {
      const me = u;
      if (m.t === 'host') {
        if (activeGameOf(uid)) return err('You are already in a game.');
        const mode = MODES[m.mode] ? m.mode : 'serial', show = clamp(m.show, 60), char = clamp(m.char, 40);
        if (!char || (mode === 'serial' && !show)) return err('Choose a show and a character.');
        let id; do { id = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (games.has(id));
        const mins = Math.max(1, Math.min(30, +m.mins || 5));
        const g = { id, host: uid, mode, show, lang: clamp(m.lang, 30) || 'Hinglish', mins, notes: clamp(m.notes, 800), solo: !!m.solo, status: 'lobby', title: mode === 'serial' ? show : MODES[mode], players: new Map([[uid, { name: me.name, char, status: 'joined' }]]), msgs: [], results: new Map() };
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
  ws.on('close', () => { if (ws.uid != null) online.get(ws.uid)?.delete(ws); });
});
function startGame(g) {
  [...g.players].forEach(([id, p]) => { if (p.status !== 'joined') { g.players.delete(id); sendUser(id, { t: 'kicked' }); } });
  g.status = 'live'; g.endsAt = Date.now() + (TEST_SECONDS ? TEST_SECONDS * 1000 : g.mins * 60000);
  g.timer = setTimeout(() => endGame(g), g.endsAt - Date.now());
  pushState(g); pushLobby(); aiTurn(g, true);
}
server.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
