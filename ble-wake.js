#!/usr/bin/env node
'use strict';

/**
 * 极米投影仪 BLE 唤醒广播（BlueZ D-Bus）
 *
 * 复刻原装遥控器的 legacy 广播：
 *   02 01 06 | 03 03 12 18 | 03 19 C1 03 | 13 FF 46 00 <16 字节 token>
 * 通过 org.bluez.LEAdvertisingManager1 注册一个 LEAdvertisement1 实例，
 * 广播 duration 毫秒后注销（默认 4000ms，与原厂遥控器按一次电源键的行为一致）。
 *
 * 用法：
 *   node ble-wake.js [--token HEX32] [--ms 4000] [--adapter hci0]
 * 环境变量：XGIMI_BLE_TOKEN / XGIMI_BLE_MS / XGIMI_BLE_ADAPTER
 */

const dbus = require('dbus-next');
const { Interface } = dbus.interface;

const DEFAULT_TOKEN = '2753ce4b21129cffffff3043524b544d';
const HID_UUID = '00001812-0000-1000-8000-00805f9b34fb';
const COMPANY_ID = 0x0046;
const ADAPTER = process.env.XGIMI_BLE_ADAPTER || 'hci0';
// 每次用独立路径：复用同一 D-Bus 路径时 BlueZ 可能保留旧的广播实例，
// 导致后续注册"成功"但控制器其实没在发。
const PATH = '/io/jimiot/xgimiwake/adv_' + process.pid;
const BUS_NAME = 'io.jimiot.xgimiwake';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const tokenHex = (arg('token', process.env.XGIMI_BLE_TOKEN || DEFAULT_TOKEN) || '').replace(/[^0-9a-fA-F]/g, '');
const durationMs = Number(arg('ms', process.env.XGIMI_BLE_MS || 4000)) || 4000;
const adapter = arg('adapter', ADAPTER);

if (tokenHex.length !== 32) {
  console.error('ble-wake: token 必须是 32 位十六进制（16 字节），当前 ' + tokenHex.length + ' 位');
  process.exit(2);
}
const token = Buffer.from(tokenHex, 'hex');

class Advertisement extends Interface {
  constructor() {
    super('org.bluez.LEAdvertisement1');
    this.released = false;
  }
  get Type() { return 'peripheral'; }
  get ServiceUUIDs() { return [HID_UUID]; }
  get ManufacturerData() { return { [COMPANY_ID]: new dbus.Variant('ay', Array.from(token)) }; }
  get LocalName() { return 'Bluetooth 4.0 RC'; }
  get Appearance() { return 0x03c1; }
  Release() { this.released = true; }
}

Advertisement.configureMembers({
  properties: {
    Type: { signature: 's', access: 'read' },
    ServiceUUIDs: { signature: 'as', access: 'read' },
    ManufacturerData: { signature: 'a{qv}', access: 'read' },
    LocalName: { signature: 's', access: 'read' },
    Appearance: { signature: 'q', access: 'read' },
  },
  methods: {
    Release: { inSignature: '', outSignature: '' },
  },
});

async function main() {
  const started = Date.now();
  const bus = dbus.systemBus();
  const ad = new Advertisement();
  bus.export(PATH, ad);

  const obj = await bus.getProxyObject('org.bluez', '/org/bluez/' + adapter);
  const manager = obj.getInterface('org.bluez.LEAdvertisingManager1');

  await manager.RegisterAdvertisement(PATH, {});

  if (process.argv.includes('--debug')) {
    const self = await bus.getProxyObject(bus.name, PATH);
    const props = await self.getInterface('org.freedesktop.DBus.Properties').GetAll('org.bluez.LEAdvertisement1');
    console.log('ble-wake: properties =', JSON.stringify(props, (k, v) => (v && v.constructor && v.constructor.name === 'Variant') ? { [v.signature]: v.value } : v));
  }
  console.log('ble-wake: advertising on ' + adapter + ' for ' + durationMs + 'ms');

  const stop = async () => {
    try { await manager.UnregisterAdvertisement(PATH); } catch (e) { /* ignore */ }
    try { bus.disconnect(); } catch (e) { /* ignore */ }
  };
  const timer = setTimeout(async () => {
    await stop();
    console.log('ble-wake: done in ' + (Date.now() - started) + 'ms');
    process.exit(0);
  }, durationMs);
  const abort = async () => { clearTimeout(timer); await stop(); process.exit(0); };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  // Release() 被 BlueZ 调用时（例如适配器关闭）直接退出
  const watch = setInterval(() => { if (ad.released) { clearInterval(watch); clearTimeout(timer); stop().then(() => process.exit(0)); } }, 200);
  watch.unref();
}

main().catch((err) => {
  console.error('ble-wake: 失败 - ' + (err && err.message ? err.message : err));
  process.exit(1);
});
