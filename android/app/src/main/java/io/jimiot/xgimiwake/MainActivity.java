package io.jimiot.xgimiwake;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.android.material.textfield.TextInputEditText;

public class MainActivity extends AppCompatActivity implements BleWake.Listener {

    private static final String PREFS = "xgimi";
    private static final String KEY_TOKEN = "token";
    private static final String DEFAULT_TOKEN = "2753ce4b21129cffffff3043524b544d";

    private TextInputEditText tokenInput;
    private TextView tokenError;
    private TextView statusText;
    private TextView progressText;
    private TextView btState;
    private TextView advSupport;
    private TextView deviceInfo;
    private View statusDot;
    private MaterialButton wakeButton;
    private LinearProgressIndicator progress;
    private BleWake bleWake;
    private SharedPreferences prefs;

    private final ActivityResultLauncher<String[]> permissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                if (hasBlePermissions()) {
                    onReadyToWake();
                } else {
                    toast("没有蓝牙权限，无法发送广播");
                }
            });

    private final ActivityResultLauncher<Intent> enableBluetoothLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (isBluetoothEnabled()) {
                    beginWake();
                } else {
                    toast("蓝牙没有打开");
                }
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        statusDot = findViewById(R.id.statusDot);
        statusText = findViewById(R.id.statusText);
        progressText = findViewById(R.id.progressText);
        progress = findViewById(R.id.progress);
        wakeButton = findViewById(R.id.wakeButton);
        tokenInput = findViewById(R.id.tokenInput);
        tokenError = findViewById(R.id.tokenError);
        btState = findViewById(R.id.btState);
        advSupport = findViewById(R.id.advSupport);
        deviceInfo = findViewById(R.id.deviceInfo);

        bleWake = new BleWake(this, this);
        progress.setMax(BleWake.BURST_COUNT);
        progress.setProgress(0);

        tokenInput.setText(prefs.getString(KEY_TOKEN, DEFAULT_TOKEN));
        tokenInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                hideTokenError();
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });

        wakeButton.setOnClickListener(v -> ensurePermissionsAndWake());
        updateDiagnostics();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateDiagnostics();
    }

    @Override
    protected void onDestroy() {
        if (bleWake != null) {
            bleWake.stop();
        }
        super.onDestroy();
    }

    private void ensurePermissionsAndWake() {
        if (!hasBlePermissions()) {
            permissionLauncher.launch(requiredPermissions());
            return;
        }
        onReadyToWake();
    }

    private void onReadyToWake() {
        if (!isBluetoothEnabled()) {
            try {
                enableBluetoothLauncher.launch(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE));
            } catch (Exception e) {
                toast("无法请求打开蓝牙：" + e.getMessage());
            }
            return;
        }
        beginWake();
    }

    private void beginWake() {
        String hex = normalizeHex(tokenInput.getText());
        byte[] token = hexToBytes(hex);
        if (token == null) {
            showTokenError("token 需要 32 位十六进制字符");
            return;
        }
        hideTokenError();
        prefs.edit().putString(KEY_TOKEN, hex).apply();

        vibrate();
        setBusy(true);
        bleWake.start(token);
    }

    private void setBusy(boolean busy) {
        wakeButton.setEnabled(!busy);
        wakeButton.setText(busy ? "广播中…" : "唤醒投影仪");
        if (busy) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private boolean isBluetoothEnabled() {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            return false;
        }
        try {
            return adapter.isEnabled();
        } catch (SecurityException e) {
            return false;
        }
    }

    private BluetoothAdapter adapter() {
        BluetoothManager manager = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean hasBlePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        return ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_ADVERTISE)
                == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }

    private String[] requiredPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[]{
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_CONNECT
            };
        }
        return new String[0];
    }

    private void updateDiagnostics() {
        BluetoothAdapter adapter = adapter();
        String state;
        if (adapter == null) {
            state = "不可用";
        } else {
            boolean on;
            try {
                on = adapter.isEnabled();
            } catch (SecurityException e) {
                on = false;
            }
            state = on ? "已开启" : "已关闭";
        }
        btState.setText("手机蓝牙：" + state);

        boolean supported = false;
        try {
            supported = adapter != null && adapter.isMultipleAdvertisementSupported();
        } catch (SecurityException ignored) {
        }
        advSupport.setText(supported
                ? "BLE 广播：系统报告支持"
                : "BLE 广播：系统报告不支持（仍可点按钮实测）");

        deviceInfo.setText(Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE);
    }

    private void vibrate() {
        try {
            Vibrator vibrator = getSystemService(Vibrator.class);
            if (vibrator != null) {
                vibrator.vibrate(VibrationEffect.createOneShot(18, VibrationEffect.DEFAULT_AMPLITUDE));
            }
        } catch (Exception ignored) {
        }
    }

    private void showTokenError(String message) {
        tokenError.setText(message);
        tokenError.setVisibility(View.VISIBLE);
    }

    private void hideTokenError() {
        tokenError.setVisibility(View.GONE);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    static String normalizeHex(CharSequence raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (Character.digit(c, 16) >= 0) {
                out.append(Character.toLowerCase(c));
            }
        }
        return out.toString();
    }

    static byte[] hexToBytes(String hex) {
        if (hex == null || hex.length() != 32) {
            return null;
        }
        byte[] out = new byte[16];
        for (int i = 0; i < 16; i++) {
            int high = Character.digit(hex.charAt(i * 2), 16);
            int low = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) {
                return null;
            }
            out[i] = (byte) ((high << 4) | low);
        }
        return out;
    }

    @Override
    public void onStatus(String text) {
        statusText.setText(text);
        statusDot.setBackgroundResource(R.drawable.dot_busy);
    }

    @Override
    public void onBurst(int index, int total) {
        progress.setProgress(index);
        progressText.setText(index + " / " + total);
        statusText.setText("广播中 · 第 " + index + " / " + total + " 轮");
        vibrate();
    }

    @Override
    public void onDone() {
        setBusy(false);
        progress.setProgress(BleWake.BURST_COUNT);
        progressText.setText(BleWake.BURST_COUNT + " / " + BleWake.BURST_COUNT);
        statusText.setText("广播完成 · 看投影仪是否亮起");
        statusDot.setBackgroundResource(R.drawable.dot_idle);
        toast("已发送 4 轮唤醒广播");
    }

    @Override
    public void onError(String message) {
        setBusy(false);
        statusText.setText(message);
        statusDot.setBackgroundResource(R.drawable.dot_error);
        toast(message);
    }
}
