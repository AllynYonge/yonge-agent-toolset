/**
 * 依赖零安装的 CDP 客户端（Node 22+ 原生 WebSocket）。
 *
 * 设计取向：优先使用本技能的专用 profile（登录态持久保留、与日常浏览器隔离），
 * 也支持连接用户日常浏览器的既有调试端口。所有操作在自建 tab 中进行，
 * 结束后关闭自建 tab，不动用户已有 tab。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORTS = [9222, 9223, 9224];

/**
 * 专用 profile 目录（登录态持久保留在这里）。
 * 可用 DOUDIAN_PROFILE_DIR 覆盖。
 */
export const DEDICATED_PROFILE = process.env.DOUDIAN_PROFILE_DIR?.trim()
  ? path.resolve(process.env.DOUDIAN_PROFILE_DIR.trim())
  : path.join(os.homedir(), '.yonge', 'doudian', 'chrome-profile');

/** 进程生命周期记录文件，放在 profile 目录内，随 profile 一起迁移 */
export const PID_FILE = path.join(DEDICATED_PROFILE, 'chrome.pid');
export const OUT_LOG = path.join(DEDICATED_PROFILE, 'chrome-out.log');
export const ERR_LOG = path.join(DEDICATED_PROFILE, 'chrome-err.log');

/**
 * 缓存的 browser 级 WebSocket 终结点。
 *
 * 为何需要自己存：Chrome 136+ 引入了「Allow remote debugging?」确认框，
 * 而触发它的是对 DevTools **HTTP** 终结点（/json/version）的请求；
 * 拿着完整 ws:// 地址直连 WebSocket 不走那条检测。
 *
 * 按常规应该从 profile 目录的 DevToolsActivePort 读这个地址，但实测
 * Chrome 151（macOS）**并不写这个文件**（无论是否 --headless，等 20s 仍无），
 * 而日常 profile 里那个文件是旧版本留下的残留。
 * 所以改成：首次不得不走 HTTP 拿到 wsUrl 后，自己写进 profile 目录缓存，
 * 之后的每次连接都直读缓存、跳过 HTTP。
 */
export const WS_CACHE = path.join(DEDICATED_PROFILE, 'devtools-ws.json');

/**
 * 任意浏览器（含用户日常浏览器）的 wsUrl 缓存目录。
 *
 * 为何要与专用 profile 分开：专用 profile 的缓存靠 chrome.pid 做归属校验，
 * 而日常浏览器不是本脚本启动的、没有 chrome.pid，那套校验对它永远不成立。
 * 早期版本因此完全不为日常浏览器写缓存 —— 结果 --port 9222 每次都要重新走
 * HTTP 协商，也就每次都弹「Allow remote debugging?」。
 *
 * 这里按端口分文件存放，并用 Browser.getVersion 拿到的浏览器身份做校验，
 * 不依赖 pid。
 */
const WS_CACHE_DIR = path.join(os.homedir(), '.yonge', 'doudian', 'ws-cache');

function portCacheFile(port) {
  return path.join(WS_CACHE_DIR, `port-${port}.json`);
}

/**
 * 读缓存的 wsUrl。三重校验全过才算有效：
 *  1) 文件里有 port + wsUrl + pid；
 *  2) pid 还活着；
 *  3) 和该 profile 当前的 chrome.pid 对得上。
 *
 * 第 2/3 条是必需的：实测过一个真实事故——专用实例被杀后，自动探测回落到
 * 9222 连上了**日常浏览器**，如果那时把日常浏览器的终结点写进专用 profile
 * 的缓存，下一次就会静默地去驾驭用户的日常浏览器。隔离必须硬保证。
 */
function readWsCache(profile = DEDICATED_PROFILE) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(profile, 'devtools-ws.json'), 'utf-8'));
    if (!j?.wsUrl || !j?.port || !j?.pid) return null;
    try { process.kill(j.pid, 0); } catch { return null; }   // pid 已死
    const rec = readDedicatedPid(profile);
    if (!rec || rec.pid !== j.pid) return null;               // 不是当前那个实例
    return j;
  } catch {
    /* 没缓存或已损坏 */
  }
  return null;
}

