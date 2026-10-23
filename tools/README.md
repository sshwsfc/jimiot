# 抓取极米遥控器的 BLE 开机 token

每台极米投影仪的蓝牙遥控器都有一个 **16 字节的 token**，格式是
`13 FF 46 00 <16 字节 token>`（`46 00` 是蓝牙联盟分配给极米的 company ID）。
这个项目需要把你自己投影仪的 token 填进 `firmware/xgimi-wake/config.h`。

## 方法一：Mac + 本目录的扫描器（最省事）

```bash
# 编译（只需一次）
clang -fobjc-arc -framework Foundation -framework CoreBluetooth \
      tools/ble-scan.m -o tools/ble-scan

# 先让投影仪处于待机/关机，然后运行
./tools/ble-scan
```

看到 `0x0046` 的行，把 `DATA` 后面的 16 字节抄下来：

```
[12:34:56] RSSI -54  FF 46 00  2753ce4b21129cffffff3043524b544d
```

按一下原装遥控器的电源键（广播只持续 4 秒左右），所以脚本要提前跑。
`--all` 可以查看所有设备，用来确认蓝牙本身工作正常。

> macOS 13+ 第一次运行会弹“终端想使用蓝牙”，要点允许；
> 系统设置 → 隐私与安全性 → 蓝牙 里给终端打勾。

## 方法二：Android + nRF Connect

1. 投影仪待机，打开 nRF Connect → Scanner
2. 按一下原装遥控器的电源键
3. 列表里找广播名为 `Bluetooth 4.0 RC` 的设备
4. 展开 **Manufacturer data**，复制 `0x0046` 后面的 16 字节

选项里打开 **RAW** 能看到完整的 31 字节（flags、UUID 0x1812、appearance 0x03C1），
用来核对格式。

## 方法三：Android HCI 日志（要看完整广播包时）

1. 开发者选项打开“启用蓝牙 HCI 信息收集日志”
2. 复现一次按电源键
3. `adb bugreport` 取出 `btsnoop_hci.log`，Wireshark 里过滤 `btle` 和 `0x0046`

Windows 用 Wireshark + nRF Sniffer 也一样。

## 方法四：Home Assistant

已接入 HA 的话，开一个 Bluetooth Advertisement Monitor：

```yaml
type: monitor
manufacturer_id: 0x0046
```

投影仪待机时按遥控器，事件里的 `data` 就是 16 字节 token。

## 填到项目里

```bash
# 直接改 config.h 里的 XGIMI_TOKEN，重新烧录；或
curl -X POST http://xgimi-wake.local/token \
     -d '2753ce4b21129cffffff3043524b544d'
```

token 只属于你的投影仪，不要用别人示例里的值，也不要提交到公开仓库。
