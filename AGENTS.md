# AGENTS.md — Complete Architecture Guide

> This document is aimed at future maintainers and AI coding assistants. After reading it you
> should understand why every line of code is the way it is, how data flows, and how to develop,
> test, deploy, troubleshoot, and extend the project — without consulting anything else.

---

## 1. What this project is

A **minimal multi-user cloud chat room**. The client is a VSCode extension; the server runs on Cloudflare (free tier is sufficient).

Core features:

| Feature | Implementation |
|---|---|
| Password gate | Server verifies a salted SHA-256 hash; the hash lives in a Cloudflare secret — **the repo contains no password material** |
| Real-time messages | A Cloudflare Durable Object manages WebSocket connections and broadcasts; messages arrive instantly |
| Full history | Cloudflare D1 (SQLite) persists every message |
| Image messages | Auto-uploaded to the free catbox.moe image host (no signup, no key); the database stores only the URL |
| Custom name | Stored in VSCode `globalState`, survives restarts |
| Network resilience | Automatic reconnect, heartbeat keep-alive, automatic fallback to HTTP polling when WebSocket is unavailable |

Design philosophy: **radical simplicity**. Zero npm runtime dependencies (both client and server), single-file extension, single-file server.

---

## 2. Directory layout

```
.
├── AGENTS.md                    ← this document
├── README.md                    ← user-facing deployment/usage guide
├── LICENSE
├── .gitignore                   ← excludes node_modules / *.vsix / .wrangler / .dev.vars
│
├── extension/                   ← VSCode extension (client)
│   ├── package.json             ← extension manifest: commands, views, settings, entry point
│   ├── extension.js             ← all client logic (single file, incl. the webview's HTML/CSS/JS)
│   ├── README.md                ← short blurb for the Marketplace page
│   ├── media/icon.svg           ← activity bar icon
│   ├── .vscodeignore            ← files excluded from the VSIX package
│   └── .vscode/launch.json      ← for F5 debugging
│
└── worker/                      ← Cloudflare server
    ├── wrangler.toml            ← Worker config: D1 binding, Durable Object binding & migration
    ├── src/index.js             ← all server logic (single file: Worker routes + ChatRoom DO)
    ├── schema.sql               ← D1 schema (a single messages table)
    ├── hash-password.js         ← tool: turn a password into its salted hash (for setting the secret)
    └── test/ws-test.js          ← end-to-end tests: 11 scenarios (see §9)
```

---

## 3. Architecture and data flow

```
┌─────────────────────────── VSCode ────────────────────────────┐
│                                                               │
│  ┌─────────────┐  postMessage   ┌──────────────────────────┐  │
│  │   Webview    │◄─────────────►│      extension.js         │  │
│  │ (chat UI,    │                │  (extension host, Node)   │  │
│  │  plain HTML) │                │  all network I/O is here   │  │
│  └─────────────┘                └───────┬──────────┬───────┘  │
└─────────────────────────────────────────┼──────────┼──────────┘
             WebSocket (receive) + HTTP (send) │          │ HTTPS multipart
                                          ▼          ▼
                          ┌──────────────────┐   ┌──────────────┐
                          │ Cloudflare Worker │   │  catbox.moe   │
                          │ (stateless router)│   │ (image host)  │
                          └───────┬──────────┘   └──────────────┘
                                  │ /ws upgrade, /send forwarding
                                  ▼
                          ┌──────────────────┐
                          │ ChatRoom          │  single global instance
                          │ (Durable Object)  │  holds all WebSocket connections
                          └───────┬──────────┘  message in → persist → broadcast
                                  │ SQL
                                  ▼
                          ┌──────────────────┐
                          │  D1 (SQLite)      │  messages table, permanent history
                          └──────────────────┘
```

Three key data flows, step by step:

### 3.1 Login (authentication) flow

1. The user opens the chat view — either by clicking the Cloud Chat icon in the activity bar
   (the extension contributes a `WebviewViewProvider` for the `cloudchat.chatView` sidebar view)
   or via the `cloudchat.open` command, which focuses that view. The webview shows the password page.
2. The user enters the password → the webview sends `postMessage({type:'login', password})` to the
   extension host. If no server URL is configured yet, the host prompts for it first.