function writeWsCache(profile, port, wsUrl, pid) {
  if (!pid) return;
  try {
    fs.writeFileSync(path.join(profile, 'devtools-ws.json'),
      JSON.stringify({ port, wsUrl, pid, 写入时间: new Date().toISOString() }, null, 2), 'utf-8');
  } catch {
    /* 写不下不影响主流程 */
  }
}

/** 按端口读 wsUrl 缓存（适用于任意浏览器，含日常浏览器） */
function readPortCache(port) {
  try {
    const j = JSON.parse(fs.readFileSync(portCacheFile(port), 'utf-8'));
    if (j?.wsUrl && j?.port === Number(port)) return j;
  } catch {
    /* 没缓存或已损坏 */
  }
  return null;
}

function writePortCache(port, wsUrl) {
  try {
    fs.mkdirSync(WS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(portCacheFile(port),
      JSON.stringify({ port: Number(port), wsUrl, 写入时间: new Date().toISOString() }, null, 2), 'utf-8');
  } catch {
    /* 写不下不影响主流程 */
  }
}

function clearPortCache(port) {
  try { fs.unlinkSync(portCacheFile(port)); } catch { /* ignore */ }
}

/** 丢掉失效的 wsUrl 缓存（浏览器重启后 uuid 会变） */
function clearWsCache(profile = DEDICATED_PROFILE) {
  try { fs.unlinkSync(path.join(profile, 'devtools-ws.json')); } catch { /* ignore */ }
}

/**
 * 端口策略：默认动态分配空闲端口，避免固定端口被占时白等超时。
 * 想钉死端口就设 DOUDIAN_DEBUG_PORT。
 */
export function fixedPortFromEnv() {
  const n = Number.parseInt(process.env.DOUDIAN_DEBUG_PORT ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 要一个当前空闲的 TCP 端口；设了 DOUDIAN_DEBUG_PORT 就用它 */
export async function getFreePort() {
  const fixed = fixedPortFromEnv();
  if (fixed) return fixed;
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('无法分配空闲端口')));
        return;
      }
      const { port } = addr;
      srv.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

const CHROME_CANDIDATES = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  : [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ];

export function findChrome() {
  if (process.env.DOUDIAN_CHROME_PATH?.trim()) return process.env.DOUDIAN_CHROME_PATH.trim();
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** 探测端口上的 browser 级 WebSocket 是否可连，成功时直接交出这个连接 */
async function probeWs(wsUrl, timeoutMs = 5000) {
  return await new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => {
      try { ws?.close(); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      clearTimeout(timer);
      return resolve(null);
    }
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(null); }, { once: true });
  });
}

/** 解析单个 DevToolsActivePort 文件：第一行端口，第二行 /devtools/browser/<uuid> */
function parseActivePortFile(file) {
  try {
    const [portLine, pathLine] = fs.readFileSync(file, 'utf-8').split('\n');
    const port = Number(portLine.trim());
    if (port > 0) return { port, wsPath: (pathLine || '').trim() || null };
  } catch {
    /* 文件不存在或不可读 */
  }
  return null;
}

/**
 * 从各个 profile 目录里的 DevToolsActivePort 读出真实的 browser WS 路径。
 *
 * 专用 profile 放在最前面：端口现在是动态分配的，这个文件是找到它的主路径。
 * 早期版本漏了这一项，导致只能靠固定端口探测，端口一被占就干等超时。
 */
function readActivePorts() {
  const home = process.env.HOME || os.homedir();
  const rels = process.platform === 'darwin'
    ? [
        'Library/Application Support/Google/Chrome',
        'Library/Application Support/Google/Chrome Beta',
        'Library/Application Support/Microsoft Edge',
        'Library/Application Support/Chromium',
      ]
    : [
        '.config/google-chrome',
        '.config/microsoft-edge',
        '.config/chromium',
      ];
  const files = [
    path.join(DEDICATED_PROFILE, 'DevToolsActivePort'),
    ...rels.map((rel) => path.join(home, rel, 'DevToolsActivePort')),
  ];
  const out = [];
  for (const f of files) {
    const hit = parseActivePortFile(f);
    if (hit) out.push(hit);
  }
  return out;
}

