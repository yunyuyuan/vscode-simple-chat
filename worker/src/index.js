// Cloud Chat backend: Cloudflare Worker + Durable Object (WebSocket broadcast) + D1 (persistent history)
//
// WebSocket:  GET /ws  → upgrade; the first message after connecting must be {type:'auth', password, after}
//             On success the server replies {type:'authOk'} + {type:'history', messages},
//             then every new post arrives in real time as {type:'message', message}
// HTTP (send + polling fallback):
//             GET  /messages?after=<id>   fetch messages (requires X-Password header)
//             POST /messages              send a message: write to D1 and broadcast to all connected WebSockets
//
// The source code contains no password material (neither plaintext nor hash). The salted
// SHA-256 hash lives in a Cloudflare secret:
//   node hash-password.js <password> → npx wrangler secret put PASSWORD_HASH
// For local development put it in a .dev.vars file (gitignored): PASSWORD_HASH=...

const SALT = 'cloudchat-v1:';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Password',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function checkPassword(input, env) {
  if (!input || !env.PASSWORD_HASH) return false;
  const data = new TextEncoder().encode(SALT + input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex === env.PASSWORD_HASH;
}

async function getHistory(db, after) {
  if (after > 0) {
    const { results } = await db.prepare(
      'SELECT id, name, text, image_url, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT 500'
    ).bind(after).all();
    return results;
  }
  // First load: return the most recent 200 messages
  const { results } = await db.prepare(
    'SELECT id, name, text, image_url, created_at FROM messages ORDER BY id DESC LIMIT 200'
  ).all();
  return results.reverse();
}

// Validate and insert into D1; returns the full message (with id), or null if empty
async function insertMessage(db, body) {
  const name = String(body.name || 'Anonymous').slice(0, 50);
  const text = String(body.text || '').slice(0, 4000);
  const imageUrl = body.image_url ? String(body.image_url).slice(0, 500) : null;
  if (!text && !imageUrl) return null;
  const createdAt = Date.now();
  const { meta } = await db.prepare(
    'INSERT INTO messages (name, text, image_url, created_at) VALUES (?, ?, ?, ?)'
  ).bind(name, text, imageUrl, createdAt).run();
  return { id: meta.last_row_id, name, text, image_url: imageUrl, created_at: createdAt };
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // ping/pong is answered automatically by the runtime without waking a hibernating DO (saves free-tier quota)
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // The Worker's HTTP send endpoint forwards here: persist + broadcast
    const url = new URL(request.url);
    if (url.pathname === '/send' && request.method === 'POST') {
      const message = await this.saveAndBroadcast(await request.json());
      return message ? json({ ok: true }) : json({ error: 'empty message' }, 400);
    }
    return json({ error: 'not found' }, 404);
  }

  async saveAndBroadcast(body) {
    const message = await insertMessage(this.env.DB, body);
    if (!message) return null;
    const payload = JSON.stringify({ type: 'message', message });
    for (const client of this.state.getWebSockets()) {
      if ((client.deserializeAttachment() || {}).authed) {
        try { client.send(payload); } catch {}
      }
    }
    return message;
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const attach = ws.deserializeAttachment() || {};

    if (msg.type === 'auth') {
      if (!(await checkPassword(msg.password, this.env))) {
        ws.send(JSON.stringify({ type: 'authFail', error: 'Wrong password' }));
        ws.close(4001, 'wrong password');
        return;
      }
      ws.serializeAttachment({ authed: true });
      ws.send(JSON.stringify({ type: 'authOk' }));
      const history = await getHistory(this.env.DB, Number(msg.after || 0));
      ws.send(JSON.stringify({ type: 'history', messages: history }));
      return;
    }

    if (!attach.authed) {
      ws.close(4001, 'not authed');
      return;
    }

    if (msg.type === 'send') {
      await this.saveAndBroadcast(msg);
    }
  }

  async webSocketError(ws) {
    try { ws.close(); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket entry point: auth happens via the post-connect auth message (browser/Node WS clients can't set custom headers)
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected websocket' }, 426);
      }
      return env.CHAT.get(env.CHAT.idFromName('main')).fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!(await checkPassword(request.headers.get('X-Password'), env))) {
      return json({ error: 'wrong password' }, 401);
    }

    if (url.pathname === '/messages' && request.method === 'GET') {
      return json(await getHistory(env.DB, Number(url.searchParams.get('after') || 0)));
    }

    if (url.pathname === '/messages' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      // Route through the DO so it can persist and broadcast to everyone online
      return env.CHAT.get(env.CHAT.idFromName('main')).fetch(
        new Request(url.origin + '/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }

    return json({ error: 'not found' }, 404);
  },
};
