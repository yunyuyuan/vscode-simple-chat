const vscode = require('vscode');

const CATBOX_API = 'https://catbox.moe/user/api.php';
const POLL_INTERVAL = 3000;

let extContext = null;
let panel = null;
let mode = 'ws'; // 'ws' = real-time WebSocket push; 'poll' = HTTP polling fallback
let ws = null;
let wsFails = 0;
let reconnectTimer = null;
let pingTimer = null;
let lastAlive = 0;
let pollTimer = null;
let lastId = 0;
let password = '';

function getServerUrl() {
  return vscode.workspace
    .getConfiguration('cloudchat')
    .get('serverUrl', '')
    .replace(/\/+$/, '');
}

async function api(path, options = {}) {
  const base = getServerUrl();
  if (!base) throw new Error('Server URL not configured. Run "Cloud Chat: Set Server URL" first');
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Password': password,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('WRONG_PASSWORD');
  if (!res.ok) throw new Error('Server error ' + res.status);
  return res.json();
}

async function uploadImage(buffer, filename) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([buffer]), filename || 'image.png');
  const res = await fetch(CATBOX_API, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'Mozilla/5.0 (cloud-chat vscode extension)' },
  });
  const text = (await res.text()).trim();
  if (!res.ok || !text.startsWith('http')) {
    throw new Error('Image upload failed: ' + text.slice(0, 100));
  }
  return text;
}

function savedName() {
  return extContext ? extContext.globalState.get('cloudchat.name', '') : '';
}

// ---------- HTTP polling (fallback channel when WebSocket is unavailable) ----------

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchNew(webview) {
  try {
    const msgs = await api('/messages?after=' + lastId);
    if (msgs.length) {
      lastId = msgs[msgs.length - 1].id;
      webview.postMessage({ type: 'messages', messages: msgs });
    }
    webview.postMessage({ type: 'online' });
  } catch (e) {
    webview.postMessage({ type: 'offline' });
  }
}

function startPolling(webview) {
  stopPolling();
  pollTimer = setInterval(() => fetchNew(webview), POLL_INTERVAL);
}

// ---------- WebSocket real-time channel ----------

function closeWs() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    const s = ws;
    ws = null;
    try { s.close(); } catch {}
  }
}

function startPing(socket) {
  if (pingTimer) clearInterval(pingTimer);
  lastAlive = Date.now();
  pingTimer = setInterval(() => {
    if (ws !== socket) return;
    if (Date.now() - lastAlive > 60000) {
      try { socket.close(); } catch {} // stale connection; trigger onclose to reconnect
      return;
    }
    try { socket.send('ping'); } catch {}
  }, 25000);
}

function connectWs(webview, isLogin) {
  closeWs();
  let authed = false;
  let socket;
  try {
    socket = new WebSocket(getServerUrl().replace(/^http/, 'ws') + '/ws');
  } catch (e) {
    onWsDown(webview, isLogin);
    return;
  }
  ws = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'auth', password, after: lastId }));
  };

  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    lastAlive = Date.now();
    if (ev.data === 'pong') return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'authOk':
        authed = true;
        wsFails = 0;
        webview.postMessage({ type: 'loginOk', name: savedName() });
        webview.postMessage({ type: 'online' });
        startPing(socket);
        break;
      case 'authFail':
        password = '';
        webview.postMessage({ type: 'loginFail', error: 'Wrong password' });
        break;
      case 'history':
        if (m.messages.length) {
          lastId = m.messages[m.messages.length - 1].id;
          webview.postMessage({ type: 'messages', messages: m.messages });
        }
        break;
      case 'message':
        lastId = m.message.id;
        webview.postMessage({ type: 'messages', messages: [m.message] });
        break;
    }
  };

  socket.onerror = () => {}; // handled uniformly in onclose

  socket.onclose = () => {
    if (ws !== socket) return; // replaced by a newer connection or closed intentionally
    ws = null;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (!password || !panel) return; // wrong password or view disposed; don't reconnect
    webview.postMessage({ type: 'offline' });
    if (authed) {
      reconnectTimer = setTimeout(() => connectWs(webview, false), 3000);
    } else {
      onWsDown(webview, isLogin);
    }
  };
}

// WebSocket unreachable: on login, try the HTTP fallback right away; otherwise retry a few times before downgrading
async function onWsDown(webview, isLogin) {
  wsFails++;
  if (!isLogin && wsFails < 3) {
    reconnectTimer = setTimeout(() => connectWs(webview, false), 3000);
    return;
  }
  try {
    const msgs = await api('/messages?after=' + lastId);
    mode = 'poll';
    if (isLogin) webview.postMessage({ type: 'loginOk', name: savedName() });
    if (msgs.length) {
      lastId = msgs[msgs.length - 1].id;
      webview.postMessage({ type: 'messages', messages: msgs });
    }
    webview.postMessage({ type: 'online' });
    startPolling(webview);
  } catch (e) {
    if (isLogin) {
      password = '';
      webview.postMessage({
        type: 'loginFail',
        error: e.message === 'WRONG_PASSWORD' ? 'Wrong password' : 'Connection failed: ' + e.message,
      });
    } else {
      reconnectTimer = setTimeout(() => connectWs(webview, false), 5000);
    }
  }
}

