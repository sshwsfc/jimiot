# 极米投影仪 BLE 唤醒网关（ESP32）

投影仪待机时会把 Wi-Fi 关掉，`KEYPRESSES:` 的 UDP 遥控发不进去。
原装遥控器的电源键靠 **低功耗蓝牙广播** 唤醒投影仪；这个固件用 ESP32
伪造同一条广播，于是网页遥控器也能真正“开机”。

```
网页 / 手机  ──HTTP──▶  server.js  ──HTTP──▶  ESP32  ──BLE 广播──▶  投影仪
                        (Mac/电脑)             (蓝牙网关)
```

## 广播内容

固件发出的 31 字节 legacy advertising 与原装遥控器一致：

| 字节 | 含义 |
| --- | --- |
| `02 01 06` | Flags |
| `03 03 12 18` | HID Service UUID `0x1812` |
| `03 19 C1 03` | Appearance `0x03C1` |
| `13 FF 46 00` + 16 字节 token | Manufacturer data，company ID `0x0046` |
| Scan Response `11 09 "Bluetooth 4.0 RC"` | 设备名（16 字节） |

`token` 是每台投影仪不同的一串 16 字节值，需要通过抓包获得（见
[`../../tools/README.md`](../../tools/README.md) 或 HA 的 Advertisement Monitor）。

## 硬件

- ESP32 开发板一块（WROOM-32 最省事；ESP32-C3 也行，纯 BLE）
- USB 供电，放在投影仪 1~3 米内、中间别隔墙
- 不需要接线、不需要红外

## 烧录

用 VS Code + PlatformIO 打开本目录，或者命令行：

```bash
cd firmware/xgimi-wake
pio run -t upload          # 编译 + 烧录
pio device monitor         # 看串口日志
```

Arduino IDE 的话：装好 esp32 core，打开 `xgimi-wake.ino` 直接上传即可。

## 配置

1. 打开 `config.h`，填 Wi-Fi（**必须 2.4GHz**）和 token：

   ```c
   #define WIFI_SSID "YOUR_WIFI_SSID"
   #define WIFI_PASS "YOUR_WIFI_PASSWORD"
   #define XGIMI_TOKEN "2753ce4b21129cffffff3043524b544d"   // 换成你自己抓到的
   ```

2. 烧录后串口会打印地址：

   ```
   [wifi] http://xgimi-wake.local  (192.168.1.88)
   ```

3. 验证：

   ```bash
   curl http://xgimi-wake.local/status
   curl -X POST http://xgimi-wake.local/wake
   ```

   `POST /wake` 立即返回 `202`，随后 4 秒内发 4 次广播（700ms 开 / 200ms 关），
   跟原装遥控器按一下电源的节奏一致。

4. 不想重新烧录时可以直接改 token：

   ```bash
   curl -X POST http://xgimi-wake.local/token \
        -d '2753ce4b21129cffffff3043524b544d'
   ```

   token 存在 NVS 里，重启不丢。

## 接到网页遥控器

两种方式，任选：

**A. 网页设置里填网关地址**

点右上角齿轮 → “蓝牙唤醒网关”填 `xgimi-wake.local` → 保存。
之后**长按电源键 650ms** 就会走 `/api/poweron`；短按仍是普通的电源键（UDP 116）。

**B. 环境变量启动**

```bash
XGIMI_WAKER=http://xgimi-wake.local node server.js
```

## 排错

| 现象 | 处理 |
| --- | --- |
| 串口 `[ble] config adv failed` | 换 `esp32dev` 环境重编；某些 C3 板子需要 3.x core |
| `/wake` 返回 202 但投影仪不亮 | 检查 token 是否属于这台投影仪；靠近一点；确认投影仪在待机而不是断电 |
| 广播后偶尔能唤醒 | 把 `BURST_COUNT` 调到 6、`BURST_ON_MS` 调到 900 |
| 手机搜不到 ESP32 | 广播只有 4 秒，属正常；`/status` 能访问就说明固件在跑 |
| `xgimi-wake.local` 解析不到 | 路由器屏蔽了 mDNS 时，直接用串口打印的 IP |

> 注意：固件只能“开机 / 唤醒”，不能关机。关机请用网页上的电源键
> （UDP `KEYPRESSES:116`，待机不断电），彻底断电后任何网络方式都唤不醒。

## 安全

token 等价于这台投影仪的遥控器钥匙，别发到公开仓库；只在你自己的局域网里用。
