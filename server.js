// Karan Patel Role-Play (fan-made). One Node server: login, lobby, games, AI, scoring, leaderboard.
import express from 'express';
import { WebSocketServer } from 'ws';
import { MongoClient, ObjectId } from 'mongodb';
import { v2 as cloudinary } from 'cloudinary';
import { createCloudinaryStorage } from './cloudinary-storage.js';
import { ACTING_CRITERIA, actingJudgePrompt } from './acting-judge.js';
import { buildQuiz, QUIZ_QUESTION_COUNTS, quizPlayerResult, revealQuizQuestion, submitQuizAnswer } from './quiz-game.js';
import { removeHumanCharacterLines, roleplaySystemPrompt, roleplayTurnPrompt } from './roleplay.js';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CLOUDINARY_CONFIGURED = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
const GKEY = process.env.GEMINI_API_KEY;
const KEY = process.env.ANTHROPIC_API_KEY;
const PROVIDER = process.env.AI_PROVIDER || (GKEY && !KEY ? 'gemini' : 'claude'); // 'gemini' (free tier) or 'claude'
const GMODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const RPM = +process.env.AI_RPM || (PROVIDER === 'gemini' ? 12 : 0);   // free Gemini 3.5 Flash-Lite allows about 15 requests/min
const JUDGES = +process.env.JUDGES || (PROVIDER === 'gemini' ? 1 : 2);
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const FAKE = PROVIDER === 'gemini' ? !GKEY : !KEY; // no key = fake AI for local testing only
const TEST_SECONDS = +process.env.TEST_SECONDS || 0;
if (CLOUDINARY_CONFIGURED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else console.warn('Cloudinary is not configured. Chat photo/video uploads are disabled.');
if (FAKE) console.warn('WARNING: no API key set for provider ' + PROVIDER + '. Using FAKE AI (testing only).');
else console.log('AI provider:', PROVIDER);

// ---------- database (MongoDB Atlas) ----------
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('MONGODB_URI is not set. Put it in .env (local) or Render > Environment.'); process.exit(1); }
const mclient = new MongoClient(MONGO_URI);
await mclient.connect();
const mdb = mclient.db(process.env.MONGODB_DB || 'karan_game');
const Users = mdb.collection('users'), Sessions = mdb.collection('sessions'), Results = mdb.collection('results'), Counters = mdb.collection('counters');
const FanChat = mdb.collection('fan_chat'), FanChatBlocks = mdb.collection('fan_chat_blocks'), AdminSessions = mdb.collection('admin_sessions');
await Users.createIndex({ nameLower: 1 }, { unique: true });
await Users.createIndex({ pub: 1 }, { unique: true });
await Users.createIndex({ wins: -1 });
await Sessions.createIndex({ token: 1 }, { unique: true });
await Sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
await FanChat.createIndex({ createdAt: -1 });
await FanChat.createIndex({ uid: 1, createdAt: -1 });
await FanChatBlocks.createIndex({ uid: 1 }, { unique: true });
await AdminSessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
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

