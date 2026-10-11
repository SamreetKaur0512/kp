import crypto from 'crypto';

export const normalizeName = value => String(value ?? '').trim().toLowerCase();

export const findUserByName = (dbRef, name) => {
  const key = normalizeName(name);
  if (!key) return undefined;
  return dbRef.prepare('SELECT * FROM users WHERE lower(name)=lower(?)').get(key);
};

export const passwordMatches = (password, user) => {
  if (!user || !user.salt || !user.hash) return false;
  const expected = Buffer.from(crypto.scryptSync(password, user.salt, 64).toString('hex'), 'hex');
  const actual = Buffer.from(user.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};
