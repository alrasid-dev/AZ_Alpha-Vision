// @supabase/supabase-js يحتاج WebSocket أصلي. Node 20 على Render لا يوفّره.
function ensureWebSocket() {
  if (typeof globalThis.WebSocket !== 'undefined') return;
  try {
    const { WebSocket } = require('ws');
    globalThis.WebSocket = WebSocket;
  } catch {
    throw new Error(
      'Node.js detected but native WebSocket not found. اضبط NODE_VERSION=22 على Render (أو ثبّت حزمة ws).',
    );
  }
}

module.exports = { ensureWebSocket };
