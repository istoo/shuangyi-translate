import WebSocket from 'ws';

export async function targets() {
  const r = await fetch('http://127.0.0.1:9333/json/list');
  return r.json();
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalJs = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
    return { value: r.result?.result?.value };
  };
  return { ws, send, evalJs, events, close: () => ws.close() };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
