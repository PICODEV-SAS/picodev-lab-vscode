// A local stand-in for the hub's MCP (/mcp, JSON-RPC tools/call), enough for test/suite.js: one setup (setup-a, as
// served), sessions held in memory, no browser ever connected; the answers have the shapes of the lab's public MCP
// (contract 0.20: session and token from the arguments or the X-Lab-* headers, error codes in _meta, queue and share).
const http = require('http');
const { randomBytes } = require('crypto');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // 1x1
const SHEET = {
  schema: 1, id: 'setup-a', title: 'Setup A · bras servo', summary: 'Un servo, un bouton, une LED.',
  i18n: { en: { title: 'Setup A · servo arm', summary: 'A servo, a button, an LED.' } },
  board: { kind: 'arduino-nano', fqbn: 'arduino:avr:nano' },
  files: [{ name: 'sketch.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
  libraries: ['Servo@1.2.2'],
  circuit: {
    components: [
      { type: 'wokwi-servo', id: 'servo-arm', properties: {} },
      { type: 'wokwi-pushbutton', id: 'btn-target', properties: {} },
      { type: 'wokwi-resistor', id: 'r-led', properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-state', properties: { color: 'red' } },
    ],
    wires: [],
  },
  probes: [{ pin: 9, label: 'D9', kind: 'scope' }, { pin: 2, label: 'D2', kind: 'logic' }, { pin: 6, label: 'D6', kind: 'logic' }],
  levels: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }],
};
const SETUP = {
  id: 'setup-a', title: SHEET.title, summary: SHEET.summary, modes: ['free', 'challenge'], i18n: SHEET.i18n, status: 'available',
  benches: [{ kind: 'nano', benches: 1, free: 0, waiting: 0, status: 'open' }],
};

const sessions = new Map();
const token = () => randomBytes(12).toString('hex');
const viewer = (s) => (s.visibility === 'private' ? null : `https://lab.picodev.fr/w/${s.id}#v=${s.viewer}`);

class ToolError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** `h`: the request's headers. A session tool takes session, then agent_token, from its arguments, else the headers. */
function tool(name, a, h = {}) {
  if (name === 'list_setups') return [SETUP];
  if (name === 'read_setup') {
    if (a.id !== 'setup-a') throw new ToolError(`Unknown setup: ${a.id}`);
    return { value: SHEET, images: [{ type: 'image', mimeType: 'image/png', data: PNG }] };
  }
  if (name === 'open_session') {
    if (a.setup !== 'setup-a') throw new ToolError(`Unknown setup: ${a.setup}`);
    const s = { id: token(), agent: token(), viewer: token(), setup: a.setup, mode: a.mode, visibility: 'link', created: Date.now() / 1000, run: 0 };
    sessions.set(s.id, s);
    return { session: s.id, agent_token: s.agent, open_url: `https://lab.picodev.fr/bench/${s.setup}/challenge?s=${s.id}#o=${token()}` };
  }
  const id = a.session ?? h['x-lab-session'];
  const s = sessions.get(id);
  if (!s) throw new ToolError('Unknown or ended session: open another one with open_session.', 'gone');
  if ((a.agent_token ?? (id === h['x-lab-session'] ? h['x-lab-agent-token'] : undefined)) !== s.agent) throw new ToolError('Wrong agent_token.');
  switch (name) {
    case 'session_status':
      return {
        setup: s.setup, mode: s.mode, owner: false, visibility: s.visibility, viewer_url: viewer(s), viewers: 0,
        created_at: s.created, expires_at: s.created + 3600, run: s.run, level: null, levels: SHEET.levels.length, capture: null,
        queue: s.queue ?? { state: 'none' },
        share: `/p/${s.setup}.${s.mode}.${s.mode === 'free' ? 0 : 1}.42.AAAAAAAAAAAAAAAA`, // a signed share's shape
      };
    // ponytail: no browser is ever connected here, but queue_join takes a place anyway so the suite sees one
    case 'queue_join':
      if (!SETUP.benches.some((b) => b.kind === a.kind)) throw new ToolError(`Unknown bench: ${a.kind}`);
      s.queue = { state: 'waiting', kind: a.kind, position: 1, waiting: 1, eta_s: 300 };
      return { kind: a.kind, position: 1, waiting: 1, eta_s: 300 };
    case 'queue_status':
      return s.queue ?? { state: 'none' };
    case 'queue_leave':
      s.queue = undefined;
      return { state: 'none' };
    case 'read_simulation':
      return { state: null, compile: null, events: [], challenge: { level: null, brief: null, results: [] }, circuit_modified: null, circuit_error: null };
    case 'set_visibility':
      s.visibility = a.visibility;
      s.viewer = token(); // a new link cuts off the viewers
      return { visibility: s.visibility, viewer_url: viewer(s) };
    case 'close_session':
      sessions.delete(s.id);
      return { state: 'ended' };
    case 'push_program':
    case 'push_to_editor':
      throw new ToolError('No browser is connected to this session: open open_url in a browser.', 'no_browser');
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

function answer(msg, headers) {
  if (msg.method !== 'tools/call') return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  try {
    const r = tool(msg.params?.name, msg.params?.arguments ?? {}, headers);
    const { value, images = [] } = r && r.value ? r : { value: r };
    return { result: { content: [{ type: 'text', text: JSON.stringify(value) }, ...images] } };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    return {
      result: {
        isError: true, content: [{ type: 'text', text: `Error executing tool ${msg.params?.name}: ${e.message}` }],
        ...(e.code && { _meta: { 'lab.picodev.fr/error': e.code } }),
      },
    };
  }
}

/** Starts the mock on a free port of 127.0.0.1; resolves to { url, close }. */
exports.start = () => new Promise((ok) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/mcp') return res.writeHead(404).end();
      const msg = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer(msg, req.headers) }));
    });
  });
  server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => server.close() }));
});
