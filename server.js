#!/usr/bin/env node
/**
 * 极米投影仪遥控器 · server.js
 * ------------------------------------------------------------------
 * 依赖：mqtt（巴法云接入用，npm install 即可）
 *
 * 启动：            node server.js
 * 指定端口：        PORT=8080 node server.js
 * 指定默认 IP：     XGIMI_IP=192.168.1.50 node server.js
 * 指定 UDP 端口：   XGIMI_UDP_PORT=16735 node server.js
 * 巴法云私钥：      BEMFA_UID=xxxx node server.js
 * 巴法云主题：      BEMFA_TOPIC=jimi003 node server.js
 *
 * 协议：向 <投影仪IP>:16735 发送明文 UDP 报文，例如 "KEYPRESSES:115"
 * 开机：待机时投影仪会关掉 Wi-Fi，UDP 发不进去，只能用 BLE 唤醒。
 *       本机装 BlueZ 时由 ble-wake.js 广播（XGIMI_BLE=1 开启）。
 * ------------------------------------------------------------------
 */

'use strict';

const http = require('node:http');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const mqtt = require('mqtt');

const DIR = __dirname;
const HTML_FILE = path.join(DIR, 'index.html');
const CONFIG_FILE = path.join(DIR, '.xgimi-remote.json');

const PORT = toPort(process.env.PORT, 3000);
const HOST = process.env.HOST || '0.0.0.0';
const UDP_PORT = toPort(process.env.XGIMI_UDP_PORT, 16735);
const FALLBACK_IP = normalizeHost(process.env.XGIMI_IP) || '192.168.1.19';

/* 巴法云（米家「其他平台设备」的 MQTT 通道） */
const BEMFA_UID = (process.env.BEMFA_UID || '4da03b7ccd724b259ed6a6f8ae3a966a').trim();
const BEMFA_TOPIC = (process.env.BEMFA_TOPIC || 'jimi003').trim();

/* 风扇只有 on / off / on#1..on#4 这几种消息，执行完回写 off，方便再次触发 */
const BEMFA_RESET_MS = 2500;
const BEMFA_URL = process.env.BEMFA_URL || 'mqtt://bemfa.com:9501';

/* 本机 BLE 唤醒（Linux + BlueZ）。设 XGIMI_BLE=0 可关闭，XGIMI_BLE=1 可强制开启。 */
const BLE_SCRIPT = path.join(DIR, 'ble-wake.js');
const BLE_TOKEN = (process.env.XGIMI_BLE_TOKEN || '2753ce4b21129cffffff3043524b544d').trim();
const BLE_MS = toMs(process.env.XGIMI_BLE_MS, 800, 20000, 4000);
// 默认关闭：盒子的 AIC8800 蓝牙在注册第二路广播时会 hardware error，
// 且会顶掉厂商自带的 BLE 广播；需要时用 XGIMI_BLE=1 显式开启。
const BLE_ENABLED = process.env.XGIMI_BLE === '1' && fs.existsSync(BLE_SCRIPT);
// AIC8800 在 BlueZ 里跑完一轮 enable/disable 后会"假发"（注册成功但不上天），
// 每轮唤醒前重启一次 bluetoothd 可以恢复；设 XGIMI_BLE_RESET=0 可关掉。
const BLE_RESET = process.env.XGIMI_BLE_RESET !== '0';


const PAYLOAD_PREFIX = 'KEYPRESSES:';
const MAX_BODY = 8 * 1024;

/** 实际监听端口（端口被占用会顺延），用来拼局域网访问地址 */
let activePort = PORT;

/**
 * 键位表（键名大小写、空格、下划线、连字符都会被忽略）
 * 参考极米无屏助手抓包结果：16735 端口 + "KEYPRESSES:<code>"
 */
