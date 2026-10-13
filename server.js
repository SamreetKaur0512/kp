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
const Notifications = mdb.collection('notifications'), PushSubscriptions = mdb.collection('push_subscriptions');
await Users.createIndex({ nameLower: 1 }, { unique: true });
await Users.createIndex({ pub: 1 }, { unique: true });
await Users.createIndex({ wins: -1 });
await Sessions.createIndex({ token: 1 }, { unique: true });
await Sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
await FanChat.createIndex({ createdAt: -1 });
await FanChat.createIndex({ uid: 1, createdAt: -1 });
await FanChatBlocks.createIndex({ uid: 1 }, { unique: true });
await AdminSessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
await Notifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
await Notifications.createIndex({ uid: 1, createdAt: -1 });
await PushSubscriptions.createIndex({ uid: 1, endpoint: 1 }, { unique: true });
await Results.createIndex({ uid: 1, ts: -1 });
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
    const createdAt = new Date();
    try { await Users.insertOne({ _id: id, name: nm, nameLower: nm.toLowerCase(), pub: await newPub(), salt, hash: hash(String(password), salt), wins: 0, played: 0, notifications: false, createdAt }); }
    catch (e) { if (e.code === 11000) return res.status(400).json({ error: 'That name is already taken.' }); throw e; }
    await FanChat.insertOne({ kind: 'system', joinUid: id, body: `${nm} joined the fan community! Welcome 🎉`, createdAt, reactions: {} });
    for (const member of await Users.find({ _id: { $ne: id }, notifications: { $ne: false } }).project({ _id: 1 }).toArray()) await notify(member._id, 'New fan joined', `${nm} joined the community.`, 'community', id);
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
const accountUser = async (req, res, next) => { try { const u = await userBySid(cookie(req, 'sid')); if (!u) return res.status(401).json({ error: 'Sign in first.' }); req.accountUser = u; next(); } catch { res.status(500).json({ error: 'Could not verify your account.' }); } };
async function notify(uid, title, body, tag = 'community', actorUid = null) {
  try {
  const recipient = await Users.findOne({ _id: uid }, { projection: { notifications: 1 } });
  if (!recipient || recipient.notifications !== true) return;
  const createdAt = new Date();
  await Notifications.insertOne({ uid, title, body, tag, actorUid, actorName: actorUid == null ? null : (await Users.findOne({ _id: actorUid }, { projection: { name: 1 } }))?.name || null, createdAt, expiresAt: new Date(createdAt.getTime() + 86400000), read: false });
  sendUser(uid, { t: 'notification', notification: { title, body, tag, createdAt: createdAt.getTime() } });
  // Push is per device. A live session on one browser must not suppress push
  // delivery to the user's other subscribed browsers/devices.
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
    try {
      const webpush = (await import('web-push')).default;
      webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      const subs = await PushSubscriptions.find({ uid }).toArray();
      await Promise.all(subs.map(async sub => { try { await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, tag }), { TTL: 86400, urgency: 'high' }); } catch (error) { console.error('Push delivery failed:', error.statusCode || 'error', error.message); if (error.statusCode === 404 || error.statusCode === 410) await PushSubscriptions.deleteOne({ _id: sub._id }); } }));
    } catch (error) { console.error('Push notification failed:', error.message); }
  }
  } catch (error) { console.error('Could not create notification:', error.message); }
}
async function notifyChatReaction(uid, title, body, tag, actorUid) {
  try {
    const createdAt = new Date();
    const actor = await Users.findOne({ _id: actorUid }, { projection: { name: 1 } });
    await Notifications.insertOne({ uid, title, body, tag, actorUid, actorName: actor?.name || null, createdAt, expiresAt: new Date(createdAt.getTime() + 86400000), read: false });
    sendUser(uid, { t: 'notification', notification: { title, body, tag, createdAt: createdAt.getTime() } });
    const recipient = await Users.findOne({ _id: uid }, { projection: { notifications: 1 } });
    if (recipient?.notifications === true && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
      const webpush = (await import('web-push')).default;
      webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      const subs = await PushSubscriptions.find({ uid }).toArray();
      await Promise.all(subs.map(async sub => { try { await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, tag }), { TTL: 86400, urgency: 'high' }); } catch (error) { if (error.statusCode === 404 || error.statusCode === 410) await PushSubscriptions.deleteOne({ _id: sub._id }); else console.error('Push delivery failed:', error.statusCode || 'error', error.message); } }));
    }
  } catch (error) { console.error('Could not create chat reaction notification:', error.message); }
}
app.get('/api/settings', accountUser, (req, res) => res.json({ notifications: req.accountUser.notifications === true, pushKey: process.env.VAPID_PUBLIC_KEY || '' }));
app.patch('/api/settings', accountUser, async (req, res) => { try { const notifications = req.body?.notifications; if (typeof notifications !== 'boolean') return res.status(400).json({ error: 'Choose whether notifications are on or off.' }); await Users.updateOne({ _id: req.accountUser._id }, { $set: { notifications } }); res.json({ notifications }); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not save notification settings.' }); } });
app.patch('/api/account/name', accountUser, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(name)) return res.status(400).json({ error: 'Name must be 2-20 letters/numbers.' });
  try {
    const escapedName = req.accountUser.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await FanChat.updateMany({ kind: 'system', joinUid: { $exists: false }, body: { $regex: `^${escapedName} joined the fan community!` } }, { $set: { joinUid: req.accountUser._id } });
    const olderNotices = await Notifications.find({ actorUid: { $exists: false }, body: { $regex: `^${escapedName} ` } }).project({ _id: 1 }).toArray();
    if (olderNotices.length) await Notifications.updateMany({ _id: { $in: olderNotices.map(item => item._id) } }, { $set: { actorUid: req.accountUser._id, actorName: req.accountUser.name } });
    await Users.updateOne({ _id: req.accountUser._id }, { $set: { name, nameLower: name.toLowerCase() } });
    for (const game of games.values()) { const player = game.players.get(req.accountUser._id); if (player) { player.name = name; pushState(game); } }
    online.get(req.accountUser._id)?.forEach(socket => socket.close(4002));
    res.json({ name, id: req.accountUser.pub });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That name is already taken.' });
    console.error(error); res.status(500).json({ error: 'Could not change your name.' });
  }
});
app.get('/api/notifications', accountUser, async (req, res) => { try { const items = await Notifications.find({ uid: req.accountUser._id, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(100).toArray(); const actorIds = [...new Set(items.map(item => item.actorUid).filter(id => id != null))]; const actors = await Users.find({ _id: { $in: actorIds } }).project({ name: 1 }).toArray(); const actorNames = new Map(actors.map(actor => [actor._id, actor.name])); res.json({ notifications: items.map(n => { const actorName = actorNames.get(n.actorUid); return { id: n._id.toString(), title: n.title, body: actorName && n.actorName ? n.body.replace(n.actorName, actorName) : n.body, tag: n.tag, createdAt: n.createdAt.getTime(), read: n.read }; }) }); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load notifications.' }); } });
app.post('/api/notifications/read', accountUser, async (req, res) => { try { await Notifications.updateMany({ uid: req.accountUser._id, read: false }, { $set: { read: true } }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not update notifications.' }); } });
app.post('/api/push-subscription', accountUser, async (req, res) => { try { const s = req.body?.subscription; if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return res.status(400).json({ error: 'Invalid push subscription.' }); await PushSubscriptions.updateOne({ uid: req.accountUser._id, endpoint: s.endpoint }, { $set: { subscription: s } }, { upsert: true }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not save push subscription.' }); } });
app.delete('/api/push-subscription', accountUser, async (req, res) => { try { const endpoint = String(req.body?.endpoint || ''); await PushSubscriptions.deleteOne({ uid: req.accountUser._id, endpoint }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not remove push subscription.' }); } });
app.get('/api/push-status', accountUser, async (req, res) => {
  try { const subscriptions = await PushSubscriptions.find({ uid: req.accountUser._id }).project({ endpoint: 1 }).toArray(); res.json({ configured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT), endpoints: subscriptions.map(item => item.endpoint), enabled: req.accountUser.notifications === true }); }
  catch (error) { console.error(error); res.status(500).json({ error: 'Could not check push status.' }); }
});
app.post('/api/push-test', accountUser, async (req, res) => {
  try {
    if (req.accountUser.notifications !== true) return res.status(400).json({ error: 'Turn on notifications in Settings first.' });
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) return res.status(503).json({ error: 'The server is missing one or more VAPID settings.' });
    const endpoint = String(req.body?.endpoint || '');
    const sub = endpoint ? await PushSubscriptions.findOne({ uid: req.accountUser._id, endpoint }) : null;
    if (!sub) return res.status(404).json({ error: 'This device is not subscribed yet. Enable notifications again on this device.' });
    const webpush = (await import('web-push')).default;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(sub.subscription, JSON.stringify({ title: 'Karan Patel Fan Club', body: 'Website notifications are enabled on this device.', tag: 'notifications-enabled' }), { TTL: 60, urgency: 'high' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Push test failed:', error.statusCode, error.body || error.message);
    if (error.statusCode === 404 || error.statusCode === 410) await PushSubscriptions.deleteOne({ uid: req.accountUser._id });
    const message = error.statusCode === 401 ? 'The VAPID keys do not match this device subscription. Turn notifications off and on again on this device.' : error.statusCode === 404 || error.statusCode === 410 ? 'This device subscription expired. Turn notifications off and on again on this device.' : error.statusCode === 400 ? 'The push service rejected the VAPID settings. Check that VAPID_SUBJECT starts with mailto: and the key pair matches.' : `The push service returned HTTP ${error.statusCode || 'error'}. Check the Render server logs.`;
    res.status(502).json({ error: message });
  }
});
function redactDeletedMember(replies, uid) {
  for (const reply of replies || []) {
    if (reply.uid === uid) { reply.deleted = true; reply.body = 'This reply was deleted.'; delete reply.uid; }
    redactDeletedMember(reply.replies, uid);
  }
}
app.delete('/api/account', accountUser, async (req, res) => {
  const uid = req.accountUser._id;
  try {
    const posts = await FanChat.find({ uid }).toArray();
    const replies = await FanChat.find({ 'replies.uid': uid }).toArray();
    await Promise.allSettled(posts.flatMap(post => (post.media || []).map(file => cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType, invalidate: true }))));
    for (const post of replies) { redactDeletedMember(post.replies, uid); await FanChat.updateOne({ _id: post._id }, { $set: { replies: post.replies } }); }
    await Promise.all([Sessions.deleteMany({ uid }), Results.deleteMany({ uid }), Notifications.deleteMany({ uid }), PushSubscriptions.deleteMany({ uid }), FanChat.deleteMany({ uid }), FanChatBlocks.deleteMany({ uid }), Users.deleteOne({ _id: uid })]);
    online.get(uid)?.forEach(socket => socket.close(4001));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not delete your account. Please try again.' }); }
});
async function clearHostNotifications(gameId) {
  const tag = `host-${gameId}`;
  const entries = await Notifications.find({ tag }).project({ uid: 1 }).toArray();
  await Notifications.deleteMany({ tag });
  for (const uid of new Set(entries.map(entry => entry.uid))) sendUser(uid, { t: 'notificationRemove', tag });
  if (!entries.length || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) return;
  try {
    const webpush = (await import('web-push')).default;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const uids = [...new Set(entries.map(entry => entry.uid))];
    const subs = await PushSubscriptions.find({ uid: { $in: uids } }).toArray();
    await Promise.all(subs.map(sub => webpush.sendNotification(sub.subscription, JSON.stringify({ cancel: tag }), { TTL: 86400 }).catch(() => {})));
  } catch (error) { console.error('Could not clear game host push notifications:', error.message); }
}

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
    const viewer = await userBySid(cookie(req, 'sid') || '');
    const posts = await FanChat.find({}).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    const userIds = [...new Set(posts.flatMap(post => [post.uid, post.joinUid, ...collectReplyUserIds(post.replies || []), ...Object.values(post.reactions || {}).flatMap(users => users || []), ...(post.seenBy || []), ...collectReplySeenIds(post.replies || [])]).filter(id => id != null))];
    const users = await Users.find({ _id: { $in: userIds } }).project({ name: 1, pub: 1 }).toArray();
    const names = new Map(users.map(user => [user._id, { name: user.name, pub: user.pub }]));
    const messages = posts.reverse().flatMap(post => {
      if (post.kind === 'system') return [{ id: post._id.toString(), system: true, body: names.has(post.joinUid) ? `${names.get(post.joinUid).name} joined the fan community! Welcome 🎉` : post.body, created_at: post.createdAt.getTime(), reactions: reactionSummary(post.reactions, new Map([...names].map(([id, user]) => [id, user.name])), viewer) }];
      if (post.deleted) return [{ id: post._id.toString(), deleted: true, body: post.body, created_at: post.createdAt.getTime(), media: [], reactions: [], replies: [] }];
      if (!names.has(post.uid)) return [];
      return [{
        id: post._id.toString(), uid: post.uid, isMine: viewer?._id === post.uid, name: names.get(post.uid).name, body: post.body, created_at: post.createdAt.getTime(),
        media: (post.media || []).map(file => ({ id: file.id, url: file.url, name: file.name, mime: file.mime })),
        reactions: reactionSummary(post.reactions, new Map([...names].map(([id, user]) => [id, user.name])), viewer),
        seenBy: serializeSeen(post.seenBy, names, post.uid),
        replies: (post.replies || []).map(reply => serializeReply(reply, names, viewer)),
      }];
    });
    const members = onlineCount();
    res.json({ messages, members });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not load the fan chat.' }); }
});
function reactionSummary(reactions = {}, names, viewer) {
  return Object.entries(reactions).map(([emoji, uids]) => ({ emoji, count: uids.length, mine: uids.includes(viewer?._id), names: uids.map(uid => names.get(uid)).filter(Boolean) }));
}
function collectReplyUserIds(replies) { return replies.flatMap(reply => [reply.uid, ...Object.values(reply.reactions || {}).flatMap(users => users || []), ...collectReplyUserIds(reply.replies || [])]); }
function collectReplySeenIds(replies) { return replies.flatMap(reply => [...(reply.seenBy || []), ...collectReplySeenIds(reply.replies || [])]); }
function serializeSeen(ids = [], names, ownerUid) { return ids.filter(uid => String(uid) !== String(ownerUid)).map(uid => { const user = names.get(uid); return user ? { id: user.pub || String(uid), name: user.name || 'Member' } : null; }).filter(Boolean); }
function serializeReply(reply, names, viewer) {
  const plainNames = new Map([...names].map(([id, user]) => [id, user.name]));
  return { id: reply.id, uid: reply.uid, name: names.get(reply.uid)?.name || 'Member', body: reply.body, created_at: reply.createdAt.getTime(), isMine: viewer?._id === reply.uid, deleted: Boolean(reply.deleted), seenBy: serializeSeen(reply.seenBy, names, reply.uid), reactions: reactionSummary(reply.reactions, plainNames, viewer), replies: (reply.replies || []).map(child => serializeReply(child, names, viewer)) };
}
function markRepliesSeen(replies, uid) { let changed = false; for (const reply of replies || []) { reply.seenBy ||= []; if (!reply.seenBy.includes(uid)) { reply.seenBy.push(uid); changed = true; } if (markRepliesSeen(reply.replies, uid)) changed = true; } return changed; }
app.post('/api/fan-chat/:id/seen', signedIn, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  try {
    const post = await FanChat.findOne({ _id: new ObjectId(req.params.id), deleted: { $ne: true }, kind: { $ne: 'system' } });
    if (!post) return res.status(404).json({ error: 'Message not found.' });
    let changed = false; post.seenBy ||= [];
    if (!post.seenBy.includes(req.user._id)) { post.seenBy.push(req.user._id); changed = true; }
    if (markRepliesSeen(post.replies, req.user._id)) changed = true;
    if (changed) await FanChat.updateOne({ _id: post._id }, { $set: { seenBy: post.seenBy, replies: post.replies || [] } });
    res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not mark this message as seen.' }); }
});
function findReply(replies, id) { for (const reply of replies) { if (reply.id === id) return reply; const nested = findReply(reply.replies || [], id); if (nested) return nested; } return null; }
function appendChildReply(replies, parentId, child) { for (const reply of replies) { if (reply.id === parentId) { reply.replies ||= []; reply.replies.push(child); return true; } if (appendChildReply(reply.replies || [], parentId, child)) return true; } return false; }
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
      uid: req.user._id, body, createdAt: new Date(), reactions: {}, replies: [],
      media: files.map(file => ({
        id: crypto.randomBytes(12).toString('hex'),
        publicId: file.filename,
        url: file.path,
        resourceType: file.resourceType,
        name: path.basename(file.originalname).slice(0, 180),
        mime: file.mimetype,
      })),
    });
    for (const member of await Users.find({ _id: { $ne: req.user._id }, notifications: { $ne: false } }).project({ _id: 1 }).toArray()) await notify(member._id, 'New fan chat message', `${req.user.name} sent a message in the fan chat.`, 'community', req.user._id);
    res.status(201).json({ ok: true });
  } catch (error) {
    try {
      await Promise.all(files.map(file => cloudinary.uploader.destroy(file.filename, { resource_type: file.resourceType, invalidate: true })));
    } catch (cleanupError) { console.error(cleanupError); }
    console.error(error);
    res.status(500).json({ error: 'Message could not be sent.' });
  }
});
const allowedReactions = new Set(['👍', '❤️', '😂', '😮', '😢', '👏', '🔥']);
async function updateReaction(req, res, target) {
  const emoji = String(req.body?.emoji || '');
  if (!allowedReactions.has(emoji)) return res.status(400).json({ error: 'Choose an available emoji.' });
  const post = await FanChat.findOne({ _id: new ObjectId(req.params.id), deleted: { $ne: true } });
  const reply = target === 'reply' && post ? findReply(post.replies || [], req.params.replyId) : null;
  if (!post || (target === 'reply' && (!reply || reply.deleted))) return res.status(404).json({ error: 'Message not found.' });
  const bucket = target === 'reply' ? (reply.reactions ||= {}) : (post.reactions ||= {});
  const current = bucket[emoji] || [], updated = current.includes(req.user._id) ? current.filter(uid => uid !== req.user._id) : [...current, req.user._id];
  const added = !current.includes(req.user._id);
  if (updated.length) bucket[emoji] = updated; else delete bucket[emoji];
  await FanChat.updateOne({ _id: post._id }, { $set: target === 'reply' ? { replies: post.replies } : { reactions: post.reactions } });
  const owner = target === 'reply' ? reply.uid : post.uid;
  if (added && owner != null && owner !== req.user._id) await notifyChatReaction(owner, 'New reaction', `${req.user.name} reacted ${emoji} to your ${target === 'reply' ? 'reply' : 'message'}.`, 'chat-reaction', req.user._id);
  res.json({ ok: true });
}
for (const target of ['message', 'reply']) {
  const suffix = target === 'reply' ? '/replies/:replyId/reactions' : '/reactions';
  app.post(`/api/fan-chat/:id${suffix}`, signedIn, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
    try { await updateReaction(req, res, target); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not update reaction.' }); }
  });
}
app.post('/api/fan-chat/:id/replies', signedIn, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  try {
    const reply = { id: crypto.randomBytes(12).toString('hex'), uid: req.user._id, body, createdAt: new Date(), reactions: {}, replies: [] };
    const post = await FanChat.findOne({ _id: new ObjectId(req.params.id), deleted: { $ne: true }, kind: { $ne: 'system' } });
    if (!post) return res.status(404).json({ error: 'Message not found.' });
    post.replies ||= []; post.replies.push(reply);
    const result = await FanChat.updateOne({ _id: post._id }, { $set: { replies: post.replies } });
    if (!result.modifiedCount) return res.status(404).json({ error: 'Message not found.' });
    if (post.uid != null && post.uid !== req.user._id) await notify(post.uid, 'New reply', `${req.user.name} replied to your chat message.`, 'chat-reply', req.user._id);
    res.status(201).json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not send reply.' }); }
});
app.post('/api/fan-chat/:id/replies/:replyId/replies', signedIn, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  try {
    const reply = { id: crypto.randomBytes(12).toString('hex'), uid: req.user._id, body, createdAt: new Date(), reactions: {}, replies: [] };
    const postId = new ObjectId(req.params.id), post = await FanChat.findOne({ _id: postId, deleted: { $ne: true } });
    const parent = post && findReply(post.replies || [], req.params.replyId);
    if (!parent || parent.deleted) return res.status(404).json({ error: 'Reply not found.' });
    parent.replies ||= []; parent.replies.push(reply);
    const result = await FanChat.updateOne({ _id: postId }, { $set: { replies: post.replies } });
    if (!result.modifiedCount) return res.status(404).json({ error: 'Reply not found.' });
    if (parent.uid != null && parent.uid !== req.user._id) await notify(parent.uid, 'New reply', `${req.user.name} replied to your chat reply.`, 'chat-reply', req.user._id);
    res.status(201).json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not send reply.' }); }
});
async function deleteReply(req, res, replyId) {
  const post = await FanChat.findOne({ _id: new ObjectId(req.params.id), deleted: { $ne: true } });
  const reply = post && findReply(post.replies || [], replyId);
  if (!reply || reply.uid !== req.user._id || reply.deleted) return res.status(404).json({ error: 'Reply not found or it is not yours.' });
  reply.deleted = true; reply.body = 'This reply was deleted.'; delete reply.uid;
  await FanChat.updateOne({ _id: post._id }, { $set: { replies: post.replies } });
  res.json({ ok: true });
}
app.delete('/api/fan-chat/:id/replies/:replyId', signedIn, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  try { await deleteReply(req, res, req.params.replyId); } catch (error) { console.error(error); res.status(500).json({ error: 'Could not delete reply.' }); }
});
app.post('/api/fan-chat/:id/replies/:replyId/replies/:childId/replies', signedIn, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  try {
    const postId = new ObjectId(req.params.id), reply = { id: crypto.randomBytes(12).toString('hex'), uid: req.user._id, body, createdAt: new Date(), reactions: {}, replies: [] };
    const post = await FanChat.findOne({ _id: postId, deleted: { $ne: true } });
    if (!post) return res.status(404).json({ error: 'Message not found.' });
    const parent = findReply(post.replies || [], req.params.childId);
    if (!parent || parent.deleted) return res.status(404).json({ error: 'Reply not found.' });
    parent.replies ||= []; parent.replies.push(reply);
    await FanChat.updateOne({ _id: postId }, { $set: { replies: post.replies } });
    if (parent.uid != null && parent.uid !== req.user._id) await notify(parent.uid, 'New reply', `${req.user.name} replied to your chat reply.`, 'chat-reply', req.user._id);
    res.status(201).json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not send reply.' }); }
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
app.delete('/api/admin/messages/:id/replies/:replyId', requireAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  try {
    const post = await FanChat.findOne({ _id: new ObjectId(req.params.id), deleted: { $ne: true } });
    const reply = post && findReply(post.replies || [], req.params.replyId);
    if (!reply || reply.deleted) return res.status(404).json({ error: 'Reply not found.' });
    reply.deleted = true; reply.body = 'This reply was deleted.'; delete reply.uid;
    await FanChat.updateOne({ _id: post._id }, { $set: { replies: post.replies } });
    res.json({ ok: true });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Could not delete reply.' }); }
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
  const rows = await Results.aggregate([{ $group: { _id: '$uid', average: { $avg: '$pct' }, games: { $sum: 1 } } }, { $sort: { average: -1, games: -1, _id: 1 } }, { $limit: 3 }]).toArray();
  if (!rows.length) return [];
  const users = await Users.find({ _id: { $in: rows.map(row => row._id) } }).project({ name: 1, pub: 1 }).toArray();
  const byId = new Map(users.map(user => [user._id, user]));
  return rows.flatMap((row, index) => { const user = byId.get(row._id); return user ? [{ name: user.name, pub: user.pub, average: row.average, games: row.games, rank: index + 1 }] : []; });
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
  const oldTop = new Set((await leaderboard().catch(() => [])).map(player => player.pub));
  for (const [uid, , r] of res) {
    try {
      if (!(await userById(uid))) continue;
      await Users.updateOne({ _id: uid }, { $inc: { played: 1 } });
      if (r.pct != null) await Results.insertOne({ game: g.id, uid, mode: g.mode, pct: r.pct, detail: r, ts: new Date() });
    } catch (e) { console.error(e); }
    // everyone sees ONLY the top player; each player sees only their own full result
    const msg = { t: 'result', mine: r, top: top ? { name: top.name, id: top.id, pct: top.pct } : null };
    g.results.set(uid, msg); sendUser(uid, msg);
  }
  const newTop = await leaderboard().catch(() => []);
  for (const player of newTop) if (!oldTop.has(player.pub)) {
    const user = await Users.findOne({ pub: player.pub });
    if (user) await notify(user._id, 'You are in the top three!', `Your average score is ${player.average.toFixed(1)}% across ${player.games} game${player.games === 1 ? '' : 's'}.`, 'top-player');
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
    const g0 = activeGameOf(uid);
    if (g0) { send(ws, { t: 'game', g: gamePayload(g0, uid) }); send(ws, { t: 'history', msgs: g0.msgs }); }
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
        if (!MODES[m.mode]) return err('Choose Serial Role-Play or Karan Patel Quiz first.');
        const mode = m.mode, show = clamp(m.show, 60), char = clamp(m.char, 40);
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
        if (!g.solo) for (const member of await Users.find({ _id: { $ne: uid }, notifications: { $ne: false } }).project({ _id: 1 }).toArray()) await notify(member._id, 'Game hosted — not started', `${me.name} is hosting ${g.title}. Game ID: ${id}. The host has not started it yet.`, `host-${id}`, uid);
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
        const g = games.get(m.gid); if (!g || g.status !== 'lobby') return err('This lobby is no longer available.');
        if (g.host !== uid) return err('Only the host can manage join requests.');
        const p = g.players.get(+m.uid); if (!p || p.status !== 'requested') return err('This join request is no longer pending.');
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
        const g = games.get(m.gid);
        if (!g || g.status !== 'lobby') return err('This lobby is no longer available.');
        if (g.host !== uid) return err('Only the host can start this game.');
        startGame(g);
      } else if (m.t === 'say') {
        const g = games.get(m.gid), p = g?.players.get(uid);
        if (!g || g.status !== 'live' || p?.status !== 'joined') return err('You can send dialogue only after joining a live game.');
        const now = Date.now(); if (now - ws.last < 1000) return err('Slow down a little.'); ws.last = now;
        const t = clamp(m.t2, 500); if (!t) return err('Type your dialogue before pressing Send.');
        if (g.msgs.length > 300) return err('This role-play has reached its message limit.');
        addMsg(g, { uid, who: p.char, t }); aiTurn(g);
      } else if (m.t === 'end') {
        const g = games.get(m.gid);
        if (!g || g.status !== 'live') return err('This game is no longer live.');
        if (g.host !== uid) return err('Only the host can end this game.');
        endGame(g);
      } else if (m.t === 'leave') {
        const g = games.get(m.gid); if (!g) return err('This game is no longer available.');
        if (!g.players.has(uid)) return err('You are not a player in this game.');
        if (g.status === 'lobby') { if (g.host === uid) { g.players.forEach((_, id) => sendUser(id, { t: 'kicked' })); games.delete(g.id); } else { g.players.delete(uid); pushState(g); } pushLobby(); }
        else if (g.status === 'done') { /* just closing results */ }
        else return err('You cannot leave while this game is live.');
      } else return err('That action is not supported. Refresh the page and try again.');
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
  clearHostNotifications(g.id).catch(error => console.error(error));
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
  quiz.advanceTimer = setTimeout(() => advanceQuizQuestion(g, quiz), 30_000);
}
async function advanceQuizQuestion(g, quiz) {
  if (g.status !== 'live' || g.quiz !== quiz) return;
  if (!quiz.revealed) { revealQuizQuestion(quiz, joined(g)); pushState(g); }
  if (quiz.index + 1 >= quiz.questions.length) return endGame(g);
  quiz.index += 1; quiz.currentAnswers.clear(); quiz.revealed = false; quiz.questionEndsAt = null; quiz.advanceAt = null;
  scheduleQuizQuestionTimeout(g); pushState(g);
}
function revealAndScheduleQuizAdvance(g) {
  const quiz = g.quiz;
  if (!quiz || !revealQuizQuestion(quiz, joined(g))) return;
  clearTimeout(quiz.questionTimer);
  clearTimeout(quiz.advanceTimer);
  quiz.advanceAt = Date.now() + 2000;
  quiz.advanceTimer = setTimeout(() => advanceQuizQuestion(g, quiz), 2000);
}
server.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
