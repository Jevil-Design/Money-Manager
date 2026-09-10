/* Google sign-in for the Money Manager server.
 *
 * Mounted by server.js as POST /api/v1/auth/google.
 * The client sends the Google OAuth access token it already holds (it needs one
 * for Drive anyway); we ask Google who it belongs to, then hand back this
 * server's own API token. No client secret is involved, so nothing secret ships
 * to the browser.
 *
 * Env:
 *   GOOGLE_CLIENT_ID   required — the token must have been issued to this client
 *   ALLOWED_EMAILS     optional comma-separated allowlist; empty means "anyone
 *                      who signs in gets their own account"
 */
'use strict';

const crypto = require('crypto');

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const uid = () => crypto.randomBytes(9).toString('hex');
const now = () => new Date().toISOString();

module.exports = function mountGoogleAuth(app, db) {
  app.post('/api/v1/auth/google', async (req, res) => {
    const accessToken = (req.body && req.body.accessToken) || '';
    if (!accessToken) return res.status(422).json({ error: 'accessToken is required.' });

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'This server has no GOOGLE_CLIENT_ID configured.' });

    let info, token_info;
    try {
      const [a, b] = await Promise.all([
        fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } }),
        fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken))
      ]);
      if (!a.ok || !b.ok) return res.status(401).json({ error: 'Google did not accept that sign-in.' });
      info = await a.json();
      token_info = await b.json();
    } catch (err) {
      return res.status(502).json({ error: 'Could not reach Google to verify the sign-in.' });
    }

    // The token must belong to OUR OAuth client, or anyone's Google token would work here.
    if (token_info.aud !== clientId && token_info.azp !== clientId) {
      return res.status(401).json({ error: 'That sign-in was issued to a different application.' });
    }
    if (!info.email || info.email_verified === false) {
      return res.status(401).json({ error: 'Google did not confirm a verified email address.' });
    }

    const allow = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && allow.indexOf(info.email.toLowerCase()) < 0) {
      return res.status(403).json({ error: 'This server is not open to ' + info.email + '.' });
    }

    // Issue (and rotate) this server's own bearer token for the account.
    const apiToken = crypto.randomBytes(24).toString('base64url');
    const ts = now();
    const existing = db.prepare('SELECT id FROM user WHERE email = ?').get(info.email);
    if (existing) {
      db.prepare('UPDATE user SET token_hash = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(hash(apiToken), info.name || '', ts, existing.id);
    } else {
      db.prepare('INSERT INTO user (id, email, name, token_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(uid(), info.email, info.name || '', hash(apiToken), ts, ts);
    }

    res.json({ token: apiToken, email: info.email, name: info.name || '', expiresIn: null });
  });
};