// ---------- public fan chat ----------
const mediaExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv' };
const upload = multer({
  storage: createCloudinaryStorage(cloudinary),
  fileFilter: (_req, file, cb) => {
    if (!CLOUDINARY_CONFIGURED) return cb(Object.assign(new Error('Photo/video uploads are not configured. Add the Cloudinary environment variables in Render.'), { status: 503 }));
    if (!Object.hasOwn(mediaExtensions, file.mimetype)) return cb(new Error('Attach an image or video file.'));
    cb(null, true);
  },
});
const uploadFanMedia = (req, res, next) => upload.array('media', 5)(req, res, error => {
  if (error) {
    if (error.status !== 503) console.error(error);
    return res.status(error.status || 400).json({ error: error.status === 503 ? error.message : error.message || 'Could not upload media.' });
  }
  next();
});
const signedIn = async (req, res, next) => {
  try {
    const user = await userBySid(cookie(req, 'sid') || '');
    if (!user) return res.status(401).json({ error: 'Log in to use the fan chat.' });
    if (await FanChatBlocks.findOne({ uid: user._id })) return res.status(403).json({ error: 'Your fan chat access is blocked.' });
    req.user = user;
    next();
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not verify your fan chat access.' }); }
};
app.get('/api/fan-chat', async (req, res) => {
  try {
    const posts = await FanChat.find({}).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    const viewer = await userBySid(cookie(req, 'sid') || '');
    const userIds = [...new Set(posts.filter(post => !post.deleted && post.uid != null).map(post => post.uid))];
    const users = await Users.find({ _id: { $in: userIds } }).project({ name: 1 }).toArray();
    const names = new Map(users.map(user => [user._id, user.name]));
    const messages = posts.reverse().flatMap(post => {
      if (post.deleted) return [{ id: post._id.toString(), deleted: true, body: post.body, created_at: post.createdAt.getTime(), media: [] }];
      if (!names.has(post.uid)) return [];
      return [{
        id: post._id.toString(), uid: post.uid, isMine: viewer?._id === post.uid, name: names.get(post.uid), body: post.body, created_at: post.createdAt.getTime(),
        media: (post.media || []).map(file => ({ id: file.id, url: file.url, name: file.name, mime: file.mime })),
      }];
    });
    const members = onlineCount();
    res.json({ messages, members });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load the fan chat.' }); }
});
app.post('/api/fan-chat', signedIn, uploadFanMedia, async (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  const files = req.files || [];
  if (!body && !files.length) return res.status(400).json({ error: 'Write a message or attach media.' });
  try {
    const last = await FanChat.findOne({ uid: req.user._id }, { sort: { createdAt: -1 } });
    if (last && Date.now() - last.createdAt.getTime() < 1000) {
      await Promise.all(files.map(file => cloudinary.uploader.destroy(file.filename, { resource_type: file.resourceType, invalidate: true })));
      return res.status(429).json({ error: 'Please wait a moment before posting again.' });
    }
    await FanChat.insertOne({
      uid: req.user._id, body, createdAt: new Date(),
      media: files.map(file => ({
        id: crypto.randomBytes(12).toString('hex'),
        publicId: file.filename,
        url: file.path,
        resourceType: file.resourceType,
        name: path.basename(file.originalname).slice(0, 180),
        mime: file.mimetype,
      })),
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    try {
      await Promise.all(files.map(file => cloudinary.uploader.destroy(file.filename, { resource_type: file.resourceType, invalidate: true })));
    } catch (cleanupError) { console.error(cleanupError); }
    console.error(error);
    res.status(500).json({ error: 'Message could not be sent.' });
  }
});
async function deleteFanMessage(post, query, res) {
  const result = await FanChat.updateOne(
    { _id: post._id, ...query, deleted: { $ne: true } },
    { $set: { deleted: true, body: 'A message or media item was deleted.', media: [], deletedAt: new Date() }, $unset: { uid: '' } },
  );
  if (result.modifiedCount !== 1) return res.status(404).json({ error: 'Message not found.' });
  const cleanup = await Promise.allSettled((post.media || []).map(file =>
    cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType, invalidate: true }),
  ));
  const failed = cleanup.some(item => item.status === 'rejected');
  if (failed) cleanup.filter(item => item.status === 'rejected').forEach(item => console.error(item.reason));
  res.json({ ok: true, warning: failed ? 'The message was removed, but some media could not be deleted from Cloudinary.' : '' });
}
app.delete('/api/fan-chat/:id', signedIn, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  try {
    const id = new ObjectId(req.params.id);
    const post = await FanChat.findOne({ _id: id, uid: req.user._id, deleted: { $ne: true } });
    if (!post) return res.status(404).json({ error: 'Message not found or it is not yours.' });
    await deleteFanMessage(post, { uid: req.user._id }, res);
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not delete your message.' }); }
});

// ---------- moderator tools ----------
const adminCookie = req => cookie(req, 'adminsid') || '';
const setAdminCookie = (req, res, token) => res.setHeader('Set-Cookie', `adminsid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${req.secure ? '; Secure' : ''}`);
const clearAdminCookie = req => `adminsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`;
const validAdminSession = async req => ADMIN_PASSWORD && AdminSessions.findOne({ _id: adminCookie(req), createdAt: { $gt: new Date(Date.now() - 86400000) } });
const requireAdmin = async (req, res, next) => {
  try {
    if (!await validAdminSession(req)) return res.status(403).json({ error: 'Moderator sign-in required.' });
    next();
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not verify moderator access.' }); }
};
app.get('/api/admin/session', async (req, res) => {
  try { res.json({ configured: Boolean(ADMIN_PASSWORD), authenticated: Boolean(await validAdminSession(req)) }); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Could not load moderator status.' }); }
});
app.post('/api/admin/login', async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Set ADMIN_PASSWORD in the server environment first.' });
  const supplied = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
  const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'Incorrect moderator password.' });
  try {
    const token = crypto.randomBytes(32).toString('hex');
    await AdminSessions.insertOne({ _id: token, createdAt: new Date() });
    setAdminCookie(req, res, token);
    res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not sign in as moderator.' }); }
});
app.post('/api/admin/logout', async (req, res) => {
  try {
    await AdminSessions.deleteOne({ _id: adminCookie(req) });
    res.setHeader('Set-Cookie', clearAdminCookie(req));
    res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not sign out moderator.' }); }
});
app.get('/api/admin/blocks', requireAdmin, async (_req, res) => {
  try {
    const blocks = await FanChatBlocks.find({}).toArray();
    const users = await Users.find({ _id: { $in: blocks.map(block => block.uid) } }).project({ name: 1, pub: 1 }).sort({ name: 1 }).toArray();
    res.json({ users: users.map(user => ({ id: user._id, name: user.name, pub: user.pub })) });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load blocked members.' }); }
});
app.get('/api/admin/members', requireAdmin, async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase().slice(0, 20);
  try {
    const filter = search ? { nameLower: { $regex: `^${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } : {};
    const users = await Users.find(filter).sort({ nameLower: 1 }).limit(50).project({ name: 1, nameLower: 1, pub: 1 }).toArray();
    const blocked = new Set((await FanChatBlocks.find({ uid: { $in: users.map(user => user._id) } }).toArray()).map(block => block.uid));
    res.json({ users: users.map(user => ({ id: user._id, name: user.name, pub: user.pub, blocked: blocked.has(user._id) })) });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load members for moderation.' }); }
});
app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  try {
    const id = new ObjectId(req.params.id);
    const post = await FanChat.findOne({ _id: id, deleted: { $ne: true } });
    if (!post) return res.status(404).json({ error: 'Message not found.' });
    await deleteFanMessage(post, {}, res);
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not delete this message.' }); }
});
app.post('/api/admin/blocks/:uid', requireAdmin, async (req, res) => {
  const uid = Number(req.params.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Invalid member ID.' });
  try {
    if (!await Users.findOne({ _id: uid })) return res.status(404).json({ error: 'User not found.' });
    await FanChatBlocks.updateOne({ uid }, { $setOnInsert: { uid, blockedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not block this member.' }); }
});
app.delete('/api/admin/blocks/:uid', requireAdmin, async (req, res) => {
  const uid = Number(req.params.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Invalid member ID.' });
  try { await FanChatBlocks.deleteOne({ uid }); res.json({ ok: true }); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Could not unblock this member.' }); }
});

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
const onlineCount = () => [...online.values()].filter(sockets => [...sockets].some(socket => socket.readyState === 1)).length;
const activeGameOf = uid => [...games.values()].find(g => g.status !== 'done' && g.players.get(uid));
const joined = g => [...g.players].filter(([, p]) => p.status === 'joined');

function gamePayload(g, viewerUid) {
  return {
    id: g.id, title: g.title, mode: g.mode, mins: g.mins, questionCount: g.questionCount, status: g.status,
    host: g.players.get(g.host)?.pub, solo: g.solo, endsAt: g.endsAt, now: Date.now(),
    players: [...g.players].map(([uid, p]) => ({ uid, name: p.name, pub: p.pub, char: p.char, status: p.status })),
    quiz: g.quiz ? {
      number: g.quiz.index + 1,
      total: g.quiz.questions.length,
      question: g.quiz.questions[g.quiz.index] ? {
        category: g.quiz.questions[g.quiz.index].category,
        text: g.quiz.questions[g.quiz.index].text,
        options: g.quiz.questions[g.quiz.index].options,
        correctIndex: g.quiz.revealed ? g.quiz.questions[g.quiz.index].correctIndex : null,
      } : null,
      submitted: g.quiz.currentAnswers.size,
      myChoice: g.quiz.currentAnswers.get(viewerUid) ?? null,
      revealed: g.quiz.revealed,
      questionEndsAt: g.quiz.questionEndsAt || null,
      advanceAt: g.quiz.advanceAt || null,
      scores: joined(g).map(([uid, player]) => ({
        name: player.name,
        pub: player.pub,
        correct: g.quiz.scores.get(uid)?.correct || 0,
        answered: g.quiz.scores.get(uid)?.answered || 0,
      })),
    } : null,
  };
}
const pushState = g => g.players.forEach((_, uid) => sendUser(uid, { t: 'game', g: gamePayload(g, uid) }));
async function leaderboard() {
  return Users.find({ wins: { $gt: 0 } }).sort({ wins: -1, name: 1 }).limit(5).project({ _id: 0, name: 1, pub: 1, wins: 1 }).toArray();
}
async function pushLobby() {
  const list = [...games.values()].filter(g => g.status === 'lobby' && !g.solo).map(g => ({
    id: g.id, host: g.players.get(g.host).name, title: g.title, mode: g.mode,
    mins: g.mins, questionCount: g.questionCount, n: joined(g).length,
  }));
  broadcast({ t: 'lobby', list, board: await leaderboard().catch(() => []) });
}
const addMsg = (g, m) => { m.ts = Date.now(); g.msgs.push(m); g.players.forEach((_, uid) => sendUser(uid, { t: 'msg', m })); };

function sysPrompt(g) {
  if (g.mode === 'serial') {
    return roleplaySystemPrompt({
      mode: g.mode,
      show: g.show,
      lang: g.lang,
      characters: joined(g).map(([, player]) => player.char),
      notes: g.notes,
    });
  }
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
      const players = joined(g);
      const playerMessages = g.msgs.filter(message => players.some(([uid]) => uid === message.uid));
      const latestPlayerTurn = playerMessages.length ? `${playerMessages.at(-1).who}: ${playerMessages.at(-1).t}` : '';
      const request = roleplayTurnPrompt({
        transcript: transcript(g),
        latestPlayerTurn,
        first: g.msgs.length === 0,
      });
      const raw = await ai(sysPrompt(g), request, 500);
      const out = removeHumanCharacterLines(raw, players.map(([, player]) => player.char));
      addMsg(g, { uid: 0, who: 'AI', t: out || '(The AI cast leaves the human-played characters’ words and actions to their players.)' });
      first = false;
    } while (g.aiAgain);
  } catch (e) { addMsg(g, { uid: 0, who: 'System', t: '(AI had a problem. Send another line to continue.)' }); }
  g.aiBusy = false;
}

// ---------- scoring ----------
const verdict = p => p >= 85 ? 'Outstanding' : p >= 70 ? 'Very good' : p >= 55 ? 'Good' : p >= 40 ? 'Average' : 'Needs practice';
async function judge(g, uid, p) {
  const mine = g.msgs.filter(m => m.uid === uid);
  if (g.mode === 'quiz') return quizPlayerResult(g.quiz, uid);
  if (!mine.length) return { pct: 0, verdict: 'No performance', det: [], strengths: [], improve: [], note: '', extra: 'You did not play any lines, so there is nothing to score.' };
  const tr = transcript(g), det = [];
  const playerLines = mine.map(m => `${m.who}: ${m.t}`).join('\n');
  const P = actingJudgePrompt({
    character: p.char,
    scenario: sysPrompt(g).split('\n').find(l => l.startsWith('SCENARIO')) || '',
    notes: g.notes,
    lines: playerLines,
    transcript: tr,
  });
  const rs = (await Promise.all(Array.from({ length: JUDGES }, () => ai('You are an acting judge.', P, 900)))).map(parseJSON);
  let base = 0;
  ACTING_CRITERIA.forEach(([k, l, w]) => {
    const s = rs.reduce((a, r) => a + Math.max(0, Math.min(10, +r[k]?.score || 0)), 0) / rs.length;
    base += s / 10 * w; det.push([l, s.toFixed(1) + '/10', rs[0][k]?.evidence || '']);
  });
  const exp = Math.max(3, Math.round(g.mins * 1.2)), f = .8 + .2 * Math.min(1, mine.length / exp), pct = Math.max(0, Math.min(100, base * 100 * f));
  return { pct, verdict: verdict(pct), det, strengths: rs[0].strengths || [], improve: rs[0].improve || [], note: rs[0].note || '',
    extra: `Score = ${JUDGES === 1 ? 'one AI judge' : 'average of ' + JUDGES + ' independent AI judges'}, weighted (character portrayal 40%, in-character dialogue and interaction 25%, emotion 15%, actions 10%, consistency 10%), times a modest participation factor of ${f.toFixed(2)} (${mine.length} lines played, about ${exp} expected for ${g.mins} min). Message quantity alone does not determine the acting score.` };
}
async function endGame(g) {
  if (g.status !== 'live') return;
  g.status = 'scoring'; clearTimeout(g.timer); clearTimeout(g.quiz?.questionTimer); clearTimeout(g.quiz?.advanceTimer); pushState(g);
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
    const msg = { t: 'result', mine: r, top: top ? { name: top.name, id: top.id, pct: top.pct } : null };
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
    if (g0) { send(ws, { t: 'game', g: gamePayload(g0, uid) }); send(ws, { t: 'history', msgs: g0.msgs }); if (g0.results.get(uid)) send(ws, g0.results.get(uid)); }
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
        if ((mode === 'serial' && !char) || (mode === 'serial' && !show)) return err('Choose a show and the character you want to play.');
        const questionCount = mode === 'quiz' ? Number(m.questionCount) : 0;
        if (mode === 'quiz' && !QUIZ_QUESTION_COUNTS.includes(questionCount)) return err('Choose 5, 10, 15, 20, 25, or 30 quiz questions.');
        let id; do { id = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (games.has(id));
        const mins = mode === 'serial' ? Math.max(1, Math.min(30, +m.mins || 5)) : 0;
        let quiz = null;
        try {
          if (mode === 'quiz') quiz = { questions: buildQuiz(questionCount), index: 0, currentAnswers: new Map(), revealed: false, scores: new Map() };
        } catch (error) { return err(error.message); }
        const player = { name: me.name, pub: me.pub, char: mode === 'quiz' ? me.name : char, status: 'joined' };
        const g = {
          id, host: uid, mode, show, lang: clamp(m.lang, 30) || 'Hinglish', mins, questionCount,
          quiz, notes: clamp(m.notes, 800), solo: !!m.solo, status: 'lobby',
          title: mode === 'serial' ? show : MODES[mode], players: new Map([[uid, player]]), msgs: [], results: new Map(),
        };
        games.set(id, g);
        if (g.solo) startGame(g); else { pushState(g); pushLobby(); }
      } else if (m.t === 'join') {
        const g = games.get(m.gid); if (!g || g.status !== 'lobby') return err('Game not found, or it has already started.');
        if (activeGameOf(uid)) return err('You are already in a game.');
        const char = g.mode === 'quiz' ? me.name : clamp(m.char, 40);
        if (g.mode === 'serial' && !char) return err('Choose the character you want to play before requesting to join.');
        if (g.mode === 'serial' && [...g.players.values()].some(p => p.char.toLowerCase() === char.toLowerCase())) return err('That character is already taken. Choose another.');
        const direct = m.direct === true;
        g.players.set(uid, { name: me.name, pub: me.pub, char, status: direct ? 'joined' : 'requested' });
        pushState(g);
        if (direct) {
          sendUser(g.host, { t: 'playerJoined', gid: g.id, name: me.name, pub: me.pub, char });
          send(ws, { t: 'joinedGame', gid: g.id, host: g.players.get(g.host).name });
          pushLobby();
        } else {
          sendUser(g.host, { t: 'joinRequest', gid: g.id, name: me.name, pub: me.pub, char });
          send(ws, { t: 'requestSent', gid: g.id, host: g.players.get(g.host).name });
        }
      } else if (m.t === 'accept' || m.t === 'reject') {
        const g = games.get(m.gid); if (!g || g.host !== uid || g.status !== 'lobby') return;
        const p = g.players.get(+m.uid); if (!p || p.status !== 'requested') return;
        if (m.t === 'accept') p.status = 'joined'; else { g.players.delete(+m.uid); sendUser(+m.uid, { t: 'kicked' }); }
        pushState(g); pushLobby();
      } else if (m.t === 'quizAnswer') {
        const g = games.get(m.gid);
        if (!g || g.mode !== 'quiz' || g.status !== 'live' || !g.quiz || !g.players.has(uid)) return err('That quiz is not accepting answers.');
        if (!submitQuizAnswer(g.quiz, uid, Number(m.choice))) return err('Your answer was already submitted, or that option is not valid.');
        if (g.quiz.currentAnswers.size === joined(g).length) revealAndScheduleQuizAdvance(g);
        pushState(g);
      } else if (m.t === 'quizNext') {
        const g = games.get(m.gid);
        if (!g || g.mode !== 'quiz' || g.status !== 'live' || g.host !== uid || !g.quiz) return err('Only the quiz host can control the next question.');
        if (g.quiz.revealed) return err('The next question will appear automatically.');
        revealAndScheduleQuizAdvance(g);
        pushState(g);
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
  ws.on('close', () => {
    if (ws.uid == null) return;
    const sockets = online.get(ws.uid);
    sockets?.delete(ws);
    if (sockets?.size === 0) online.delete(ws.uid);
  });
});
function startGame(g) {
  [...g.players].forEach(([id, p]) => { if (p.status !== 'joined') { g.players.delete(id); sendUser(id, { t: 'kicked' }); } });
  g.status = 'live';
  if (g.mode === 'quiz') {
    g.quiz.scores = new Map(joined(g).map(([uid]) => [uid, { correct: 0, answered: 0, details: [] }]));
    scheduleQuizQuestionTimeout(g);
  } else {
    g.endsAt = Date.now() + (TEST_SECONDS ? TEST_SECONDS * 1000 : g.mins * 60000);
    g.timer = setTimeout(() => endGame(g), g.endsAt - Date.now());
  }
  pushState(g); pushLobby();
  if (g.mode !== 'quiz') aiTurn(g, true);
}
function scheduleQuizQuestionTimeout(g) {
  const quiz = g.quiz;
  clearTimeout(quiz.questionTimer);
  quiz.questionEndsAt = Date.now() + 30_000;
  quiz.advanceAt = quiz.questionEndsAt;
  quiz.questionTimer = setTimeout(() => {
    if (g.status !== 'live' || g.quiz !== quiz || quiz.revealed) return;
    revealQuizQuestion(quiz, joined(g));
    pushState(g);
  }, 25_000);
  clearTimeout(quiz.advanceTimer);
  quiz.advanceTimer = setTimeout(async () => {
    if (g.status !== 'live' || g.quiz !== quiz) return;
    if (!quiz.revealed) {
      revealQuizQuestion(quiz, joined(g));
      pushState(g);
    }
    if (quiz.index + 1 >= quiz.questions.length) {
      await endGame(g);
      return;
    }
    quiz.index += 1;
    quiz.currentAnswers.clear();
    quiz.revealed = false;
    quiz.questionEndsAt = null;
    quiz.advanceAt = null;
    scheduleQuizQuestionTimeout(g);
    pushState(g);
  }, 30_000);
}
function revealAndScheduleQuizAdvance(g) {
  const quiz = g.quiz;
  if (!quiz || !revealQuizQuestion(quiz, joined(g))) return;
  clearTimeout(quiz.questionTimer);
}
server.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
