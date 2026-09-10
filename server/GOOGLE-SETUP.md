# Setting up Google sync

You need one thing from Google: an **OAuth client ID**. It's free, takes about
five minutes, and the same ID covers both routes — Drive backups and Google
sign-in against your own server.

## 1. Create the OAuth client

1. Open <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library →** search *Google Drive API* → **Enable**.
   (Skip this if you only want Google sign-in for your own server.)
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name, your email, developer email — that's enough
   - **Scopes:** add `.../auth/drive.file`, `openid`, `email`, `profile`
   - **Test users:** add your own Google address
   - Leave it in *Testing*. That's fine indefinitely for personal use; only
     publishing (for other people's accounts) needs Google's review.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorised JavaScript origins:** the exact origin the app is served from,
     scheme and port included — e.g. `https://money.yourdomain.com`, or
     `http://localhost:8080` while testing locally
   - No redirect URI is needed (the app uses the token flow)
5. Copy the client ID — it ends in `.apps.googleusercontent.com`.

Paste it into the app: **Settings → Cloud backup & sync → Google client ID**.

> **The one hard limitation:** Google only issues tokens to origins you listed
> in step 4. Sign-in will fail from a preview or share URL you don't control.
> Serve the app from your own domain (or `localhost`) and it works.

## 2a. Drive route — nothing to host

Pick **Backup to: Google Drive**, click **Sign in with Google**, approve the
Drive permission, then **Push backup now**.

- The file lands in a visible **Money Manager** folder in your Drive, as
  `money-manager-backup.json` — you can open, download or share it yourself.
- The `drive.file` scope only grants access to files this app creates. It cannot
  read anything else in your Drive.
- Drive keeps version history for that file, so **Refresh snapshots** lists
  earlier versions and any one can be restored.
- Another device: same client ID, same Google account, **Pull latest**.

## 2b. Server route — Google proves who you are

Run the server with the client ID in its environment:

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
ALLOWED_EMAILS=you@gmail.com \
npm start
```

In the app, set **Backup to: My server**, fill in the server URL, then
**Sign in with Google**. The app sends its Google token to
`POST /api/v1/auth/google`; the server asks Google whose token it is, checks it
was issued to *your* client ID, and returns its own API token, which the app
stores for you. No token typing, and no client secret in the browser.

`ALLOWED_EMAILS` is an allowlist — leave it unset only if you're happy for
anyone who signs in to get their own account on your server.

## Which one should I use?

| | Google Drive | Your server |
|---|---|---|
| Hosting | none | you run it |
| Where data lives | your Drive | your storage volume |
| Version history | Drive's own | last 40 snapshots (`KEEP_SNAPSHOTS`) |
| Query data with SQL | no | yes, normalised tables |
| Works across devices | yes | yes |

Both can stay switched on — the destination toggle is per push, so you can keep
a Drive copy and a server copy of the same data.

## Sanity checks

- *"Google rejected this origin"* — the origin in step 4 doesn't match exactly.
  `http` vs `https`, a port, or a trailing slash all count as different.
- *"Google access expired"* — access tokens last about an hour by design. Click
  **Re-authorise Google**; nothing is lost, and local data is untouched.
- *"That sign-in was issued to a different application"* — the app's client ID
  and the server's `GOOGLE_CLIENT_ID` are different values.
