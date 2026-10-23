// tools/ble-scan.m
// 扫描 BLE 广播并打印 manufacturer data，用于抓取极米遥控器的开机 token。
// 编译：clang -fobjc-arc -framework Foundation -framework CoreBluetooth tools/ble-scan.m -o tools/ble-scan
// 运行：./tools/ble-scan           只显示 0x0046（极米）的广播
//      ./tools/ble-scan --all     显示所有带 manufacturer data 的广播
// 时机：投影仪处于待机/关机，然后按一下原装遥控器的电源键（广播只持续几秒）。

#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>

static BOOL gShowAll = NO;
static NSMutableDictionary<NSString *, NSDate *> *gLastSeen;

@interface Sniffer : NSObject <CBCentralManagerDelegate>
@property(nonatomic, strong) CBCentralManager *central;
@end

@implementation Sniffer

- (instancetype)init {
    self = [super init];
    if (self) {
        _central = [[CBCentralManager alloc] initWithDelegate:self queue:nil];
    }
    return self;
}

- (NSString *)stateName:(CBManagerState)state {
    switch (state) {
        case CBManagerStatePoweredOn: return @"poweredOn";
        case CBManagerStatePoweredOff: return @"poweredOff（蓝牙未打开）";
        case CBManagerStateUnauthorized: return @"unauthorized（没有蓝牙权限）";
        case CBManagerStateUnsupported: return @"unsupported（本机不支持 BLE）";
        case CBManagerStateResetting: return @"resetting";
        default: return @"unknown";
    }
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (central.state != CBManagerStatePoweredOn) {
        printf("蓝牙状态：%s\n", [self stateName:central.state].UTF8String);
        if (central.state == CBManagerStateUnauthorized) {
            printf("请到 系统设置 → 隐私与安全性 → 蓝牙，允许终端访问蓝牙后重试。\n");
        }
        return;
    }
    printf("蓝牙就绪，开始扫描… 按一下投影仪遥控器的电源键（投影仪需在待机状态）\n");
    fflush(stdout);
    [central scanForPeripheralsWithServices:nil
                                    options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @YES}];
}

- (void)centralManager:(CBCentralManager *)central
    didDiscoverPeripheral:(CBPeripheral *)peripheral
        advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                     RSSI:(NSNumber *)RSSI {
    NSData *raw = advertisementData[CBAdvertisementDataManufacturerDataKey];
    if (raw.length <= 2) return;

    const uint8_t *bytes = raw.bytes;
    uint16_t vendor = (uint16_t)(bytes[0] | (bytes[1] << 8));
    if (!gShowAll && vendor != 0x0046) return;

    NSMutableString *payload = [NSMutableString string];
    for (NSUInteger i = 2; i < raw.length; i++) {
        [payload appendFormat:@"%02x", bytes[i]];
    }

    NSString *name = advertisementData[CBAdvertisementDataLocalNameKey] ?: peripheral.name ?: @"-";
    NSArray<CBUUID *> *uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey];
    NSMutableArray<NSString *> *uuidStrings = [NSMutableArray array];
    for (CBUUID *uuid in uuids) [uuidStrings addObject:uuid.UUIDString];
    NSString *services = uuidStrings.count ? [uuidStrings componentsJoinedByString:@","] : @"-";

    NSString *key = [NSString stringWithFormat:@"%@|%u|%@", peripheral.identifier, vendor, payload];
    NSDate *last = gLastSeen[key];
    if (last && -[last timeIntervalSinceNow] < 1.0) return;
    gLastSeen[key] = [NSDate date];

    const char *mark = vendor == 0x0046 ? "★ XGIMI" : " ";
    printf("%s rssi=%4d  vendor=0x%04x  name=%s  services=%s\n", mark, RSSI.intValue, vendor,
           name.UTF8String, services.UTF8String);
    printf("          manufacturer data（不含 2 字节厂商 ID）=%s\n", payload.UTF8String);
    if (vendor == 0x0046) {
        printf("          ↑ 这就是 token（%lu 字节），把这一行发给我\n", payload.length / 2);
    }
    fflush(stdout);
}

@end

int main(void) {
    @autoreleasepool {
        setvbuf(stdout, NULL, _IONBF, 0);
        gShowAll = [[[NSProcessInfo processInfo] arguments] containsObject:@"--all"];
        gLastSeen = [NSMutableDictionary dictionary];
        Sniffer *sniffer = [[Sniffer alloc] init];
        (void)sniffer;
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
