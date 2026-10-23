# 极米唤醒 · Android 版

在手机上伪造极米原装蓝牙遥控器的「电源键」广播，把待机（Wi-Fi 已关闭）的投影仪叫醒。

```
手机 App ──BLE 广播(0x0046 + token)──> 投影仪蓝牙
                                        └─> 开机，Wi-Fi 恢复
```

## 直接安装

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

或者把 `app-debug.apk` 传到手机（微信/网盘/数据线）手动安装，允许「安装未知来源应用」即可。
最低 Android 8.0（API 26），需要手机支持 BLE 外设广播（绝大多数 2017 年后的手机都支持）。

## 使用

1. 打开「极米唤醒」，token 已经内置（`2753ce4b…544d`，属于你自己的投影仪）。
2. 投影仪处于待机状态，遥控器放在一边（避免它同时发广播）。
3. 点「唤醒投影仪」，App 会连续广播 4 轮、约 4 秒，和按一下遥控器电源键等价。
4. 看投影仪是否亮起。没有反应就再点一次，或者走近一点（蓝牙有效距离约 5–10 米）。

卡片里的「设备检查」会显示手机蓝牙状态和系统是否报告支持 BLE 广播；
如果提示不支持，先关掉其他占用广播的 App（手环/车钥匙/小米之家等）再试。

## 重新编译

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
cd android
~/.gradle/wrapper/dists/gradle-8.11.1-bin/*/gradle-8.11.1/bin/gradle assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

也可以用 Android Studio 直接打开 `android/` 目录。

## 广播内容

和原装遥控器一致的部分（共 27 字节，没超过 31 字节上限）：

| 字段 | 值 |
| --- | --- |
| Flags | `02 01 06` |
| HID 服务 | `03 03 12 18`（0x1812） |
| 厂商数据 | `13 FF 46 00` + 16 字节 token（company ID 0x0046） |

原装遥控器还会带 `Appearance = 0x03C1`、名称 `Bluetooth 4.0 RC`（放在 scan response）。
Android 的广播 API 不能设置 appearance，也塞不下 scan response 里的名字，所以这两项缺失。

## 如果唤不醒

按可能性排序：

1. **投影仪同时校验 appearance / 名称 / MAC**：手机无法伪造，需要 ESP32 网关（见仓库根目录 `firmware/xgimi-wake`，能完整复刻 31 字节 + scan response）。
2. **token 不对**：换过主板/遥控器配对信息变了，需要重新抓（`tools/README.md` 有 Mac 抓包方法，或 Android 用 nRF Connect 看 `0x0046`）。
3. **系统禁用了 BLE 广播**：部分 ROM（省电模式/儿童模式）会限制；关掉省电、允许后台运行再试。
4. **投影仪没在待机**：已经开机时不需要唤醒，直接用网页遥控器。

## 安全

token 相当于这台投影仪的蓝牙钥匙，不要发到公开群/仓库。