/** 端口是否有人在监听（不依赖 HTTP /json/*，本机那些端点可能返 404） */
function isPortListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); done(true); });
    sock.once('error', () => { clearTimeout(timer); done(false); });
    sock.connect(port, '127.0.0.1');
  });
}

/**
 * 找出指定 profile 已在运行的调试端口。两道保险（对齐 baoyu-chrome-cdp 的做法）：
 *  1) 读 profile 里的 DevToolsActivePort；
 *  2) 文件过期或缺失时，用 ps 扫带该 profile 路径的 Chrome 进程。 * 这比“只探一个固定端口”鲁棒，也是动态端口能成立的前提。
 */
export async function findExistingDebugPort(profile = DEDICATED_PROFILE) {
  const parsed = parseActivePortFile(path.join(profile, 'DevToolsActivePort'));
  if (parsed && await isPortListening(parsed.port)) return parsed.port;

  if (process.platform === 'win32') return null;
  try {
    const r = spawnSync('ps', ['ax', '-o', 'command='], { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return null;
    for (const line of r.stdout.split('\n')) {
      if (!line.includes(profile) || !line.includes('--remote-debugging-port=')) continue;
      const port = Number.parseInt(/--remote-debugging-port=(\d+)/.exec(line)?.[1] ?? '', 10);
      if (port > 0 && await isPortListening(port)) return port;
    }
  } catch {
    /* ps 不可用就算了 */
  }
  return null;
}

/**
 * 连上浏览器，返回 { port, cdp }。
 *
 * 四个必须尊重的事实（都是踩过的坑）：
 *  1. Chrome 136+ 对 DevTools **HTTP** 终结点的请求会弹「Allow remote debugging?」
 *     确认框（实测日常 profile 上首次连接被阻塞 >8s，点了 Allow 后才通）。
 *     拿着完整 ws:// 地址直连 WebSocket 不走这条检测，所以优先用缓存的 wsUrl。
 *  2. 部分 Chrome 对 /json/version 返回 404（安全策略/扩展干扰），
 *     所以不能只靠 HTTP 判断端口可用性。
 *  3. browser 级终结点的真实路径带 uuid（/devtools/browser/<uuid>），
 *     重启浏览器后会变。裸 /devtools/browser 只在没人占用时偶尔能连，不可依赖。
 *  4. 该终结点只允许一个客户端。探测成功的连接必须直接复用，
 *     且整个批量任务期间只建一次。web-access 的 cdp-proxy 占着时
 *     本脚本连不上，需先 pkill -f cdp-proxy.mjs。
 *
 * @param explicit 指定端口；不给则自动探测
 * @param profile  用于读/写 wsUrl 缓存的 profile 目录
 * @param cacheFor 仅当确知连的就是该 profile 的实例时传 pid，才会写缓存。
 *                 自动探测路径不传，因为它可能回落到用户日常浏览器。
 */
export async function connectBrowser(explicit, { profile = DEDICATED_PROFILE, cacheFor = null } = {}) {
  // 第 0 优先：缓存的 wsUrl 直连，完全不碰 HTTP 终结点 → 不触发确认框。
  const cached = readWsCache(profile);
  if (cached && (!explicit || cached.port === Number(explicit))) {
    if (await isPortListening(cached.port)) {
      const ws = await probeWs(cached.wsUrl);
      if (ws) return { port: cached.port, cdp: new Cdp(ws) };
    }
    // 端口没人监听或 uuid 已变（浏览器重启过），丢掉重建
    clearWsCache(profile);
  }

  // 第 0.5 优先：按端口的 wsUrl 缓存。这条覆盖**日常浏览器**场景——
  // 它不是本脚本启动的、没有 chrome.pid，走不了上面那套归属校验，
  // 但同样需要免掉每次的 HTTP 协商（否则每次都弹「Allow remote debugging?」）。
  for (const p of (explicit ? [Number(explicit)] : DEFAULT_PORTS)) {
    const pc = readPortCache(p);
    if (!pc) continue;
    if (!await isPortListening(p)) { clearPortCache(p); continue; }
    const ws = await probeWs(pc.wsUrl);
    if (ws) return { port: p, cdp: new Cdp(ws) };
    clearPortCache(p);   // uuid 变了（浏览器重启过）
  }

  const candidates = [];
  const active = readActivePorts();

  // 自动探测时，专用 profile / 已知 active 端口优先于默认端口段，
  // 因为专用实例的端口现在是动态分配的，不在 9222/9223/9224 里。
  const ports = explicit
    ? [Number(explicit)]
    : [...new Set([...active.map((a) => a.port), ...DEFAULT_PORTS])];

  // 先试 DevToolsActivePort 里的 uuid 路径（也是 WS 直连，不弹框）。
  // 注意：实测 Chrome 151/macOS 不写这个文件，这条路径大多数时候空跑，
  // 但旧版本/其他平台仍会写，留着作为免弹框的第二条路。
  for (const { port, wsPath } of active) {
    if (explicit && port !== Number(explicit)) continue;
    if (wsPath) candidates.push({ port, wsUrl: `ws://127.0.0.1:${port}${wsPath}`, viaHttp: false });
  }

  // 再试 HTTP：拿到的 wsUrl 带唯一 id，最可靠，但可能弹确认框。
  for (const p of ports) {
    try {
      const v = await httpJson(`http://127.0.0.1:${p}/json/version`);
      if (v?.webSocketDebuggerUrl) {
        candidates.push({ port: p, wsUrl: v.webSocketDebuggerUrl, viaHttp: true });
      }
    } catch {
      /* 落到下面的方式 */
    }
  }

  // 最后试裸路径
  for (const p of ports) {
    candidates.push({ port: p, wsUrl: `ws://127.0.0.1:${p}/devtools/browser`, viaHttp: false });
  }

  const seen = new Set();
  for (const { port, wsUrl, viaHttp } of candidates) {
    if (seen.has(wsUrl)) continue;
    seen.add(wsUrl);
    const ws = await probeWs(wsUrl);
    if (ws) {
      // 拿到带 uuid 的完整地址且调用方确认了归属，才缓存。
      // 这是“首次可能弹一次，之后不再弹”的关键，
      // 也是不把日常浏览器误写进专用缓存的关键。
      if (cacheFor && wsUrl.includes('/devtools/browser/') && fs.existsSync(profile)) {
        writeWsCache(profile, port, wsUrl, cacheFor);
      }
      // 按端口缓存不做归属判断：它只回答"这个端口上的 wsUrl 是什么"，
      // 不代表任何 profile 的归属，因此对日常浏览器也安全适用。
      if (wsUrl.includes('/devtools/browser/')) writePortCache(port, wsUrl);
      return { port, cdp: new Cdp(ws), viaHttp };
    }
  }
  return null;
}

/**
 * 启动专用 profile 的浏览器实例（幂等：已在跑就直接复用）。
 *
 * 为何需要这个：部分用户日常 Chrome 的 DevTools HTTP 终结点会被扩展或安全
 * 策略弄坏（/json/version 返回非标准的 404），导致无法稳定拿到 browser 级
 * WS 地址。专用 profile 能绕开这类污染，且登录态持久保留，只需首次手动登录。
 *
 * 端口策略：先找该 profile 已在运行的端口（DevToolsActivePort + ps 兜底）；
 * 新启时用动态空闲端口，避开固定端口被占就干等 40s 超时的老问题。
 */
export async function launchDedicated({ profile = DEDICATED_PROFILE, port, url = 'about:blank' } = {}) {
  // 1) 显式指定端口（或 env 钉死）时先试那个端口
  const want = port ?? fixedPortFromEnv();
  if (want) {
    const rec = readDedicatedPid(profile);
    const hit = await connectBrowser(want, { profile, cacheFor: rec?.alive ? rec.pid : null });
    if (hit) return { port: want, cdp: hit.cdp, launched: false, profile };
  }

  // 2) 再看该 profile 是不是已经在跑（端口可能是上次动态分配的）
  const running = await findExistingDebugPort(profile);
  if (running) {
    const rec = readDedicatedPid(profile);
    const hit = await connectBrowser(running, { profile, cacheFor: rec?.alive ? rec.pid : null });
    if (hit) return { port: running, cdp: hit.cdp, launched: false, profile };
  }

  const chrome = findChrome();
  if (!chrome) {
    throw new Error('未找到 Chrome/Edge。可用环境变量 DOUDIAN_CHROME_PATH 指定路径。');
  }
  fs.mkdirSync(profile, { recursive: true });

  const usePort = want ?? await getFreePort();
  const pidFile = path.join(profile, 'chrome.pid');
  const outLog = fs.openSync(path.join(profile, 'chrome-out.log'), 'a');
  const errLog = fs.openSync(path.join(profile, 'chrome-err.log'), 'a');

  const child = spawn(chrome, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${usePort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    url,
  ], { detached: true, stdio: ['ignore', outLog, errLog] });
  child.unref();

  // 记下 pid 与端口，方便事后定位/清理这个实例（不误伤日常浏览器）
  try {
    fs.writeFileSync(pidFile, `${child.pid}\n${usePort}\n`, 'utf-8');
  } catch {
    /* 写不下不影响主流程 */
  }

  // 新启的实例肯定没缓存（或缓存已失效），先清掉，避免拿着上一个实例的
  // uuid 去白试一轮。connectBrowser 会在首次拿到 wsUrl 后重建缓存。
  clearWsCache(profile);

  const start = Date.now();
  while (Date.now() - start < 40000) {
    await sleep(1000);
    // cacheFor 传刚 spawn 出来的 pid：这里肯定是该 profile 自己的实例，
    // 可以安全地把 wsUrl 写进缓存，后续连接就能跳过 HTTP、不再弹确认框。
    const conn = await connectBrowser(usePort, { profile, cacheFor: child.pid });
    if (conn) return { port: usePort, cdp: conn.cdp, launched: true, profile };
  }
  throw new Error(
    `专用浏览器启动后 40s 内未能连上调试端口 ${usePort}。`
    + `看一下 ${path.join(profile, 'chrome-err.log')} 里的错误。`,
  );
}

/** 读专用实例的 pid/端口记录（环境检查与排障用） */
export function readDedicatedPid(profile = DEDICATED_PROFILE) {
  try {
    const [pidLine, portLine] = fs.readFileSync(path.join(profile, 'chrome.pid'), 'utf-8').split('\n');
    const pid = Number.parseInt(pidLine?.trim() ?? '', 10);
    const port = Number.parseInt(portLine?.trim() ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    return { pid, port: Number.isInteger(port) && port > 0 ? port : null, alive };
  } catch {
    return null;
  }
}

/** 判断专用 profile 里是否已登录抖店 */
export async function isLoggedIn(conn) {
  const page = await openPage('https://fxg.jinritemai.com/ffa/g/create', { conn });
  try {
    await sleep(6000);
    const u = await page.url();
    const t = await page.text();
    return {
      loggedIn: !/login|passport|登录/i.test(u) && /主图上传|商品标题/.test(t),
      url: u,
    };
  } finally {
    await page.close();
  }
}

/** 仅判断端口可用性（环境检查用）。会占用并立即释放连接。 */
export async function findDebugPort(explicit) {
  const conn = await connectBrowser(explicit);
  if (!conn) return null;
  conn.cdp.close();
  await sleep(300);
  return conn.port;
}

export function browserOpenHint() {
  const mac = process.platform === 'darwin';
  const launchLine = mac
    ? "  open -na 'Google Chrome' --args --remote-debugging-port=9222"
    : '  google-chrome --remote-debugging-port=9222';
  return [
    '未能连上浏览器调试端口。两个选项：',
    '',
    'A. 推荐 —— 用专用 profile（首次需手动登录一次抖店，之后一直有效）：',
    '     给命令加上 --launch',
    `     profile 目录: ${DEDICATED_PROFILE}`,
    '',
    'B. 用你日常浏览器：先完全退出浏览器，然后带调试端口启动：',
    launchLine,
    '     注意：Chrome 已在运行时，open 会把参数丢给现有实例，调试端口不会生效。',
    '',
    '已知问题：若日常 Chrome 装了会占用/拦截 DevTools 终结点的扩展（如部分下载类扩展），',
    '/json/version 会返回异常 404，此时只能用方案 A。',
    '另：web-access 的 cdp-proxy 占着端点时也会冲突，先 pkill -f cdp-proxy.mjs。',
    '',
    '环境变量：DOUDIAN_PROFILE_DIR 改 profile 目录，DOUDIAN_DEBUG_PORT 钉死调试端口，',
    '          DOUDIAN_CHROME_PATH 指定浏览器可执行文件。',
  ].join('\n');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) {
        try { fn(msg); } catch { /* ignore */ }
      }
    });
  }

  /** 订阅 CDP 事件（无 id 的消息） */
  onEvent(fn) {
    this.listeners.add(fn);
    return fn;
  }

  offEvent(fn) {
    this.listeners.delete(fn);
  }

  static async connect(wsUrl, timeoutMs = 15000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      ws.addEventListener('error', (e) => {
        clearTimeout(t);
        reject(new Error(`WebSocket 连接失败: ${e?.message ?? e}`));
      }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 打开一个新的后台 tab 并 attach。
 * 传入 conn 可复用已有 browser 连接（避开 /devtools/browser 单客户端限制）。
 * @returns {Promise<Page>}
 */
export async function openPage(url, { port, conn, background = false } = {}) {
  const c = conn ?? await connectBrowser(port);
  if (!c) throw new Error(browserOpenHint());
  const { cdp } = c;

  const { targetId } = await cdp.send('Target.createTarget', { url, background });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);

  const page = new Page(cdp, sessionId, targetId, c.port, true, /* ownsCdp */ !conn);
  // 部分环境下 createTarget 带的 url 不会真的加载（停在 about:blank），
  // 因此 attach 后再显式 navigate 一次。
  await page.waitReady().catch(() => {});
  if (!(await page.url()).includes(new URL(url).host)) {
    await page.navigate(url);
  }
  // 后台 tab 的渲染会被 Chromium 延迟，SPA 可能长时间不挂载。拉到前台再等渲染。
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
  return page;
}

/** attach 到已存在的 tab（URL 子串匹配），用于人工接手后续继续操作 */
export async function attachPage(urlPart, { port, conn } = {}) {
  const c = conn ?? await connectBrowser(port);
  if (!c) throw new Error(browserOpenHint());
  const { cdp } = c;
  const { targetInfos } = await cdp.send('Target.getTargets');
  const hit = targetInfos.find((t) => t.type === 'page' && t.url.includes(urlPart));
  if (!hit) throw new Error(`未找到包含 "${urlPart}" 的标签页`);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: hit.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('DOM.enable', {}, sessionId);
  return new Page(cdp, sessionId, hit.targetId, c.port, /* owned */ false, /* ownsCdp */ !conn);
}

export class Page {
  constructor(cdp, sessionId, targetId, port, owned = true, ownsCdp = true) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.port = port;
    this.owned = owned;
    this.ownsCdp = ownsCdp;
  }

  /** 执行页面内 JS，返回值需可 JSON 序列化 */
  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    }, this.sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内 JS 异常: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  /** 表达式求值（不包裹 IIFE），适合单表达式 */
  async evalExpr(expression) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, this.sessionId);
    if (r.exceptionDetails) {
      throw new Error(`页面内 JS 异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  async navigate(url) {
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await this.waitReady();
  }

  async waitReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.evalExpr('document.readyState').catch(() => null);
      if (state === 'complete' || state === 'interactive') return;
      await sleep(300);
    }
    throw new Error('页面加载超时');
  }

  /**
   * 等 SPA 真正渲染完。
   *
   * document.readyState 到 interactive/complete 只代表 HTML 到位，抖店是 React SPA，
   * 此时 body.innerText 可能只有几十个字符（浏览器扩展的残留文本），表单还不存在。
   * 直接找元素会报「等待超时」——这是踩过的坑。
   */
  async waitRendered({ timeoutMs = 60000, minTextLen = 200 } = {}) {
    await this.waitReady(timeoutMs).catch(() => {});
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const len = await this.evalExpr('document.body ? document.body.innerText.length : 0').catch(() => 0);
      if (len >= minTextLen) return len;
      await sleep(500);
    }
    throw new Error(`SPA 渲染超时（页面文本长度始终 < ${minTextLen}）`);
  }

  /** 轮询等待条件成立。cond 是一段返回 boolean 的 JS 语句体 */
  async waitFor(cond, { timeoutMs = 20000, interval = 400, label = '条件' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.eval(cond).catch(() => false);
      if (ok) return true;
      await sleep(interval);
    }
    throw new Error(`等待超时: ${label}`);
  }

  /**
   * 真实鼠标点击。抖店的 ecom-g-select 下拉必须靠真实手势才会展开，
   * 纯 el.click() 无效——这是踩过的坑。
   */
  async clickReal(selector) {
    const pos = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, inView: r.y > 0 && r.y < innerHeight };
    `);
    if (!pos) throw new Error(`元素不可见或不存在: ${selector}`);
    if (!pos.inView) {
      await sleep(300);
      const again = await this.eval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      `);
      Object.assign(pos, again);
    }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type, x: pos.x, y: pos.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
      }, this.sessionId);
      await sleep(40);
    }
  }

  /** JS 点击，适用于普通按钮/链接 */
  async click(selector) {
    const ok = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    `);
    if (!ok) throw new Error(`元素不存在: ${selector}`);
  }

  /** 受控组件赋值：必须走原生 setter + input/change 事件，React 才认 */
  async setInput(selector, value) {
    const ok = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      el.focus();
      set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    `);
    if (!ok) throw new Error(`输入框不存在: ${selector}`);
  }

  /** 给 file input 直接塞本地文件路径，绕过系统文件对话框 */
  async setFiles(selector, files) {
    const { root } = await this.cdp.send('DOM.getDocument', {}, this.sessionId);
    const { nodeId } = await this.cdp.send('DOM.querySelector', {
      nodeId: root.nodeId, selector,
    }, this.sessionId);
    if (!nodeId) throw new Error(`file input 不存在: ${selector}`);
    await this.cdp.send('DOM.setFileInputFiles', { nodeId, files }, this.sessionId);
  }

  async screenshot(filePath) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    const fs = await import('node:fs');
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  async text() {
    return await this.evalExpr('document.body.innerText');
  }

  async url() {
    return await this.evalExpr('location.href');
  }

  /** 关闭自建 tab；attach 来的 tab 不关 */
  /** 关闭自建 tab；attach 来的 tab 不关；复用的 browser 连接也不关 */
  /**
   * 关闭标签页。
   *
   * 抖店发布页注册了 beforeunload，直接 closeTarget 会弹出「离开站点？」原生确认框。
   * 那个框由浏览器 UI 线程持有，没人点就会把整个浏览器主线程卡死——连 DevTools 端口
   * 和 AppleScript 都不再响应，只能强杀浏览器。这是踩过的坑，别删下面的清理逻辑。
   *
   * 双保险：
   *  1) 关之前先摘掉所有 beforeunload 监听，让弹框根本不出现；
   *  2) 万一还是弹了，订阅 Page.javascriptDialogOpening 并自动 accept。
   */
  async close() {
    if (this.owned) {
      await this.disarmBeforeUnload().catch(() => {});
      const autoAccept = (msg) => {
        if (msg?.method === 'Page.javascriptDialogOpening') {
          this.cdp.send('Page.handleJavaScriptDialog', { accept: true }, this.sessionId).catch(() => {});
        }
      };
      this.cdp.onEvent(autoAccept);
      try {
        await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
      } catch {
        /* ignore */
      } finally {
        this.cdp.offEvent(autoAccept);
      }
    }
    if (this.ownsCdp) this.cdp.close();
  }

  /** 摘掉页面上的 beforeunload，避免关闭时弹原生确认框 */
  async disarmBeforeUnload() {
    await this.evalExpr(`(() => {
      try {
        window.onbeforeunload = null;
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (t, ...rest) {
          if (t === 'beforeunload') return undefined;
          return add.call(this, t, ...rest);
        };
        return true;
      } catch (e) { return false; }
    })()`);
  }
}

/** 列出当前所有 page 类型 tab（用于环境检查，不依赖 /json/list） */
export async function listTabs({ port } = {}) {
  const c = await connectBrowser(port);
  if (!c) return null;
  try {
    const { targetInfos } = await c.cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').map((t) => ({ url: t.url, title: t.title }));
  } finally {
    c.cdp.close();
  }
}

/** 判断 python3 + openpyxl 是否可用（Excel 解析依赖） */
export function checkPython() {
  try {
    execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, hint: 'pip3 install openpyxl' };
  }
}
