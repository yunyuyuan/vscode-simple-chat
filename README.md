# ☁️ Cloud Chat (minimal VSCode extension)

Minimal cloud chat room: enter with a password, chat history persisted forever in Cloudflare D1, images auto-uploaded to the free image host [catbox.moe](https://catbox.moe) (no signup, no API key).

The repository contains no password material (neither plaintext nor hash) — the salted SHA-256 hash of the password lives in a Cloudflare secret, and the server hashes the user's input the same way and compares.

```
cloud-chat/
├── worker/       # Backend: Cloudflare Worker + D1
└── extension/    # VSCode extension
```

## 1. Deploy the backend (~2 minutes)

Prerequisite: a Cloudflare account (the free tier is enough).

```bash
cd worker

# 1. Log in to Cloudflare (opens a browser for authorization)
npx wrangler login

# 2. Create the D1 database
npx wrangler d1 create cloudchat
#    The command prints a database_id — copy it into database_id = "REPLACE_ME" in wrangler.toml

# 3. Create the table
npx wrangler d1 execute cloudchat --remote --file=./schema.sql

# 4. Deploy
npx wrangler deploy
#    On success it prints the URL, e.g. https://cloudchat.xxx.workers.dev  ← note it down

# 5. Set the chat room password (the hash is stored as a Cloudflare secret, never committed)
node hash-password.js your-password      # prints the hash
npx wrangler secret put PASSWORD_HASH    # paste the hash from the previous step
```

For local development (`npx wrangler dev --local`), create a `.dev.vars` file under `worker/` (already gitignored):

```
PASSWORD_HASH=the hash printed above
```

## 2. Install the extension

Option A (package and install, best for sharing):

```bash
cd extension
npx @vscode/vsce package
# produces cloud-chat-x.y.z.vsix
# In VSCode: Extensions panel → top-right ... → "Install from VSIX"
```

Option B (local development): open the `extension/` folder in VSCode and press `F5`.

## 3. Usage

1. Click the chat icon in the activity bar (left icon bar) to open the sidebar, or run **Cloud Chat: Open** via `Cmd+Shift+P`
2. On first use, enter the Worker URL (the `https://cloudchat.xxx.workers.dev` printed during deployment)
3. Enter the agreed password
4. Set your name at the top (remembered automatically)
5. Send messages: Enter to send, Shift+Enter for a newline
6. Send images: click the "Image" button, or simply **paste a screenshot** into the input box (auto-uploaded to the image host, then sent)

## Changing the password

```bash
cd worker
node hash-password.js your-new-password
npx wrangler secret put PASSWORD_HASH   # paste the new hash; effective immediately, no redeploy needed
```

## Features

- ✅ Password gate (the server verifies a salted hash — not just client-side decoration)
- ✅ **Real-time push over WebSocket** (Durable Object broadcast, works on the free tier; messages arrive instantly, no polling)
- ✅ Automatic reconnect with heartbeat keep-alive; falls back to HTTP polling when WebSocket is blocked
- ✅ Full chat history (stored in D1; the latest 200 messages on first load, incremental catch-up by id on reconnect, no duplicates)
- ✅ Custom display name (stored in VSCode global state, survives restarts)
- ✅ Image messages (auto-uploaded to the free catbox.moe host; only the URL is stored in D1)
- ✅ Connection status dot (green = connected, red = offline)