3. The extension host checks whether the runtime has a global `WebSocket` (Node ≥ 22):
   - **Yes** → WebSocket path: `new WebSocket(wss://…/ws)`; the **first message** after connecting is
     `{type:'auth', password, after: lastId}`.
     - Why is the password in the message body instead of the URL or a header? The standard
       browser/Node WebSocket API **cannot set custom headers**; putting it in the URL would land it
       in server logs, which is unsafe.
   - **No** → go straight to the HTTP polling path (see the fallback logic in 3.3).
4. The server (the ChatRoom DO's `webSocketMessage`) receives the auth message:
   - Computes the hex of `SHA-256(SALT + input)` and compares it with `env.PASSWORD_HASH`
     (a Cloudflare secret).
   - Failure → replies `{type:'authFail'}` and `close(4001)`.
   - Success → `ws.serializeAttachment({authed:true})` marks the connection as authenticated
     (see §5.2 for why attachments are used), replies `{type:'authOk'}`, then
     `{type:'history', messages:[...]}` (the latest 200 messages when after=0).
5. The extension host receives authOk → tells the webview to switch to the chat UI; receives
   history → renders the messages.

### 3.2 Sending a message (text and images share one path)

1. In the webview the user presses Enter (or pastes an image, or clicks the "Image" button) →
   `postMessage` to the extension host.
2. If an image is attached: the extension host first POSTs the image (Buffer) as multipart to
   `https://catbox.moe/user/api.php` (`reqtype=fileupload`) and gets back a direct image URL.
   - Why upload from the extension host instead of the webview? The webview is constrained by both
     CSP and CORS, while the extension host is a Node environment where `fetch` has no CORS
     restrictions. **All network requests in this project are made from the extension host**;
     the webview only does UI (this is an iron rule — keep it when changing code).
3. The extension host sends `{name, text, image_url}` **over HTTP** `POST /messages`
   (with the `X-Password` header) to the Worker.
   - **Why does sending go over HTTP rather than WebSocket?** A deliberate choice: HTTP gives
     "send" a single code path — no need to care whether the WS is currently connected or to queue
     retries; the HTTP response is a natural "send succeeded" ACK. WebSocket is used as a
     **receive-only** channel. (The server does also support WS sends via `{type:'send',...}` —
     covered by tests — but the extension doesn't use it.)
4. The Worker verifies the password, then **forwards the request to the ChatRoom DO**
   (`stub.fetch('/send')`).
   - Why not write to D1 directly in the Worker? Because after writing we must **broadcast** to all
     connected WebSockets, and the connections live on the DO — only the DO can iterate them.
     Consolidating "persist + broadcast" in the DO's single `saveAndBroadcast()` function lets the
     WS-send and HTTP-send entry points share it, guaranteeing identical behavior.
5. The DO runs `INSERT INTO messages ...`, gets the auto-increment id from `meta.last_row_id`,
   assembles the full message object, and sends `JSON.stringify({type:'message', message})` to
   **every authenticated** WebSocket (including the sender).
6. Each client's extension host receives the `message` event → updates `lastId` → forwards it to the
   webview for rendering. The sender also receives their own message from the broadcast (no local
   optimistic insert), so everyone sees the same ordering.

### 3.3 Reconnect, heartbeat, and fallback

- **Heartbeat**: the extension host sends the bare string `ping` every 25 seconds; the server uses
  `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))` so the
  Cloudflare runtime answers `pong` **automatically** — without waking a hibernating DO, so it
  doesn't consume free-tier quota. If the client receives no data for 60 seconds (`lastAlive`
  timeout), it proactively `close()`s to trigger a reconnect.
- **Reconnect**: an authenticated connection that drops unexpectedly reconnects after 3 seconds,
  sending `after: lastId` in the auth message; the server returns only messages with `id > after` →
  **no duplicate rendering** and no lost messages (gaps are filled).
- **Fallback**: if the WebSocket fails before ever authenticating (e.g. corporate networks that
  kill WS):
  - At login: immediately verify the password and fetch history via HTTP `GET /messages?after=0`;
    on success enter **polling mode** (`GET /messages?after=lastId` every 3 seconds).
  - At runtime: downgrade to polling after 3 consecutive failures.
  - Messages sent by polling users are still broadcast via the DO, so **polling users and WS users
    can chat together** and see each other's messages.
- **Mode flag**: the extension host's module-level `mode` variable (`'ws'` | `'poll'`). After a
  successful send, only polling mode proactively calls `fetchNew()` (WS mode just waits for the
  broadcast).

---

## 4. Server in detail (`worker/src/index.js`, one file, two parts)

### 4.1 Worker routing layer (`export default { fetch }`)

Stateless; its only responsibilities are routing, CORS, and password verification for HTTP requests.

| Route | Method | Auth | Behavior |
|---|---|---|---|
| `/ws` | GET (Upgrade: websocket) | ❌ not here | Forwards to the ChatRoom DO for the WS upgrade; auth happens in the post-connect auth message |
| `/messages?after=<id>` | GET | `X-Password` header | `after>0`: messages with `id>after` (ascending, LIMIT 500); `after=0`: latest 200 (fetched descending, then reversed) |
| `/messages` | POST | `X-Password` header | Forwards to the DO's `/send`: persist + broadcast; body is `{name, text, image_url}` |
| anything else | * | - | 404 |

- OPTIONS preflight passes straight through (returns CORS headers). CORS is `*` because auth relies
  on the password header, not same-origin.
- Password check `checkPassword(input, env)`: `hex(SHA256(SALT + input)) === env.PASSWORD_HASH`.
  `SALT` is a constant hardcoded in the source (`'cloudchat-v1:'` — the salt is not a secret; its
  job is to defeat generic rainbow tables). `PASSWORD_HASH` comes **only** from the environment
  (secret or .dev.vars); **if unset, everything is rejected** (returns false — it does not fail open!).

### 4.2 ChatRoom Durable Object (`export class ChatRoom`)

**Why a DO is needed**: ordinary Worker invocations are isolated per request and cannot "iterate all
current WebSocket connections". A DO is a global singleton instance; all WS connections are accepted
onto it, which is what makes broadcasting possible.

**Single global instance**: the Worker always resolves the same instance via
`env.CHAT.idFromName('main')` — the same name always maps to the same DO. The whole chat room is
this one object (single-room design). To add multi-room support later, replace `'main'` with a room
name and add a `room` column to the D1 table.

**It uses the WebSocket Hibernation API (important — read before changing this code)**:

- `this.state.acceptWebSocket(ws)` (not the legacy `ws.accept()`): connections are attached to the
  runtime, so an idle DO can **hibernate** (not billed) and is woken when a message arrives.
  This is the entire reason the free tier can sustain it long-term.
- Events are not `ws.addEventListener` but class methods: `webSocketMessage(ws, raw)`,
  `webSocketError(ws)`.
- **Hibernation wipes memory!** Per-connection "authenticated" state must NOT live in JS
  variables/Maps; it must be stored with `ws.serializeAttachment({authed:true})` and read back with
  `ws.deserializeAttachment()` — attachments are persisted by the runtime and survive hibernation.
  **Do not put connection state on `this.xxx`.**
- `this.state.getWebSockets()` returns all current connections (including hibernating ones); the
  broadcast filters each one via `deserializeAttachment()` for authed status before sending.
- The constructor's `setWebSocketAutoResponse('ping'→'pong')` means heartbeats never wake the DO.

**The DO's fetch has two entry points** (both forwarded internally from the Worker; the outside
world cannot bypass the Worker to reach the DO):