const KEY_CODES = {
  power: 116,
  home: 35,
  back: 48,
  menu: 139,

  ok: 49,
  confirm: 49,
  enter: 49,
  center: 49,
  play: 49,
  pause: 49,

  up: 36,
  down: 38,
  left: 50,
  right: 37,
  dpadup: 36,
  dpaddown: 38,
  dpadleft: 50,
  dpadright: 37,

  volup: 115,
  voldown: 114,
  volumeup: 115,
  volumedown: 114,
  mute: 113,
  off: 30,
};

/* ------------------------------------------------------------------ */
/* 工具函数                                                           */
/* ------------------------------------------------------------------ */

function toMs(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function toPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** 接受 IPv4 或局域网主机名，其他一律返回 null */
function normalizeHost(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 253) return null;

  const m = IPV4_RE.exec(v);
  if (m) {
    return m.slice(1).every((part) => Number(part) <= 255) ? v : null;
  }
  return HOSTNAME_RE.test(v) ? v : null;
}

/** 把 "volUp" / "vol+_up" / "115" 之类的输入解析成按键码 */
function resolveKey(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (/^\d{1,5}$/.test(raw)) {
    const n = Number(raw);
    return n > 0 && n < 65536 ? n : null;
  }

  const key = raw.replace(/[\s_-]+/g, '').toLowerCase();
  return KEY_CODES[key] || null;
}

/* ------------------------------------------------------------------ */
/* 配置持久化                                                         */
/* ------------------------------------------------------------------ */

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ip: normalizeHost(parsed && parsed.ip) || FALLBACK_IP };
  } catch {
    return { ip: FALLBACK_IP };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ ip: currentIp }, null, 2) + '\n',
    );
  } catch (err) {
    console.warn(`[config] 配置无法写入磁盘：${err.message}`);
  }
}

const initialConfig = loadConfig();
let currentIp = initialConfig.ip;

/* ------------------------------------------------------------------ */
/* BLE 唤醒（本机 BlueZ 广播）                                          */
/* ------------------------------------------------------------------ */

const ble = {
  enabled: BLE_ENABLED,
  running: false,
  runs: 0,
  lastAt: 0,
  lastError: '',
};
let bleRun = null;