async function setServerUrl() {
  const current = getServerUrl();
  const input = await vscode.window.showInputBox({
    prompt: 'Enter the Cloudflare Worker URL',
    placeHolder: 'https://cloudchat.xxx.workers.dev',
    value: current,
    ignoreFocusOut: true,
  });
  if (input) {
    await vscode.workspace
      .getConfiguration('cloudchat')
      .update('serverUrl', input.trim(), vscode.ConfigurationTarget.Global);
  }
  return getServerUrl();
}

function activate(context) {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudchat.setServer', setServerUrl),
    vscode.commands.registerCommand('cloudchat.open', async () => {
      if (!getServerUrl()) {
        const url = await setServerUrl();
        if (!url) return;
      }
      vscode.commands.executeCommand('cloudchat.chatView.focus');
    }),
    vscode.window.registerWebviewViewProvider(
      'cloudchat.chatView',
      { resolveWebviewView },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

function resolveWebviewView(view) {
  panel = view;
  view.webview.options = { enableScripts: true };
  view.webview.html = getHtml();

  view.onDidDispose(() => {
    panel = null;
    password = '';
    closeWs();
    stopPolling();
    lastId = 0;
    mode = 'ws';
    wsFails = 0;
  });

  const webview = view.webview;
  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'login': {
        // The view may be opened from the activity bar before a server URL is configured
        if (!getServerUrl()) {
          const url = await setServerUrl();
          if (!url) {
            webview.postMessage({ type: 'loginFail', error: 'Server URL not configured' });
            break;
          }
        }
        password = msg.password;
        wsFails = 0;
        if (typeof WebSocket === 'function') {
          mode = 'ws';
          connectWs(webview, true);
        } else {
          onWsDown(webview, true); // no WebSocket in this runtime; go straight to polling
        }
        break;
      }

      case 'saveName':
        extContext.globalState.update('cloudchat.name', msg.name);
        break;

      case 'send': {
        try {
          let imageUrl = null;
          if (msg.imageBase64) {
            webview.postMessage({ type: 'status', text: 'Uploading image…' });
            imageUrl = await uploadImage(
              Buffer.from(msg.imageBase64, 'base64'),
              msg.imageName
            );
          }
          // Sends always go over HTTP; the server persists and broadcasts back via WebSocket
          await api('/messages', {
            method: 'POST',
            body: JSON.stringify({
              name: msg.name,
              text: msg.text,
              image_url: imageUrl,
            }),
          });
          webview.postMessage({ type: 'sent' });
          if (mode === 'poll') fetchNew(webview);
        } catch (e) {
          webview.postMessage({ type: 'error', text: 'Send failed: ' + e.message });
        }
        break;
      }

      case 'pickImage': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        });
        if (!uris || !uris.length) {
          webview.postMessage({ type: 'sent' });
          break;
        }
        try {
          webview.postMessage({ type: 'status', text: 'Uploading image…' });
          const data = await vscode.workspace.fs.readFile(uris[0]);
          const url = await uploadImage(
            Buffer.from(data),
            uris[0].path.split('/').pop()
          );
          await api('/messages', {
            method: 'POST',
            body: JSON.stringify({ name: msg.name, text: '', image_url: url }),
          });
          webview.postMessage({ type: 'sent' });
          if (mode === 'poll') fetchNew(webview);
        } catch (e) {
          webview.postMessage({ type: 'error', text: 'Send failed: ' + e.message });
        }
        break;
      }
    }
  });
}

function getHtml() {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 13px;
  }
  input, textarea, button {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    outline: none;
  }
  button {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    cursor: pointer;
    padding: 5px 14px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }

  /* Login page */
  #login {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
  #login h2 { font-weight: 500; }
  #login input { padding: 7px 10px; width: 220px; text-align: center; }
  #loginError { color: var(--vscode-errorForeground); min-height: 18px; }

  /* Chat page */
  #chat { height: 100%; display: none; flex-direction: column; }
  #topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  #topbar label { opacity: 0.7; }
  #nameInput { padding: 4px 8px; width: 140px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; margin-left: auto; }
  #dot.off { background: #f44336; }

  #list { flex: 1; overflow-y: auto; padding: 10px; }
  .msg { margin-bottom: 12px; }
  .meta { margin-bottom: 3px; }
  .meta .name { font-weight: 600; }
  .meta .time { opacity: 0.45; font-size: 11px; margin-left: 6px; }
  .text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .msg img {
    max-width: min(320px, 90%);
    max-height: 260px;
    border-radius: 6px;
    margin-top: 4px;
    display: block;
    cursor: pointer;
  }

  #statusBar {
    min-height: 18px;
    padding: 0 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  #statusBar.error { color: var(--vscode-errorForeground); }

  #inputBar {
    display: flex;
    gap: 6px;
    padding: 8px 10px 10px;
    border-top: 1px solid var(--vscode-panel-border, #444);
  }
  #textInput { flex: 1; resize: none; padding: 6px 8px; height: 54px; }
