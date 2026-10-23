# 极米投影仪遥控 · jimiot

三块能力，可单独用，也可串起来：

| 目录/文件 | 作用 |
| --- | --- |
| `server.js` + `index.html` | 局域网网页遥控器（UDP `KEYPRESSES:<code>` → 投影仪 16735） |
| `android/` | Android App：伪造原装遥控器的 BLE 广播，待机时唤醒投影仪 |
| `ble-wake.js` | Linux + BlueZ 本机 BLE 广播唤醒（盒子上的正式方案） |

`server.js` 另外内置了**巴法云 MQTT**，以风扇设备的身份把 4 个快捷动作接进米家/小爱。

## 运行

```bash
cd /Users/tianmiao/workspaces/jimiot
npm install
node server.js
```

默认 <http://localhost:3000>，局域网地址启动时会打印。

## 巴法云接入（米家风扇）

米家里用「风扇」类型，主题共 4 档，正好当 4 个快捷键：

| 米家/小爱消息 | 投影仪动作 | 键码 |
| --- | --- | --- |
| `on` | 蓝牙开机唤醒（8 秒广播，米家里约 10 秒出结果） | — |
| `off` | 电源键（待机；待机后 Wi-Fi 掉电） | 116 |
| `on#1` | 音量 + | 115 |
| `on#2` | 音量 − | 114 |
| `on#3` | 静音 | 113 |
| `on#4` | 回到主页 | 35 |

- 主题：`jimi003`（巴法云按主题名后三位决定米家设备类型）；
- 私钥默认写在 `server.js` 的 `BEMFA_UID` 兜底值里，建议改用环境变量：

```bash
BEMFA_UID=你的32位私钥 BEMFA_TOPIC=jimi003 node server.js
```

- 每次执行完 `on` / `on#N` 后，2.5 秒往 `jimi003/up` 回写 `off`，
  让米家卡片回到关闭态，否则小爱会认为风扇还开着、不再发送「打开」；
- 回写只同步云端状态，不会再次触发自己；
- 档位是「按一下」的动作，不保持投影仪状态；
- 断线每 3 秒自动重连，30 秒心跳。

查看连接状态：`GET /api/bemfa`

```bash
curl -s http://localhost:3000/api/bemfa
```

> 米家的第三方设备只会出现在「我的 → 其他平台设备」，不会进首页房间；
> 设备必须在线（巴法控制台显示订阅者在线）时米家才能同步。

## 开机 / 唤醒

巴法收到 `on`、网页点「开机」都会触发 `POST /api/poweron`，由本机 `ble-wake.js`
发 8 秒 BLE 广播；网页「关机」/ 巴法 `off` 走 UDP 电源键（116，待机）。

> 每次广播前都要重启一次 `bluetoothd`：AIC8800 跑完一轮 enable/disable 后会“假发”，
> 注册成功但空中没有报文；只有重启 BlueZ 能恢复（`XGIMI_BLE_RESET=0` 可关掉）。
> 所以一次唤醒约 7–11 秒，属于正常。

## 部署到 Linux 盒子（Buildroot）

现网设备：`root@192.168.1.206`（用户名 root，密钥 `/Users/tianmiao/Documents/keys/id_rsa`），
目录 `/userdata/jimiot`，Node 在 `/usr/sbin/node`（v22.20.0，无 npm）。

```bash
# 1. 打包（不含 .git/.deploy/.tmp）
tar --exclude .deploy --exclude .tmp --exclude .git -czf /tmp/jimiot.tgz server.js index.html package.json package-lock.json README.md node_modules

# 2. 上传并解包
scp -i ~/Documents/keys/id_rsa /tmp/jimiot.tgz root@192.168.1.206:/tmp/
ssh -i ~/Documents/keys/id_rsa root@192.168.1.206 'mkdir -p /userdata/jimiot && tar -xzf /tmp/jimiot.tgz -C /userdata/jimiot'

# 3. 装开机自启脚本（包内已带，首次或脚本变更时）
scp -i ~/Documents/keys/id_rsa deploy/S99jimiot root@192.168.1.206:/etc/init.d/S99jimiot
ssh -i ~/Documents/keys/id_rsa root@192.168.1.206 'chmod +x /etc/init.d/S99jimiot && /etc/init.d/S99jimiot restart'
```

服务管理：

```bash
/etc/init.d/S99jimiot status     # 运行状态
/etc/init.d/S99jimiot restart    # 改完代码重启
tail -f /userdata/jimiot/jimiot.log
```

- Buildroot 用 busybox init：`/etc/init.d/S99jimiot` 在开机时按 S 序号自动执行；
- 启动用 `start-stop-daemon -S -b -m`，真正执行的是 `/userdata/jimiot/run.sh`，
  日志超过 512KB 时自动轮转到 `jimiot.log.1`；
- 盒子没有 npm，`node_modules`（含 mqtt）随包上传；
- 本机与盒子不要同时运行：巴法云同一个私钥同时只允许一个 MQTT 连接。

## BLE 唤醒

`ble-wake.js` 用 BlueZ D-Bus 复刻原装遥控器的 31 字节广播（company 0x0046 + 16 字节 token，
服务 0x1812、appearance 0x03c1、名字 `Bluetooth 4.0 RC`），默认广播 4 秒。

```bash
# 单次测试（需要 dbus-next + BlueZ）
node ble-wake.js --ms 4000
# 开启后 /api/poweron 与米家「开」都会走本机 BLE
XGIMI_BLE=1 node server.js
```

盒子上已写入 `run.sh`（`XGIMI_BLE=1 XGIMI_BLE_MS=8000`），开机自启即带唤醒能力。

> 这颗 AIC8800 只稳定维持一路广播，厂商自带的 BLE 广播已停用；
> 若唤醒失败，看 `GET /api/config` 的 `ble.lastError`。
