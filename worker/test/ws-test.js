// WebSocket end-to-end test (requires Node >= 22 for the global WebSocket)
//
// Usage:
//   1. Create .dev.vars in worker/ (see README), then start the local server:
//        npx wrangler dev --local --port 8789
//   2. In another terminal (the password is passed as an argument, never hardcoded):
//        node test/ws-test.js <your-password>
//
// Covers: auth success/failure, history fetch, WS broadcast, HTTP-send broadcast,
// heartbeat, incremental reconnect, and kicking unauthenticated clients.
const PASSWORD = process.argv[2] || process.env.CHAT_PASSWORD;
if (!PASSWORD) {
  console.error('Usage: node test/ws-test.js <chat-password>   (or set the CHAT_PASSWORD env var)');
  process.exit(1);
}
const BASE = process.env.CHAT_BASE || 'http://127.0.0.1:8789';
const WS = BASE.replace('http', 'ws') + '/ws';

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
}

function connect(label, password, after = 0) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS);
    const client = { sock, label, events: [], authed: false };
    const timer = setTimeout(() => reject(new Error(label + ' timeout')), 8000);
    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', password, after }));
    sock.onmessage = (ev) => {
      if (ev.data === 'pong') { client.events.push({ type: 'pong' }); return; }
      const m = JSON.parse(ev.data);
      client.events.push(m);
      if (m.type === 'authOk') { client.authed = true; clearTimeout(timer); resolve(client); }
      if (m.type === 'authFail') { clearTimeout(timer); resolve(client); }
    };
    sock.onerror = () => {};
    sock.onclose = () => { client.closed = true; };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};

(async () => {
  // 1. Wrong password
  const bad = await connect('bad', PASSWORD + '_WRONG');
  check('wrong password is rejected', !bad.authed && bad.events.some((e) => e.type === 'authFail'));
  await waitFor(() => bad.closed, 3000);
  check('wrong-password connection is closed by the server', !!bad.closed);

  // 2. Two clients with the correct password
  const a = await connect('A', PASSWORD);
  const b = await connect('B', PASSWORD);
  check('client A authenticates', a.authed);
  check('client B authenticates', b.authed);

  await waitFor(() => a.events.some((e) => e.type === 'history'));
  const histA = a.events.find((e) => e.type === 'history');
  check('A receives message history', !!histA && Array.isArray(histA.messages));

  // 3. A sends via WebSocket; both clients should receive it in real time
  a.sock.send(JSON.stringify({ type: 'send', name: 'Alice', text: 'message sent via WS' }));
  const wsMsgOk = await waitFor(() =>
    a.events.some((e) => e.type === 'message' && e.message.text === 'message sent via WS') &&
    b.events.some((e) => e.type === 'message' && e.message.text === 'message sent via WS'));
  check('WS send → broadcast reaches both A and B', wsMsgOk);

  // 4. Send via HTTP POST (the path the extension actually uses); WS clients should receive the broadcast
  const res = await fetch(BASE + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Password': PASSWORD },
    body: JSON.stringify({ name: 'Carol', text: 'message sent via HTTP' }),
  });
  check('HTTP send returns ok', (await res.json()).ok === true);
  const httpMsgOk = await waitFor(() =>
    b.events.some((e) => e.type === 'message' && e.message.text === 'message sent via HTTP'));
  check('HTTP send → WS clients receive the broadcast', httpMsgOk);

  // 5. ping/pong heartbeat
  a.sock.send('ping');
  check('ping → pong heartbeat', await waitFor(() => a.events.some((e) => e.type === 'pong')));

  // 6. Reconnect with `after` fetches only the increment (no duplicated history)
  const lastMsg = b.events.filter((e) => e.type === 'message').pop();
  const c = await connect('C', PASSWORD, lastMsg.message.id);
  await waitFor(() => c.events.some((e) => e.type === 'history'));
  const histC = c.events.find((e) => e.type === 'history');
  check('reconnect with after fetches only the increment (should be empty)', !!histC && histC.messages.length === 0);

  // 7. Sending without authenticating should get the client kicked
  const raw = new WebSocket(WS);
  await new Promise((r) => (raw.onopen = r));
  let rawClosed = false;
  raw.onclose = () => (rawClosed = true);
  raw.send(JSON.stringify({ type: 'send', name: 'x', text: 'sneak attack' }));
  check('unauthenticated send gets disconnected', await waitFor(() => rawClosed, 3000));

  a.sock.close(); b.sock.close(); c.sock.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test error:', e.message); process.exit(1); });
