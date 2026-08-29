#!/usr/bin/env node
/**
 * 环境预检：Node 版本、python3+openpyxl+Pillow、浏览器可执行文件、专用 profile、调试端口。
 *
 * 用法:
 *   node check-env.mjs [--port <n>] [--launch]
 *                      [--no-wait-login] [--login-timeout <秒>]
 *
 *   --launch          没有可用端口时，直接把专用 profile 的浏览器拉起来（幂等）；
 *                     起来后自动检验登录态：已登录直接过，未登录则打开登录页并等你登完
 *   --no-wait-login   只报告登录态，不等待（供 CI/无人值守使用）
 *   --login-timeout   等待登录的上限秒数，默认 300
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  findDebugPort, browserOpenHint, checkPython, listTabs, findChrome, connectBrowser,
  findExistingDebugPort, launchDedicated, readDedicatedPid,
  DEDICATED_PROFILE, fixedPortFromEnv, ensureLogin, DOUDIAN_HOME,
} from './cdp.mjs';

const argv = process.argv.slice(2);
const wantLaunch = argv.includes('--launch');
const explicitPort = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : undefined;
const waitLogin = !argv.includes('--no-wait-login');
const loginTimeoutMs = (() => {
  const i = argv.indexOf('--login-timeout');
  const n = i >= 0 ? Number.parseInt(argv[i + 1] ?? '', 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n * 1000 : 300000;
})();

const rows = [];
let fatal = false;

const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) rows.push(['Node.js', 'ok', process.version]);
else { rows.push(['Node.js', '缺失', `需要 22+（当前 ${process.version}），原生 WebSocket 依赖`]); fatal = true; }

const py = checkPython();
if (py.ok) rows.push(['python3 + openpyxl + Pillow', 'ok', '']);
else { rows.push(['python3 + openpyxl + Pillow', '缺失', py.hint]); fatal = true; }

const chrome = findChrome();
rows.push(['浏览器可执行文件', chrome ? 'ok' : '提示',
  chrome ?? '未找到，--launch 不可用（可用 DOUDIAN_CHROME_PATH 指定）']);

const profileExists = fs.existsSync(DEDICATED_PROFILE);
rows.push(['专用 profile', profileExists ? 'ok' : '提示',
  profileExists ? DEDICATED_PROFILE : `尚未创建，首次用 --launch 会自动建在 ${DEDICATED_PROFILE}`]);

// 专用实例的进程记录（pid + 端口），能区分「没启动」和「启动过但已退出」
const rec = readDedicatedPid();
if (rec) {
  rows.push(['专用实例进程', rec.alive ? 'ok' : '提示',
    rec.alive ? `pid ${rec.pid}，端口 ${rec.port ?? '未记录'}` : `pid ${rec.pid} 已退出（chrome.pid 是上次的残留）`]);
}

// 端口解析优先级（顺序很重要）：
//   --port 显式指定 > --launch 走专用 profile > 自动探测
// --launch 的语义就是“用隔离的专用 profile”，所以它不能回落到通用探测——
// 否则日常浏览器恰好开着 9222 时会静默接上去，隔离就形同虚设。
let port = null;
let launched = false;
// --launch 时把连接留到登录检验之后再关：browser 级终结点只允许一个客户端，
// 关掉再连会白等一轮探测。
let liveConn = null;

if (explicitPort) {
  port = await findDebugPort(explicitPort);
} else if (wantLaunch) {
  try {
    const r = await launchDedicated({ url: DOUDIAN_HOME });
    port = r.port;
    launched = r.launched;
    liveConn = { port: r.port, cdp: r.cdp };
  } catch (e) {
    rows.push(['启动专用浏览器', '缺失', e.message]);
    fatal = true;
  }
} else {
  const own = await findExistingDebugPort();
  port = own ? await findDebugPort(own) : await findDebugPort();
}

if (port) {
  const how = launched ? '（本次新启动专用实例）' : wantLaunch ? '（复用已在跑的专用实例）' : '';
  rows.push(['浏览器调试端口', 'ok', `${port}${how}`]);
} else if (!fatal) {
  rows.push(['浏览器调试端口', '缺失', '见下方提示（加 --launch 可自动解决）']);
}

const fixed = fixedPortFromEnv();
if (fixed) rows.push(['DOUDIAN_DEBUG_PORT', 'ok', `已钉死为 ${fixed}`]);

// 登录态检验。--launch 时是主路径：已登录直接放行，未登录就打开登录页轮询等待，
// 用户登完脚本自己发现、不需要重跑。日志在表格前面打，因为它是交互性的。
const loginLogs = [];
let loginState = null;

function loginNote(st) {
  if (st.loggedIn) {
    return `${st.依据}${st.waitedMs ? `（等待 ${Math.round(st.waitedMs / 1000)}s）` : ''}`;
  }
  if (st.timeout) return '等待登录超时，请登录后重跑';
  return `${st.依据 ?? '未登录'}${waitLogin ? '' : '（--no-wait-login，未等待）'}`;
}

if (liveConn) {
  loginState = await ensureLogin(liveConn, {
    wait: waitLogin,
    timeoutMs: loginTimeoutMs,
    log: (m) => { loginLogs.push(m); console.log(m); },
  }).catch((e) => ({ loggedIn: false, 依据: `检测失败: ${e.message}` }));
  if (!loginState.loggedIn) fatal = true;
  rows.push(['抖店登录态', loginState.loggedIn ? 'ok' : '缺失', loginNote(loginState)]);
} else if (port) {
  // --port / 自动探测路径：先列一下已有抖店 tab（信息性），再做同样的登录检验。
  try {
    const tabs = await listTabs({ port });
    const dd = (tabs ?? []).filter((t) => (t.url || '').includes('jinritemai.com'));
    rows.push(['抖店标签页', dd.length ? 'ok' : '提示',
      dd.length ? `已打开 ${dd.length} 个` : '未打开抖店，脚本会自建 tab']);
  } catch (e) {
    rows.push(['标签页列表', '提示', `无法枚举: ${e.message}`]);
  }
  const c = await connectBrowser(port);
  if (c) {
    liveConn = c;
    loginState = await ensureLogin(c, {
      wait: waitLogin,
      timeoutMs: loginTimeoutMs,
      log: (m) => { loginLogs.push(m); console.log(m); },
    }).catch((e) => ({ loggedIn: false, 依据: `检测失败: ${e.message}` }));
    if (!loginState.loggedIn) fatal = true;
    rows.push(['抖店登录态', loginState.loggedIn ? 'ok' : '缺失', loginNote(loginState)]);
  }
}
liveConn?.cdp.close();

if (loginLogs.length) console.log('');
const w = Math.max(...rows.map((r) => [...r[0]].length * 1.6));
for (const [name, state, note] of rows) {
  const mark = state === 'ok' ? '✓' : state === '提示' ? '·' : '✗';
  console.log(`${mark} ${name.padEnd(Math.ceil(w))} ${state}${note ? '  ' + note : ''}`);
}

if (!port) {
  console.log('');
  console.log(browserOpenHint());
}

if (launched) {
  console.log('');
  console.log(`已启动专用浏览器（profile: ${DEDICATED_PROFILE}）。`);
  console.log('登录态会持久保留在这个 profile 里，无需每次重新登录。');
  console.log(`日志: ${path.join(DEDICATED_PROFILE, 'chrome-err.log')}`);
}

console.log('');
if (loginState && !loginState.loggedIn) {
  console.log('登录未完成，后续命令会卡在登录页。请先在浏览器里完成登录，然后重跑本命令确认。');
  if (loginState.url) console.log(`当前页面: ${loginState.url}`);
  console.log('');
}
console.log('提示：抖店对自动化操作检测严格，存在账号风险。建议先用 --mode draft 存草稿人工复核，');
console.log('      确认无误后再用 --mode publish。');

process.exit(fatal ? 1 : 0);