function wakeByBle() {
  if (!ble.enabled) {
    return Promise.reject(new Error('本机未启用 BLE 唤醒'));
  }
  if (bleRun) {
    return bleRun.promise; // 正在广播时复用同一轮，避免叠加
  }

  const startedAt = Date.now();
  const env = { ...process.env, XGIMI_BLE_TOKEN: BLE_TOKEN };
  const child = BLE_RESET
    ? spawn('/bin/sh', ['-c', `/etc/init.d/S40bluetoothd restart >/dev/null 2>&1; for i in $(seq 1 30); do bluetoothctl show 2>/dev/null | grep -q 'Powered: yes' && break; sleep 0.5; done; sleep 1; exec '${process.execPath}' '${BLE_SCRIPT}' --ms ${BLE_MS}`], {
      cwd: DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn(process.execPath, [BLE_SCRIPT, '--ms', String(BLE_MS)], {
      cwd: DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  let errTail = '';
  ble.running = true;
  child.stderr.on('data', (chunk) => {
    errTail = (errTail + chunk.toString()).slice(-400);
  });

  const promise = new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, BLE_MS + (BLE_RESET ? 14000 : 6000));

    child.on('error', (err) => {
      clearTimeout(guard);
      ble.running = false;
      bleRun = null;
      ble.lastError = err.message;
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(guard);
      ble.running = false;
      bleRun = null;
      const ms = Date.now() - startedAt;
      if (code === 0) {
        ble.runs += 1;
        ble.lastAt = Date.now();
        ble.lastError = '';
        console.log(`📡 BLE 广播已发送（${ms}ms，窗口 ${BLE_MS}ms${BLE_RESET ? '，已重置 HCI' : ''}）`);
        resolve({ ms });
        return;
      }
      const reason = errTail.trim().split('\n').filter(Boolean).pop()
        || `ble-wake 退出码 ${code}${signal ? ` / ${signal}` : ''}`;
      ble.lastError = reason;
      console.warn(`[ble] 广播失败：${reason}`);
      reject(new Error(reason));
    });
  });

  bleRun = { promise };
  return promise;
}

/**
 * 开机入口：本机 BlueZ 广播唤醒。
 * 返回 { method, ms, ... }，失败抛出带 status 的 Error。
 */
async function triggerWake() {
  const startedAt = Date.now();

  if (!ble.enabled) {
    const e = new Error('本机未启用蓝牙广播（用 XGIMI_BLE=1 启动）');
    e.status = 400;
    throw e;
  }

  try {
    await wakeByBle();
  } catch (err) {
    const e = new Error(`蓝牙广播失败：${err.message}`);
    e.status = 502;
    throw e;
  }

  return { method: 'ble', ms: Date.now() - startedAt, ble: { runs: ble.runs, lastAt: ble.lastAt } };
}

/* ------------------------------------------------------------------ */
/* 巴法云 · MQTT                                                       */
/* ------------------------------------------------------------------ */

const bemfa = {
  enabled: Boolean(BEMFA_UID && BEMFA_TOPIC),
  connected: false,
  topic: BEMFA_TOPIC,
  lastMessage: '',
  lastAt: 0,
  lastError: '',
  reconnects: 0,
};

let bemfaClient = null;

function publishBemfaState(message) {
  if (!bemfaClient || !bemfa.connected) {
    console.warn(`[bemfa] 未连接，跳过回写 ${message}`);
    return false;
  }
  // /up = 只更新云端状态、不再推送给订阅者，避免自己触发自己
  bemfaClient.publish(`${BEMFA_TOPIC}/up`, message, { qos: 0, retain: false });
  console.log(`☁️  巴法云回写 ${BEMFA_TOPIC}/up → ${message}`);
  return true;
}

/* 风扇档位对应投影仪按键：on#1..on#4 正好当四个快捷键 */
const FAN_KEYS = {
  1: { key: 'volumeup', label: '音量 +' },
  2: { key: 'volumedown', label: '音量 −' },
  3: { key: 'mute', label: '静音' },
  4: { key: 'home', label: '主页' },
};

let bemfaResetTimer = null;

/* 执行完一档后把卡片写回 off，否则米家认为风扇还开着，小爱不会再发「打开」 */
function scheduleBemfaReset() {
  if (!bemfaClient || !bemfa.connected) return;
  if (bemfaResetTimer) clearTimeout(bemfaResetTimer);
  bemfaResetTimer = setTimeout(() => {
    bemfaResetTimer = null;
    publishBemfaState('off');
  }, BEMFA_RESET_MS);
  if (bemfaResetTimer.unref) bemfaResetTimer.unref();
}

async function handleBemfaMessage(topic, payload) {
  const message = payload.toString('utf8').trim();
  bemfa.lastMessage = message;
  bemfa.lastAt = Date.now();
  console.log(`☁️  巴法云收到 [${topic}] ${JSON.stringify(message)}`);

  const cmd = message.toLowerCase();

  // 关闭 = 让投影仪待机（待机后 Wi-Fi 掉电，只能靠 BLE 唤醒）
  if (cmd === 'off' || cmd === 'false' || cmd === '0') {
    try {
      const sent = await sendPayload(currentIp, KEY_CODES.power);
      console.log(`⏻  风扇关闭 → 电源键（待机）  ${sent}`);
    } catch (err) {
      console.warn(`[power] ${err.message}`);
    }
    return;
  }

  if (cmd === 'on' || cmd === 'true' || cmd === '1') {
    console.log('⏻  收到开机指令 → 唤醒');
    try {
      const result = await triggerWake();
      console.log(`⏻  唤醒成功（${result.method}，${result.ms}ms）`);
    } catch (err) {
      console.warn(`⏻  唤醒失败：${err.message}`);
    }
    scheduleBemfaReset();
    return;
  }

  const match = /^on#(\d)$/.exec(cmd);
  if (match) {
    const speed = Number(match[1]);
    const spec = FAN_KEYS[speed];
    if (!spec) {
      console.log(`🌀 未知档位 ${speed}，忽略`);
      return;
    }
    try {
      const sent = await sendPayload(currentIp, KEY_CODES[spec.key]);
      console.log(`🌀 风扇 ${speed} 档 → ${spec.label}  ${sent}`);
      scheduleBemfaReset();
    } catch (err) {
      console.warn(`[fan] ${err.message}`);
    }
    return;
  }

  console.log(`☁️  未知指令 ${JSON.stringify(message)}，忽略`);
}

function startBemfa() {
  if (!bemfa.enabled) {
    console.log('☁️  巴法云未配置（BEMFA_UID / BEMFA_TOPIC），跳过 MQTT 连接');
    return;
  }

  // 巴法云：clientId 用私钥，用户名/密码留空即可
  bemfaClient = mqtt.connect(BEMFA_URL, {
    clientId: BEMFA_UID,
    keepalive: 30,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
    protocolVersion: 4,
  });

  bemfaClient.on('connect', () => {
    bemfa.connected = true;
    bemfa.lastError = '';
    console.log(`☁️  巴法云已连接 ${BEMFA_URL}`);
    // 只订阅主题本身；巴法云不允许订阅 topic/set
    bemfaClient.subscribe(BEMFA_TOPIC, { qos: 0 }, (err, granted) => {
      if (err) console.error(`[bemfa] 订阅失败：${err.message}`);
      else console.log(`☁️  已订阅 ${BEMFA_TOPIC}`, granted ? JSON.stringify(granted) : '');
    });
  });

  bemfaClient.on('message', (topic, payload) => {
    handleBemfaMessage(topic, payload);
  });

  bemfaClient.on('reconnect', () => {
    bemfa.reconnects += 1;
    console.log(`[bemfa] 正在重连…（第 ${bemfa.reconnects} 次）`);
  });

  bemfaClient.on('close', () => {
    bemfa.connected = false;
  });

  bemfaClient.on('error', (err) => {
    bemfa.lastError = err.message;
    console.error(`[bemfa] ${err.message}`);
  });
}

/* ------------------------------------------------------------------ */
/* UDP 发送                                                           */
/* ------------------------------------------------------------------ */

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('error', (err) => console.error(`[udp] ${err.message}`));

function sendPayload(ip, code) {
  const payload = Buffer.from(PAYLOAD_PREFIX + code, 'utf8');
  return new Promise((resolve, reject) => {
    udp.send(payload, 0, payload.length, UDP_PORT, ip, (err) => {
      if (err) reject(err);
      else resolve(payload.toString('utf8'));
    });
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求格式错误'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveHtml(res) {
  fs.readFile(HTML_FILE, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到 index.html，请把它和 server.js 放在同一目录。');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  /* 页面 */
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveHtml(res);
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'max-age=86400' });
    return res.end();
  }

  /* 读取当前配置 */
  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, {
      ok: true,
      ip: currentIp,
      udpPort: UDP_PORT,
      urls: lanUrls(),
      ble: { ...ble },
    });
  }

  /* 巴法云连接状态 */
  if (req.method === 'GET' && pathname === '/api/bemfa') {
    return sendJson(res, 200, {
      ok: true,
      enabled: bemfa.enabled,
      connected: bemfa.connected,
      topic: BEMFA_TOPIC,
      url: BEMFA_URL,
      lastMessage: bemfa.lastMessage,
      lastAt: bemfa.lastAt,
      lastError: bemfa.lastError,
      reconnects: bemfa.reconnects,
    });
  }

  /* 修改投影仪地址 */
  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readBody(req);
    if (body.ip === undefined) {
      return sendJson(res, 400, { ok: false, error: '没有需要更新的配置' });
    }

    const ip = normalizeHost(body.ip);
    if (!ip) {
      return sendJson(res, 400, { ok: false, error: '请输入有效的 IPv4 地址或主机名' });
    }

    const changed = ip !== currentIp;
    currentIp = ip;
    saveConfig();
    if (changed) console.log(`⚙  投影仪地址已更新：${currentIp}`);

    return sendJson(res, 200, {
      ok: true,
      ip: currentIp,
      udpPort: UDP_PORT,
    });
  }

  /* 唤醒：本机 BLE 广播 */
  if (req.method === 'POST' && pathname === '/api/poweron') {
    try {
      const result = await triggerWake();
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, err.status || 502, { ok: false, error: err.message });
    }
  }

  /* 发送按键 */
  if (req.method === 'POST' && pathname === '/api/key') {
    const body = await readBody(req);
    const code = resolveKey(body.key ?? body.code);
    if (!code) {
      return sendJson(res, 400, { ok: false, error: '未知按键' });
    }

    const target = body.ip === undefined || body.ip === '' ? currentIp : normalizeHost(body.ip);
    if (!target) {
      return sendJson(res, 400, { ok: false, error: 'IP 地址格式不正确' });
    }

    try {
      const payload = await sendPayload(target, code);
      console.log(`→  ${target}:${UDP_PORT}  ${payload}`);
      return sendJson(res, 200, { ok: true, ip: target, code, payload });
    } catch (err) {
      console.error(`✗  ${target}:${UDP_PORT}  ${err.message}`);
      return sendJson(res, 502, { ok: false, error: `发送失败：${err.message}` });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
    else res.end();
  });
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

