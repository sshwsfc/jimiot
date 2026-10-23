package io.jimiot.xgimiwake;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import java.util.UUID;

/**
 * 伪造极米遥控器的 BLE 电源键广播。
 *
 * 原装遥控器唤醒时广播的厂商数据是 0x0046 + 16 字节 token；
 * 这里用经典（legacy）可连接广播，把 HID 服务 0x1812 和厂商数据装进 31 字节内，
 * 连续发 4 轮，每轮 700ms，间隔 200ms。
 */
public final class BleWake {

    private static final String TAG = "BleWake";

    public static final int BURST_COUNT = 4;
    public static final int BURST_ON_MS = 700;
    public static final int BURST_GAP_MS = 250;

    private static final UUID HID_SERVICE = UUID.fromString("00001812-0000-1000-8000-00805f9b34fb");
    private static final int COMPANY_ID = 0x0046;

    public interface Listener {
        void onStatus(String text);

        void onBurst(int index, int total);

        void onDone();

        void onError(String message);
    }

    private final Context context;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private BluetoothLeAdvertiser advertiser;
    private byte[] token;
    private int burst;
    private boolean running;
    private boolean burstActive;
    private int retries;

    private final AdvertiseCallback callback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            if (!running) {
                return;
            }
            burstActive = true;
            listener.onBurst(burst, BURST_COUNT);
            handler.postDelayed(BleWake.this::finishBurst, BURST_ON_MS);
        }

        @Override
        public void onStartFailure(int errorCode) {
            if (!running) {
                return;
            }
            // 上一轮停得慢时系统会报 ALREADY_STARTED，等一会儿再试，不要直接失败
            if (errorCode == AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED && retries < 2) {
                retries += 1;
                handler.postDelayed(BleWake.this::startAdvertise, 300);
                return;
            }
            fail("广播启动失败（" + statusName(errorCode) + "）");
        }
    };

    public BleWake(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    public boolean isRunning() {
        return running;
    }

    public void start(byte[] token) {
        if (running) {
            return;
        }
        this.token = token.clone();

        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) {
            listener.onError("这台设备没有蓝牙模块");
            return;
        }
        try {
            if (!adapter.isEnabled()) {
                listener.onError("请先打开手机蓝牙");
                return;
            }
            advertiser = adapter.getBluetoothLeAdvertiser();
        } catch (SecurityException e) {
            listener.onError("缺少蓝牙权限，请在系统设置里允许“附近的设备”");
            return;
        }
        if (advertiser == null) {
            listener.onError("这台手机不支持 BLE 外设广播");
            return;
        }

        running = true;
        burst = 0;
        burstActive = false;
        retries = 0;
        listener.onStatus("准备广播…");
        handler.postDelayed(this::nextBurst, 80);
    }

    public void stop() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        if (burstActive && advertiser != null) {
            try {
                advertiser.stopAdvertising(callback);
            } catch (Exception ignored) {
                /* 已经停了 */
            }
        }
        burstActive = false;
    }

    private void nextBurst() {
        if (!running) {
            return;
        }
        if (burst >= BURST_COUNT) {
            running = false;
            handler.removeCallbacksAndMessages(null);
            listener.onStatus("广播完成");
            listener.onDone();
            return;
        }

        burst += 1;
        retries = 0;
        startAdvertise();
    }

    private void startAdvertise() {
        if (!running) {
            return;
        }
        try {
            advertiser.startAdvertising(settings(), data(), callback);
        } catch (SecurityException e) {
            fail("缺少蓝牙权限，请在系统设置里允许“附近的设备”");
        } catch (Exception e) {
            fail("广播失败：" + e.getMessage());
        }
    }

    private void finishBurst() {
        if (!running || !burstActive) {
            return;
        }
        burstActive = false;
        try {
            advertiser.stopAdvertising(callback);
        } catch (Exception ignored) {
            /* 已经被超时停掉了 */
        }
        handler.postDelayed(this::nextBurst, BURST_GAP_MS);
    }

    private AdvertiseSettings settings() {
        return new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(BURST_ON_MS)
                .build();
    }

    private AdvertiseData data() {
        return new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .addServiceUuid(new ParcelUuid(HID_SERVICE))
                .addManufacturerData(COMPANY_ID, token)
                .build();
    }

    private void fail(String message) {
        Log.w(TAG, message);
        stop();
        listener.onError(message);
    }

    private static String statusName(int code) {
        switch (code) {
            case AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE:
                return "数据超过 31 字节";
            case AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS:
                return "没有可用的广播实例，先关掉其他广播类 App";
            case AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED:
                return "已经在广播中";
            case AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR:
                return "系统内部错误";
            case AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED:
                return "这台手机不支持 BLE 广播";
            default:
                return "错误码 " + code;
        }
    }
}
