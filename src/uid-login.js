// Logging in from a UiD. Paolo's Control Room (uid-bypaolo.10xid.com) shows
// this desk on its stage. Paolo has already signed in there, through
// login.10xid.com and its authenticator, so the desk does not ask him for its
// key as well. His UiD's server hands his browser a pass that works once and
// for at most two minutes, signed with a private key that only that server
// holds. The Worker checks the pass against the UiD's public key in
// wrangler.jsonc (UID_LOGINS) and then sets the usual login cookie. The desk
// key never leaves the Worker, and the UiD never holds it.
//
// A pass is <payload>.<signature>, both base64url. The payload is JSON:
//   { v: 1, iss: 'https://uid-bypaolo.10xid.com', aud: 'https://website.10xid.com',
//     email: 'paolo@tboxstudio.com', exp: <ms since 1970>, nonce: <random> }
// The signature is Ed25519 over the payload's base64url text. That the pass
// works only once is kept in Postgres (Store.usePass).
//
// Kept apart from worker.js so it can be tested under plain Node.

// The UiD signs passes for one minute. Anything that claims longer is refused.
export const MAX_LIFE_MS = 2 * 60 * 1000;

const PASS = /^[A-Za-z0-9_-]{1,1500}\.[A-Za-z0-9_-]{86}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes, base64url, as the UiD prints it

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// UID_LOGINS, from wrangler.jsonc: which UiDs may log in, with each one's
// public key and who it may log in.
//   { "https://uid-bypaolo.10xid.com": { "key": "<32 bytes, base64url>", "emails": ["paolo@tboxstudio.com"] } }
// wrangler passes an object; .dev.vars passes text. An entry that is not
// whole is left out, so a typo never opens the desk to anyone.
export function uidLogins(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return new Map(); }
  }
  const logins = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return logins;
  for (const [origin, entry] of Object.entries(value)) {
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) continue;
    if (typeof entry?.key !== 'string' || !KEY.test(entry.key)) continue;
    const emails = Array.isArray(entry.emails)
      ? entry.emails.filter((e) => typeof e === 'string' && e.includes('@')).map((e) => e.trim().toLowerCase())
      : [];
    if (emails.length) logins.set(origin, { key: entry.key, emails: new Set(emails) });
  }
  return logins;
}

// → { ok: true, iss, email, nonce, exp } or { ok: false, why }. `audience`
// is this desk's own origin. The signature is checked before anything the
// payload says is believed.
export async function checkPass(pass, { logins, audience, now = Date.now() }) {
  if (typeof pass !== 'string' || !PASS.test(pass)) return { ok: false, why: 'malformed' };
  const [body, sig] = pass.split('.');
  let claim;
  try { claim = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return { ok: false, why: 'malformed' }; }
  if (!claim || typeof claim !== 'object' || claim.v !== 1 || typeof claim.iss !== 'string') return { ok: false, why: 'malformed' };
  const uid = logins.get(claim.iss);
  if (!uid) return { ok: false, why: 'unknown-uid' };

  let good = false;
  try {
    const key = await crypto.subtle.importKey('raw', fromB64url(uid.key), { name: 'Ed25519' }, false, ['verify']);
    good = await crypto.subtle.verify('Ed25519', key, fromB64url(sig), new TextEncoder().encode(body));
  } catch { good = false; }
  if (!good) return { ok: false, why: 'bad-signature' };

  if (claim.aud !== audience) return { ok: false, why: 'wrong-desk' };
  if (typeof claim.exp !== 'number' || !(claim.exp > now) || claim.exp - now > MAX_LIFE_MS) return { ok: false, why: 'expired' };
  if (typeof claim.nonce !== 'string' || !NONCE.test(claim.nonce)) return { ok: false, why: 'malformed' };
  const email = typeof claim.email === 'string' ? claim.email.trim().toLowerCase() : '';
  if (!uid.emails.has(email)) return { ok: false, why: 'not-allowed' };
  return { ok: true, iss: claim.iss, email, nonce: claim.nonce, exp: claim.exp };
}