function lanAddresses() {
  const seen = new Set();
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // utun/gif/stf/awdl/llw 是 VPN、隔空投送这类点对点接口，手机访问不到
    if (/^(utun|gif|stf|awdl|llw)/i.test(name)) continue;
    for (const ni of list || []) {
      if (!ni || ni.family !== 'IPv4' || ni.internal) continue;
      if (seen.has(ni.address)) continue;
      seen.add(ni.address);
      out.push({ name, address: ni.address });
    }
  }
  return out;
}

function lanUrls(port = activePort) {
  return lanAddresses().map(({ address }) => `http://${address}:${port}`);
}

function printBanner(port) {
  const urls = lanUrls(port);

  const lines = [
    '',
    '  ┌──────────────────────────────────────────┐',
    '  │   极米遥控器 · XGIMI Remote              │',
    '  └──────────────────────────────────────────┘',
    `  本机访问    http://localhost:${port}`,
    ...(urls.length
      ? urls.map((url) => `  局域网访问  ${url}`)
      : ['  局域网访问  未检测到局域网 IPv4，请先连接 Wi-Fi']),
    `  当前投影仪  ${currentIp}   (UDP ${UDP_PORT})`,
    `  蓝牙唤醒    ${ble.enabled ? `本机广播（${BLE_MS}ms）` : '未启用（XGIMI_BLE=1 开启）'}`,
    `  巴法云      ${bemfa.enabled ? `${BEMFA_TOPIC} · ${BEMFA_URL}` : '未配置（BEMFA_UID / BEMFA_TOPIC）'}`,
    '',
    '  手机与投影仪需要连接同一个局域网；',
    '  打开页面后点击右上角齿轮即可修改 IP。',
    '',
  ];

  if (HOST !== '0.0.0.0') {
    lines.push(`  ⚠ 当前 HOST=${HOST}，仅该地址可访问；不设置 HOST 才会对局域网开放。`, '');
  }

  console.log(lines.join('\n'));
}

function start(port, retries = 8) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`端口 ${port} 被占用，尝试 ${port + 1}…`);
      setTimeout(() => start(port + 1, retries - 1), 120);
      return;
    }
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    activePort = port;
    printBanner(port);
  });
}

function shutdown() {
  try {
    udp.close();
  } catch {
    /* 未绑定过，忽略 */
  }
  if (bemfaClient) {
    try {
      bemfaClient.end(true);
    } catch {
      /* 忽略 */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start(PORT);
startBemfa();