1. `Upgrade: websocket` → `new WebSocketPair()`, accept the server half, return 101 + the client half.
2. `POST /send` → `saveAndBroadcast(body)` → returns `{ok:true}` or 400.

**Corresponding wrangler.toml config**:

```toml
[[durable_objects.bindings]]
name = "CHAT"                    # env.CHAT
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]   # SQLite-backed DO — required on the free tier; do NOT use new_classes
```

### 4.3 D1 database

One table (`schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- message sequence number; also the incremental-sync cursor
  name TEXT NOT NULL,                     -- sender nickname (≤50 chars, truncated server-side)
  text TEXT,                              -- text content (≤4000, may be empty string)
  image_url TEXT,                         -- image host URL (nullable; text and image_url are never both empty)
  created_at INTEGER NOT NULL             -- server timestamp Date.now() (ms)
);
```

- `id` is auto-incrementing and monotonic — the **foundation of the whole sync protocol**: a client
  only needs to remember the largest id it has seen (`lastId`); `after=lastId` always fills gaps
  exactly, idempotently, with no duplicates.
- There is exactly one INSERT statement, in `insertMessage()`; validation (length truncation,
  rejecting empty content) also lives there, shared by both send paths.
- Timestamps are always generated **server-side**, avoiding out-of-order display from skewed client
  clocks.

### 4.4 WebSocket protocol (all messages are JSON text, except the heartbeat)

Client → server:

| Message | Notes |
|---|---|
| `{type:'auth', password, after}` | Must be the first message after connecting. `after`: highest known message id; 0 requests full history |
| `{type:'send', name, text, image_url}` | Send a message (the extension doesn't use this path — it POSTs over HTTP — but the protocol supports it) |
| bare string `ping` | Heartbeat; the runtime auto-replies with the bare string `pong` |

Server → client:

| Message | Notes |
|---|---|
| `{type:'authOk'}` | Authentication succeeded |
| `{type:'authFail', error}` | Wrong password; the server then closes the connection with code 4001 |
| `{type:'history', messages:[…]}` | Sent right after authOk; contents depend on the auth message's `after` |
| `{type:'message', message:{id,name,text,image_url,created_at}}` | Real-time broadcast of a new message |

Any non-auth message from an unauthenticated connection → immediate `close(4001)`.

---

## 5. Extension in detail (`extension/extension.js`, one file, three parts)

### 5.1 File structure (top to bottom)

1. **Module-level state**: `extContext / panel / mode / ws / wsFails / reconnectTimer / pingTimer /
   lastAlive / pollTimer / lastId / password`. There is at most one chat view at a time (singleton),
   hence module-level variables instead of a class. Everything resets when the view is disposed
   (`onDidDispose`).
2. **Network layer**:
   - `api(path, options)`: HTTP wrapper for the Worker; automatically adds the `X-Password` header;
     401 throws the special error `'WRONG_PASSWORD'` (callers use it to distinguish "wrong password"
     from "network down").
   - `uploadImage(buffer, filename)`: catbox upload; returns the URL text on success.
   - Everything uses the Node 18+ globals `fetch` / `FormData` / `Blob` — **zero dependencies**.
3. **Connection engine**: `connectWs()` (connect + event handling), `onWsDown()` (failure backoff
   and fallback decisions), `startPing()` (heartbeat and stale-connection detection),
   `startPolling()/fetchNew()` (polling mode), `closeWs()` (cleanup). State machine in §3.3.
4. **`activate()` / `resolveWebviewView()`**: registers the two commands and the
   `WebviewViewProvider` for the `cloudchat.chatView` sidebar view (with
   `retainContextWhenHidden: true`, so switching away doesn't destroy the chat). The
   `cloudchat.open` command focuses the view (prompting for the server URL first if unset).
   Webview messages are handled in `resolveWebviewView` (protocol table in 5.2).
5. **`getHtml()`**: returns the complete webview HTML string (inline CSS/JS).

### 5.2 extension host ↔ webview message protocol

webview → extension host (`vscode.postMessage(...)`):

| Message | Trigger | Extension host handling |
|---|---|---|
| `{type:'login', password}` | "Join" on the login page | (prompt for server URL if unset) → store password → open WS (or HTTP fallback) → reply loginOk/loginFail |
| `{type:'saveName', name}` | name input `change` | writes `globalState['cloudchat.name']` |
| `{type:'send', name, text, imageBase64?, imageName?}` | send / paste image | (upload image first if present) → HTTP POST /messages → reply sent/error |
| `{type:'pickImage', name}` | "Image" button | `showOpenDialog` → upload → POST → reply sent/error |

extension host → webview (`webview.postMessage(...)`):

| Message | Meaning | Webview handling |
|---|---|---|
| `{type:'loginOk', name}` | auth succeeded (**also fired on reconnect**) | switch to chat UI; fill the name only if the input is empty (don't clobber an edit in progress); grab focus only the first time |
| `{type:'loginFail', error}` | wrong password / unreachable | show the error on the login page, re-enable the button |
| `{type:'messages', messages:[…]}` | a batch of new messages (history, increment, or single broadcast) | append each; auto-scroll if already at the bottom |
| `{type:'sent'}` | send completed | re-enable the input |
| `{type:'status', text}` | progress notice (e.g. "Uploading image…") | gray text in the status bar |
| `{type:'error', text}` | send failed | red status-bar text, auto-clears after 5 s, re-enables input |
| `{type:'online'}` / `{type:'offline'}` | connection state change | the top-right dot turns green/red |

### 5.3 Webview UI notes

- **Theme-aware**: every color uses VSCode CSS variables (`--vscode-editor-background` etc.), so
  light/dark themes are followed automatically.
- **CSP**: `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-…'`.
  `img-src https:` is needed to render image-host pictures. Scripts must carry the nonce.
- **XSS safety**: messages are rendered **only** with `textContent` / `createElement` — never build
  `innerHTML` from user input. Preserve this when touching the rendering code.
- **Paste-to-send**: listens to the textarea's `paste` event, extracts `image/*` from
  `clipboardData.items`, converts to base64 via FileReader, and hands it to the extension host
  (the webview cannot access file paths and must not make network requests).
- Name coloring: the nickname string hashes to an HSL hue, so the same name always gets the same color.

### 5.4 package.json highlights

- `main: "./extension.js"` — no build step, plain JS.
- Commands: `cloudchat.open` (focus the chat view), `cloudchat.setServer` (set the server URL).
- Views: an activity-bar container `cloudchat` (icon `media/icon.svg`) containing the webview view
  `cloudchat.chatView` — this is the sidebar chat UI.
- Setting: `cloudchat.serverUrl` (Worker URL, stored in the user's global settings). If empty, the
  extension prompts for it on first login/open.
- `engines.vscode: ^1.85.0`. Note: the global `WebSocket` requires Node ≥ 22 (roughly VSCode 1.101+);
  older VSCode automatically falls into polling mode — nothing is lost except "instant" becomes
  "within 3 seconds".

---

## 6. Security design (and why)

1. **No password traces in the repo** (neither plaintext nor hash). Historical note: an early
   version had the hash in the source; the hash of a short password in a public repo can be
   brute-forced, so it was moved to a Cloudflare secret.
2. Password hash = hex of `SHA-256('cloudchat-v1:' + password)`. The salt hardcoded in the source
   **is not a secret** — its only purpose is defeating precomputed rainbow tables. Generator:
   `node worker/hash-password.js <password>`.
3. Where the hash lives:
   - Production: `npx wrangler secret put PASSWORD_HASH` (stored at Cloudflare; changing the
     password takes effect immediately, no redeploy).
   - Local development: the `worker/.dev.vars` file, format `PASSWORD_HASH=<hex>`, gitignored.
   - **When `env.PASSWORD_HASH` is unset the server rejects everything** (fail-closed). The symptom
     of forgetting to set the secret after deploying is "every password says wrong password" —
     check this first when troubleshooting.
4. Auth state lives in the WebSocket attachment (§4.2); unauthenticated connections that send
   messages are disconnected.
5. Known trade-offs (simplicity first — future maintainers should know):
   - The password is a shared passphrase; there are no user accounts. Anyone with the passphrase can
     impersonate anyone (names are self-reported by clients).
   - SHA-256 is not a slow hash (bcrypt/argon2); the defenses are "the hash is not public" and
     "the password can be rotated at any time".
   - The image host is the public catbox.moe — **image URLs have no auth**; anyone with a URL can
     view the image. Don't paste sensitive screenshots.
   - Messages are stored in plaintext in D1 (encrypted at rest by Cloudflare, but visible to the
     account admin).

---

## 7. Deployment guide

```bash
cd worker

npx wrangler login                       # 1. Log in to Cloudflare (browser auth)
npx wrangler d1 create cloudchat         # 2. Create the D1 DB; copy the printed database_id into wrangler.toml
npx wrangler d1 execute cloudchat --remote --file=./schema.sql   # 3. Create the table
npx wrangler deploy                      # 4. Deploy (runs the DO migration); note the workers.dev URL
node hash-password.js <your-password>    # 5. Generate the hash
npx wrangler secret put PASSWORD_HASH    #    paste the hash, press Enter
```

Extension side:

```bash
cd extension
npx @vscode/vsce package                 # produces cloud-chat-x.y.z.vsix
# VSCode → Extensions panel → … → "Install from VSIX"; or press F5 in extension/ during development
```

First use: click the Cloud Chat icon in the activity bar (or Command Palette → `Cloud Chat: Open`)
→ enter the Worker URL → enter the password.

**Changing the password**: rerun step 5 with a new password; existing clients lose access on their
next connection. No code changes or redeploys needed.

---

## 8. Local development

```bash
cd worker
# Prepare a local password (example: dev123, anything works):
node hash-password.js dev123            # write the output into .dev.vars: PASSWORD_HASH=<output>
npx wrangler dev --local --port 8789    # miniflare simulates Worker+DO+D1 locally, no Cloudflare account needed
npx wrangler d1 execute cloudchat --local --file=./schema.sql   # create the local table on first run
```

Point the extension at the local server: set `cloudchat.serverUrl` to `http://127.0.0.1:8789`
(the code converts `http→ws` automatically).

Note: local D1 data lives in `worker/.wrangler/` (gitignored); delete that directory to wipe local data.

## 9. Testing

```bash
# Start the local server per §8, then:
cd worker
node test/ws-test.js dev123             # the argument is the plaintext password matching .dev.vars
```

11 assertions covering: wrong password rejected and disconnected / two-client auth / history fetch /
WS send broadcast to both clients / HTTP send received by WS clients / ping-pong heartbeat /
reconnect with `after` yields zero duplicates / unauthenticated senders get kicked.
Requires Node ≥ 22 (uses the global WebSocket). A full pass prints `11/11 passed` and exits 0.

Any server change **must** be followed by a test run; after changing the extension's connection
engine, verify manually with F5 (two VSCode windows chatting, disconnect/reconnect, rename,
paste an image).

---

## 10. Known limitations and extension roadmap

| Limitation | Current state | Where to start if you build it |
|---|---|---|
| Single room | The whole world shares one ChatRoom instance | Replace `idFromName('main')` with a room name; add a room column to messages; add a room parameter to URLs |
| History cap | First load fetches only the latest 200 | Add a paginated endpoint with a `before` parameter + scroll-up loading in the webview |
| No delete/edit | Not supported | Add a deleted flag in D1; broadcast `{type:'delete', id}`; handle it in the webview |
| No online count/roster | Not supported | `getWebSockets().length` in the DO; store the name in the attachment |
| Single image-host dependency | catbox.moe, flaky from some regions | `uploadImage()` is the only entry point; switching to sm.ms / R2 means changing that one function |
| Polling-mode latency | Up to 3 seconds | The `POLL_INTERVAL` constant; or switch to long-polling |
| No notifications | No new-message alerts | On `message` in the extension host, call `window.showInformationMessage` or a status-bar counter |

**Free-tier reference** (Cloudflare free plan, early 2026): Workers 100k requests/day; SQLite DOs
have free request and storage quotas, and hibernation (§4.2) means an idle room costs essentially
nothing; D1 free tier is 5M row reads/day and 100k row writes/day. Far more than a small group chat
needs.

## 11. Development conventions (for future contributors / AI)

1. **Zero runtime dependencies** is a feature, not laziness: don't pull in npm packages for small things.
2. Keep the single-file structure; only consider splitting a file once it exceeds ~800 lines.
3. All network requests happen in the extension host; the webview does UI only.
4. Never render messages by concatenating user input into innerHTML.
5. Never keep connection state in DO memory (hibernation wipes it); always use attachments.
6. For any password-related change, verify no secrets landed in the repo; update §6–§7 of this
   document alongside secret-handling changes.
7. UI copy, comments, and documentation are written in English.