</style>
</head>
<body>

<div id="login">
  <h2>☁️ Cloud Chat</h2>
  <input id="pwdInput" type="password" placeholder="Enter password" autofocus>
  <button id="loginBtn">Join</button>
  <div id="loginError"></div>
</div>

<div id="chat">
  <div id="topbar">
    <label>Name</label>
    <input id="nameInput" placeholder="Anonymous" maxlength="20">
    <div id="dot" title="Connection status"></div>
  </div>
  <div id="list"></div>
  <div id="statusBar"></div>
  <div id="inputBar">
    <textarea id="textInput" placeholder="Type a message. Enter to send; paste images directly"></textarea>
    <button id="imgBtn" title="Send an image">Image</button>
    <button id="sendBtn">Send</button>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // ---------- Login ----------
  function doLogin() {
    const pwd = $('pwdInput').value;
    if (!pwd) return;
    $('loginBtn').disabled = true;
    $('loginError').textContent = '';
    vscode.postMessage({ type: 'login', password: pwd });
  }
  $('loginBtn').addEventListener('click', doLogin);
  $('pwdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  // ---------- Chat ----------
  function myName() { return $('nameInput').value.trim() || 'Anonymous'; }
  $('nameInput').addEventListener('change', () => {
    vscode.postMessage({ type: 'saveName', name: $('nameInput').value.trim() });
  });

  function nameColor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
    return 'hsl(' + h + ', 55%, 60%)';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function addMessages(msgs) {
    const list = $('list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    for (const m of msgs) {
      const div = document.createElement('div');
      div.className = 'msg';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = m.name;
      nameEl.style.color = nameColor(m.name);
      const timeEl = document.createElement('span');
      timeEl.className = 'time';
      timeEl.textContent = fmtTime(m.created_at);
      meta.append(nameEl, timeEl);
      div.appendChild(meta);

      if (m.text) {
        const t = document.createElement('div');
        t.className = 'text';
        t.textContent = m.text;
        div.appendChild(t);
      }
      if (m.image_url) {
        const a = document.createElement('a');
        a.href = m.image_url;
        const img = document.createElement('img');
        img.src = m.image_url;
        img.addEventListener('load', () => { if (nearBottom) list.scrollTop = list.scrollHeight; });
        a.appendChild(img);
        div.appendChild(a);
      }
      list.appendChild(div);
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function setBusy(busy) {
    $('sendBtn').disabled = busy;
    $('imgBtn').disabled = busy;
  }

  function setStatus(text, isError) {
    const bar = $('statusBar');
    bar.textContent = text || '';
    bar.className = isError ? 'error' : '';
    if (isError) setTimeout(() => { if (bar.textContent === text) setStatus(''); }, 5000);
  }

  function sendText() {
    const text = $('textInput').value.trim();
    if (!text) return;
    setBusy(true);
    setStatus('');
    vscode.postMessage({ type: 'send', name: myName(), text });
    $('textInput').value = '';
  }

  $('sendBtn').addEventListener('click', sendText);
  $('textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  $('imgBtn').addEventListener('click', () => {
    setBusy(true);
    vscode.postMessage({ type: 'pickImage', name: myName() });
  });

  // Paste an image to send it directly
  $('textInput').addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          setBusy(true);
          vscode.postMessage({
            type: 'send',
            name: myName(),
            text: $('textInput').value.trim(),
            imageBase64: base64,
            imageName: 'paste-' + Date.now() + '.png',
          });
          $('textInput').value = '';
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  });

  // ---------- Messages from the extension host ----------
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'loginOk': {
        const firstTime = $('chat').style.display !== 'flex';
        $('login').style.display = 'none';
        $('chat').style.display = 'flex';
        if (msg.name && !$('nameInput').value) $('nameInput').value = msg.name;
        if (firstTime) $('textInput').focus(); // loginOk also fires on reconnect; don't steal focus
        break;
      }
      case 'loginFail':
        $('loginBtn').disabled = false;
        $('loginError').textContent = msg.error;
        break;
      case 'messages':
        addMessages(msg.messages);
        break;
      case 'sent':
        setBusy(false);
        setStatus('');
        $('textInput').focus();
        break;
      case 'status':
        setStatus(msg.text);
        break;
      case 'error':
        setBusy(false);
        setStatus(msg.text, true);
        break;
      case 'online':
        $('dot').classList.remove('off');
        break;
      case 'offline':
        $('dot').classList.add('off');
        break;
    }
  });
</script>
</body>
</html>`;
}

function deactivate() {
  stopPolling();
}

module.exports = { activate, deactivate };
