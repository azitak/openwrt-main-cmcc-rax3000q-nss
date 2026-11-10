# 移植审计：PZ-L8 的 NSS 思路 → RAX3000Q on OpenWrt main

这份文档记录每个决定的证据，以及"已经验证过什么、还差什么"。

## 1. 基线的选择

三个候选，最后选第三个：

| 候选 | 内核 | NSS 数据面 | 结论 |
|---|---|---|---|
| `openwrt/openwrt` main | 6.18.60 | **没有**：`qca-nss-dp`/`qca-ssdk` 已在 PR #22381 删除，ipq50xx 走 stmmac + DSA | 只有"能开机 + 双频"，零加速 |
| `openwrt/openwrt` v25.12.5 + mufeng05 的补丁 | 6.12 | `qca-nss-dp` + `qca-ssdk` + `0960`-`0971` | 上一版仓库的做法；与"主线"这个要求冲突，且 main 上整套补丁失效 |
| **`kuncy7/openwrt-nss-edma` `c3po-tag-8021q`** | **6.18.60** | stmmac claim API + `qca-dwmac-nss` + `qca8337-nss`（dts）+ `qca-dsa-nss` | **采用**：它就是"OpenWrt main + NSS"，已经过 15+ 台 IPQ5018 实测 |

该基线的 `README.ipq50xx.md` 记录了这条路的每一个坑（arm 时序、DSA tagger、
wifili 需要 mode 2、256 MB 板型的四个调整），本仓库逐条对照。

CI 默认跟随分支头构建；最近一次完整真机验证的基线是
`fb7e09acfea17c435338d9b631cbd33fc39c3c62`（2026-11-05，OpenWrt main 2026-10-09）。
需要复现某次构建时，用 workflow 的 `base_ref` 指定该次 `build-info.txt` 里的
`base_commit`。NSS 补丁与 6.18.60 内核、mac80211/ath11k 的 backports 绑得很紧，
上游 rebase 后可能需要同步更新补丁（`0001` 的 DTS/image.mk 部分最需要关注）。

## 2. 与 mufeng05 项目的对应关系

| mufeng05（v25.12.5）概念 | 本仓库（main / 6.18）的对应物 |
|---|---|
| `kmod-qca-nss-dp`（`dp1`/`dp2` 虚拟网口） | `kmod-qca-dwmac-nss`（在 stmmac 上实现同一套 nss-dp API） |
| `kmod-qca-ssdk` + `qca-ssdk-shell` + swconfig | `qca8k` DSA + `qca-8021q` tagger；`qca-dsa-nss` 给端口挂固件 VLAN 接口 |
| `target patches 0960/0961/0963/0966`（ECM 内核钩子） | 基线自带（`0960`/`0961`/`0966` 系列已 rebase 到 6.18）；DSA 端口改由 `qca-dsa-nss` 建固件 VLAN 接口 |
| `0968`-`0971`（qdisc / mcs / bridge-mgr） | qdisc 走 `kmod-qca-nss-drv-qdisc` + `sqm-scripts-nss`；`qca-mcs` 不再需要 |
| `ipq5018-nss.dtsi`（自建） | 基线自带同名文件，内容按 6.18 的 stmmac 语义重写 |
| ath11k `990`-`995` 补丁（6.12 的 wifili） | 基线自带的 ath11k NSS 补丁（对应 6.18 backports） |
| `/etc/init.d/nss-offload` + `nss-ecm` | `nss-tools-dwmac` 的 `nss` 服务 + `/usr/sbin/nss-dwmac-up` |
| 根文件系统覆盖层里的 `nss.general.*` 调参 | 同上，`/etc/config/nss`，无需自建 |
| 板级 BDF 包 / board.d / caldata / platform.sh | **本仓库提供**（见 3） |

## 3. 逐文件

### 3.1 `openwrt/0001-cmcc-rax3000q-nss.patch`（3 个文件）

`target/linux/qualcommax/image/ipq50xx.mk`

```make
DEVICE_PACKAGES := ath11k-firmware-ipq5018-qcn6122 \
	ipq-wifi-cmcc_rax3000q \
	-wpad-basic-mbedtls wpad-mbedtls \
	-kmod-usb3 -kmod-usb-dwc3 -kmod-usb-dwc3-qcom \
	-e2fsprogs -kmod-fs-ext4 -losetup
```

上游这个设备条目**没有** `DEVICE_PACKAGES` —— 这是官方镜像里没有射频的直接原因
（没有 `ath11k-firmware-ipq5018-qcn6122`，也没有板级 BDF）。同一文件里
`cmcc_mr3000d-ci`、`yuncore_ax830` 等都有，只有 `cmcc_rax3000q` 漏了。
hostapd 相关的取舍见 5c，USB/ext4 负号见 5e。

`target/linux/qualcommax/dts/ipq5018-rax3000q.dts`

| 改动 | 证据 |
|---|---|
| `#include "ipq5018-nss.dtsi"` | 基线 README："**Every** IPQ5018 board DTS in this branch already carries the line … without it there is no `nss@40000000` node, so `qca-nss-drv` never probes and nothing in this branch works - **quietly**" |
| `nand-ecc-strength` 8 → **4** | 上一版在真机上验证：可启动的 `mxw.ubi` 设备树是 4；Dosilicon/GigaDevice 两颗片的片上 ECC 都是 4 bit/512 B（`NAND_ECCREQ(4, 512)`）；用 8 会让 U-Boot 写入的 UBI 数据 CRC/ECC 报错 |
| `bootargs-append` 加 `ubi.mtd=rootfs` | 同上，可启动镜像带这个参数；原厂 U-Boot 不保证传，带上更稳 |
| `coherent_pool` 2M → **512K** | 基线 `ipq5018-cr8806.dts` 的注释：旧的 MPD 固件加载器已从内核移除（multi-PD 改由 ath11k 处理），分段缓冲不再从 atomic DMA pool 取；2M 实际吃掉 8 MB（三个 2 MiB pool，其中一个会翻倍） |
| `&nss_region` 16 MiB → **8 MiB** | 基线 "256 MB boards"：原厂 MP_256 固件同样只留 8 MiB；驱动把这里的大小当 `heap_ddr_size` 上报，8 MiB 足够满速 |
| `&q6v5_wcss` / `&wifi` / `&wifi1` → `okay` | 上游把三个节点关掉的原因是 "256M RAM is too small for ath11k"，而它按 512 MB 档位编译。本仓库用 `ATH11K_MEM_PROFILE_256M` + `NSS_MEM_PROFILE_LOW`，这条路在 EX511 v2 / Cudy P5 / AX3000T v2 / RG-MA3063 上验证过（RG-MA3063 同样是 IPQ5018 + QCA8337 + QCN6122） |
| `ath11k-fw-memory-mode` 1 → **2** | 补丁 `903`：mode 2 进一步减少固件可创建的 VDEV/peer 数量以省内存（mode 1 = 8 VDEV / 128 peers）；基线 256 MB 板型与 wifili 组合使用 mode 2，官方 main 多数 ipq50xx 机型用 mode 1 |
| `q6_wcss_pd1/pd2` → **`q6v5_wcss` + memory-region** | 基线把 IPQ5018 的 Q6 改成了单 rproc，PD 通过 `boot-args` 选，每个 PD 一个 `no-map` 区；上游那份 DTS 的多 PD 标签已经不存在，`dtc` 会报 `phandle_references: Reference to non-existent node or label "q6_wcss_pd1"`。改成 EX511 v2 / AX3000T v2 那套：新增 `q6_region_qcn6122_1`（0x4d200000, 13 MiB）与 `m3_dump_qcn6122_1`（0x4df00000, 1 MiB），`wifi1` 用 `memory-region`/`memory-region-names`，去掉 `bdf-addr`/`m3-dump-addr` |

**没有改的**：`&gmac1`（sgmii → QCA8337 port0）、`&mdio1` 的四个 PHY 与
`ethernet-switch@11` 的 DSA 端口映射（wan=port1、lan1=port2、lan2=port4、lan3=port5）、
按键/LED/串口引脚、`qcom,smem-part` 分区。这些都来自上游对这块板的支持，是对的。

第三个文件是 `11-ath11k-caldata` 的两条 raw extract 规则（第二轮补上，见 5b）：
`cmcc,rax3000q` 命中后从 `0:art` 提取 2.4G（`0x1000`）与 5G（`0x26800`）的
cal blob，各 128 KiB，不做 MAC/regdomain patch（patch 会触发固件断言）。

### 3.2 `openwrt/tree/target/linux/qualcommax/patches-6.18/0810-…Dosilicon….patch`

- 内容就是上游 Linux 7.0 的 `drivers/mtd/nand/spi/dosilicon.c` + 四处挂钩
  （Makefile / Kconfig 不动的部分由 core.c 的 manufacturer 表承担 / spinand.h 的 extern）。
- 直接取自基线树里已经存在于 `target/linux/mediatek/patches-6.18/010-…` 的同一份补丁：
  **它已经在 6.18 上被 mediatek 目标使用**，所以 op-variant 宏名
  （`SPINAND_PAGE_READ_FROM_CACHE_1S_1S_4S_OP` 等）与 6.18 的 `spinand.h` 一致，
  不需要像上一版那样从 6.12 的宏名手改。
- 放在 **qualcommax** 的 `patches-6.18/` 而不是 `generic/`：generic 会给所有目标加，
  mediatek 自己那份会重复应用（冲突）。
- 编号 0810：排在 generic `487-mtd-spinand-Add-support-for-Etron-…` 之后，后者的
  `Makefile` 行（`… etron.o …`）正是本补丁的上下文。
- 关键参数：厂商 ID `0xE5`；`DS35Q1GA` readid `0x71`、`DS35M1GA` `0x21`；
  1 Gbit / 2048 B 页 / 64 B OOB / 64 页每块 / 1024 块；`NAND_ECCREQ(4, 512)`；
  OOB 布局 4×16 B（前 16 B 段里前 2 B 是 BBM）。

### 3.3 `openwrt/tree/package/ipq-wifi-cmcc_rax3000q/`

- `src/board-cmcc_rax3000q.{ipq5018,qcn6122}`：这块板子的官方 BDF
  （社区 QSDK 发布，与 hzyitc/openwrt-redmi-ax3000 的同名文件一致）。
- `scripts/mkboard2.py` 把它们打成 `board-2.bin.{IPQ5018,QCN6122}`，每个文件里放
  5 组 NAME→DATA：
  `bus=ahb,qmi-chip-id=0,qmi-board-id=36`、`…=96`、`bus=ahb,qmi-chip-id=0,qmi-board-id=255,variant=CMCC-RAX3000Q`、
  `qmi-board-id=255`（无 variant）、`qmi-chip-id=0`（纯 chip-id 兜底）。
  原因：QSDK 用 board-id 36/96 命名，主线 ath11k 一般报 255 并拼上设备树的
  `qcom,calibration-variant`，两条路径都得覆盖。
- 安装路径 `/lib/firmware/ath11k/{IPQ5018,QCN6122}/hw1.0/board-2.bin`，覆盖
  `ath11k-firmware-ipq5018-qcn6122` 的通用 BDF —— 这正是 OpenWrt 官方 `ipq-wifi-*`
  包的做法。

### 3.4 `config/cmcc_rax3000q.config`

- 单设备（`TARGET_qualcommax_ipq50xx_DEVICE_cmcc_rax3000q=y`），不启用
  `MULTI_PROFILE`：多设备镜像会共享**一套**内存档位，而 256 MB 档位对 512 MB 板子是浪费。
- `NSS_MEM_PROFILE_LOW` / `ATH11K_MEM_PROFILE_256M`：feed 里的 LOW 默认名单没有这块板
  （`qca-nss-drv/Config.in` 只列了 Cudy P5、AX3000T v2 等），所以**显式**选。
- `nss-tools-dwmac=y`（不是 `=m`）：它才是真正 arm 固件的服务，`=m` 只会编出包、
  镜像里没有，现象和没选一样。
- `CONFIG_PACKAGE_luci=y` + `luci-i18n-base-zh-cn`：基线自带的镜像不带 LuCI。
- 不选 `CONFIG_PACKAGE_ATH_DEBUG`：基线 common.config 里有，但那是给抓 bug 用的，
  会明显增大 ath11k 的内存占用——256 MB 板子上不划算。

### 3.5 `scripts/setup.sh`

固定五步：校验基线 → 应用 patch → 装 `openwrt/tree/` → feeds → 种 `.config` +
`make defconfig` → **校验**。校验清单：

```
CONFIG_TARGET_qualcommax_ipq50xx_DEVICE_cmcc_rax3000q=y
CONFIG_PACKAGE_kmod-qca-dwmac-nss=y        CONFIG_PACKAGE_kmod-qca-nss-drv=y
CONFIG_PACKAGE_kmod-qca-nss-ecm=y          CONFIG_PACKAGE_kmod-qca8337-nss=y
CONFIG_PACKAGE_nss-tools-dwmac=y           CONFIG_PACKAGE_nss-firmware=y
CONFIG_NSS_FIRMWARE_VERSION_12_5=y         CONFIG_NSS_DRV_WIFIOFFLOAD_ENABLE=y
CONFIG_ATH11K_NSS_SUPPORT=y                CONFIG_ATH11K_MEM_PROFILE_256M=y
CONFIG_NSS_MEM_PROFILE_LOW=y               CONFIG_PACKAGE_ipq-wifi-cmcc_rax3000q=y
                                           CONFIG_PACKAGE_ath11k-firmware-ipq5018-qcn6122=y
```

加上文件存在性、Dosilicon 补丁内容（`DS35Q1GA` / 厂商 ID）、DTS 的
4-bit ECC / `ubi.mtd=rootfs` / NSS include、caldata 两条规则与偏移、
11k/v/r 选项、USTC 源、fullcone 默认开启、nssinfo feed 补丁、LuCI 与中文包，
并显式禁止 `hostapd-mbedtls` / `wpad-basic-mbedtls` / `wpad-mesh-mbedtls` /
`nss-tools` / USB / ext4 包被选回（`wpad-mbedtls` 必选）。
完整清单以 `setup.sh` 为准。

## 4. 本地已经验证的

- `git apply --check` 打过补丁的基线树 → 干净（`scripts/setup.sh` 也据此幂等重跑）。
- 所有 kconfig 符号名在基线树/feed 的 `Config.in`、`Makefile` 里都存在
  （`NSS_DRV_*` 44 个符号逐一核对、`KernelPackage/qca-dwmac-nss` → `kmod-qca-dwmac-nss` 等）。
- Dosilicon 补丁与基线里 mediatek 目标使用的是**同一份**文件，已经在 6.18 上编译过。
- BDF 打包脚本往返解析：5 个名字都能读回，payload 与上游 BDF 字节一致（上一版已验证）。
- 板级事实（交换机映射、ECC 4/512、`ubi.mtd=rootfs`、内存档位）来自上一版在**真机**上
  对照可启动镜像得出的结论，不是推测。

## 5. 首版镜像的真机验证（2026-11-06，build-20261106_185530）

用户刷入后通过 SSH 做了一轮完整只读检查，结果如下。这些不是推测，是设备上
`dmesg` / sysfs / debugfs / procd 日志的实际输出。

| 项 | 结果 |
|---|---|
| Dosilicon DS35Q1GA | ✅ `spi-nand spi0.0: Dosilicon SPI NAND was found. 128 MiB, 2048, OOB 64`，ECC 4/512，16 个 SMEM 分区 |
| UBI / rootfs | ✅ 三卷（kernel 5.6M / rootfs 10.1M / rootfs_data 87.7M），ubiblock0_1 挂载、overlay 74.8M 可用 |
| 有线 | ✅ qca8k DSA，wan/lan1 1 Gbps，WAN DHCP 192.168.2.156，网关/外网/DNS 全通 |
| **NSS 数据面** | ✅ `phys_if 1: started dev=eth0 fw_link=up`；`tx_redirect` 76529→77934、`rx_fw` 45270→46227 随一次真实下载增长；ECM `accelerated_count=44` / tcp 31 / udp 13，`stats_request_counter fail=0`；`qca-dsa-nss` wan/lan1 两个 firmware VLAN 节点、`alloc_failures=0`；NSS 8 MiB 固件 booted |
| LuCI / SSH / apk | ✅ 登录 302→Overview 200，203 个包 |
| **两个射频** | ❌ 没有 `phy`、没有 wlan、`/etc/config/wireless` 0 字节 |

无线失败的根因链（**已闭环，不是 BDF、不是内存**）：

1. 基线 `11-ath11k-caldata` 的 case 表没有 `cmcc,rax3000q`，走到 `*) exit 1`；
2. procd 日志四条 `Could not find firmware .../cal-ahb-*.bin` 和 `caldata.bin`；
3. 6.18 `ath11k_qmi_load_bdf_qmi()` 对 AHB 平台硬性要求 cal 文件，返回
   `-12 (-ENOMEM)` → probe 中止。脚本自己的注释就写着
   "ath11k hard-fails if the cal file is simply absent"；
4. BDF 无嫌疑：`board-2.bin` 里 `chip-id=0,board-id=255,variant=CMCC-RAX3000Q`
   与实测 `board_id 0xff` 匹配，日志没有 `qmi failed to fetch board file`；
5. `0:art` 的 `0x1000` 和 `0x26800` 都是有效数据（非 0xFF），`0x46800` 起全 FF，
   说明确实是两块各 0x20000 的 blob —— 只差提取规则。

顺带查清的三件事：`apk update` 的 `1 unavailable` 是本地 nss feed 被写成官方
URL（`CONFIG_FEED_nss=m` 修）；`nssinfo` 全组 `-22` 是 `qca-nss-netlink.ko`
没有加载（该 kmod 刻意无 AUTOLOAD，由 `files/etc/rc.local` 在开机末段加载），
数据面统计从 debugfs 读一切正常；`nssinfo` 报错期间 NSS 转发并没有受影响。

另有两条**复查后确认不是故障**：`UBI error: cannot attach mtd15` 是
`ubi.mtd=rootfs` 在 cmdline 里出现两次导致的重复 attach（第一次已成功，
第二次 `-EBUSY`，无害）；蓝/红 status LED 常灭是 DTS 设计
（`led-failsafe=blue`、`led-upgrade=blue`、`led-boot=red`、运行中=`green:wan`），
绿灯有 netdev trigger 且链路 up 时亮，属正常。

## 5b. 第二轮改动与待确认

- caldata 两条 raw-extract 规则、`files/` 四个文件、`CONFIG_FEED_nss=m`、
  `check-dts-labels.py` 早期闸门；修复清单见 README 第 2b 节。
- 真机确认（build-20261106_235754，全部通过）：两个射频 probe 出 `phy0`/`phy1`
  且关联成功（5G HE160）、`apk update` 干净、`nssinfo` 不再报 `-22`
  （rc.local 的 netlink 加载行生效）。sysupgrade 保留配置后的自愈脚本
  （`99-rax3000q-firstboot` 从 `/rom` 恢复无线配置）逻辑审查通过、未实地触发。
  5c 追加的 fullcone / USTC 源 / LuCI 包 / 11k/v/r 已随该镜像一并验证。

## 5c. 第三轮：apk 源 / 默认包 / fullcone / 11k/v/r

**真机实测 802.11k/v/r**（`hostapd -t` 逐项加 hostapd 原生键，不是 uci 键——
`ieee80211k` / `ieee80211r` 是 wifi-scripts 的转换键，直接写给 hostapd 会误报
`unknown configuration item`）：

| 键 | 首版 `wpad-basic-mbedtls` | 结论 |
|---|---|---|
| `rrm_neighbor_report` / `rrm_beacon_report` | accepted | 11k 本来就有 |
| `bss_transition` / `wnm_sleep_mode` | **unknown** | 11v 缺失，须换 full wpad |
| `mobility_domain` / `ft_over_ds` / `ft_psk_generate_local` | accepted | 11r 本来就有 |

之前 README 写"basic 不支持 11k/v 和 11r"是错的，已更正。修复为
`DEVICE_PACKAGES += -wpad-basic-mbedtls wpad-mbedtls`（负号语法由
`include/image.mk` 的 `merge_packages` 与 `scripts/target-metadata.pl` 支持，
ath79 多处现成用例），wireless 配置里补齐 11k/11v/11r 选项。
（当时的口径是换全功能 `wpad-mbedtls`；后按 5e 的内存审计收窄为只带
`hostapd-mbedtls`——本板没有 station/roaming 场景，`wpa_supplicant` 二进制
常驻属纯浪费。2026-11-10 为 802.11s mesh 最终改回 full `wpad-mbedtls`：
meshif 需要 wpa_supplicant，只有 full wpad 两样齐，mesh 变体映射同一份
full hostapd .config，11k/v/r + SAE 全保留，代价是 supplicant 常驻约 3 MiB。
决策链 basic → hostapd-mbedtls → wpad-mbedtls，以 3.1 节的包列表为准，
反转细节见 5e 追记。）
wifi-scripts `iface_roaming()` 有 `if (!ieee80211r || wpa < 2) return`，
所以保持开放网络时 11r 惰性、加密码后自动生效（用户选择保持开放）。

**apk 源**：TUNA 帮助页原文「本站不包含 snapshots 镜像」，实测其
`snapshots/*` 全 404，而本固件是 SNAPSHOT。改用 USTC（官方 tier-1，
四个索引实测 200）。坑：`CONFIG_VERSION_REPO` 定义在
`package/base-files/image-config.in` 的 `menuconfig VERSIONOPT` 里，而
`VERSIONOPT` / `IMAGEOPT` 都默认 n，不开这两个 defconfig 会静默丢弃它；
故同时设 `CONFIG_IMAGEOPT=y` `CONFIG_VERSIONOPT=y`，并用
`files/etc/apk/repositories.d/distfeeds.list` 直接覆盖生成文件作双保险。
`keep.d/base-files-essential` 不含 apk 源，sysupgrade 不会把旧源带回来。

**默认包**：`luci` 元包实测只依赖 `luci-light` + `luci-app-package-manager`，
之前注释里"会拉 luci-app-nss / nss-tools 冲突"是错的——那个 feed 里没有
`luci-app-nss`，且 `nss-tools` 在 ipq50xx 上是 `@BROKEN`。已加 `luci`、
`luci-theme-argon`（jerrykuku master，有 ucode 模板、`PKG_RELEASE=20261106`，
作为 `argon` feed）、`luci-app-upnp` + `miniupnpd`、四个 zh_Hans 语言包。
bootstrap 保持默认主题，argon 只作为可选项。

**SONiC fullcone NAT**：`mufeng05/openwrt-sonic-fullcone`（内核 6.18 支持）。
10 个补丁文件 + `0002-sonic-fullcone-libnftnl.patch`（`PKG_FIXUP:=autoreconf`）
+ LuCI feed 补丁与中文翻译。四个内核补丁（984/985/986/987）已在
torvalds/linux v6.18 的对应文件上逐个 `patch` 验证 rc=0；LuCI 的
`zones.js` 补丁也对 luci master `patch --dry-run` 通过。默认开启（见 5d），
与硬件加速共存的真机验证也在 5d。

**本地验证**：`bash -n setup.sh`、两个 git 补丁 `apply --check`、
把 setup.sh 第 5 节抽出来在构造好的树上干跑（补上 defconfig 才会派生的
4 个 kmod 符号后）→ 全部 `ok`、无 MISSING/FORBIDDEN。
**仍待一次真实构建验证**：内核补丁在打过 OpenWrt/NSS 补丁的完整内核树上
能否全部应用、argon feed 拉取、fullcone 用户态编译、LuCI 补丁在完整 feed 上应用。

## 5d. 第四轮：fullcone 默认开启 + nssinfo 修复

镜像 build-20261106_235754（213 包）真机验证全部通过后遗留的两个问题在此修复。

**fullcone 默认开启**。真机上 `defaults.fullcone='1'` 已存在但 wan zone 没开——
排查发现它不是镜像里任何脚本设的（`/rom/etc/uci-defaults/` 无 fullcone 相关），
是早期真机测试手工设置的残留。修复为镜像自带默认：新增
`files/etc/uci-defaults/16-rax3000q-fullcone`，设置 `defaults.fullcone='1'`
并为所有 masq zone 开 `fullcone`。真机实测（先手工设置同值再重启防火墙）：
`nft list ruleset` 出现 dstnat + srcnat 两条 fullcone 规则
（`tcp/udp/dccp/sctp/udplite`），WAN ping 正常、ECM 连接计数正常——
**与 NSS/ECM 共存无异常**。注意 uci-defaults 每次刷机重新执行：
用户手动关闭的 fullcone 会在下次 sysupgrade 后恢复默认开启。

**nssinfo 修复**（`openwrt/feeds/nss-userspace-oss/patches/0040-*.patch`，
由 setup.sh 装进 nss feed 的 `nss-userspace-oss` 包）。真机 PTY 实测发现两件事：
ncurses UI 其实能跑（无 TTY 时 rc=1 只是 curses 起不来），但 ① 每个内核没编的
netlink 族（capwap/c2c/edma/reasm/l2tpv2…）各打三行错误；② 退出必崩——
`nssinfo_deinit()` 先 `nss_nlmcast_sock_close()`（ref_cnt→0、socket 释放），
再跑各子系统 deinit，后者对已关闭的 socket 调 `nss_nlsock_leave_grp()`，
`assert(sock->ref_cnt > 0)` 失败 → SIGABRT。补丁两处：
`nss_nlsock_join_grp/leave_grp` 组解析失败时返回静默 `-ENOENT`
（族未注册=未编译，不是错误），nssinfo 跳过这些族；
`nssinfo_deinit()` 把关 socket 挪到子系统 deinit 之后。
补丁在"已应用 000/002/0031"的源码上 `patch --dry-run` 通过。

**代码梳理**：setup.sh 头部注释与校验闸门同步（新增 nssinfo 补丁、fullcone
默认开启、`uci-defaults/*` 整体 chmod 755）；README / README.en / PORTING /
workflow release-notes 里"fullcone 默认关闭""尚未编译验证"等过期表述全部更新。

## 5e. 内存瘦身：hostapd 化 / 剔 USB+ext4 / 内核裁剪

真机内存审计（256 MB 物理，Linux 可见 172 MB，MemAvailable 仅 31 MB 且无 swap）
找出三处可回收的浪费，一次改掉：

1. **wpad → hostapd**：`wpad-mbedtls` 是 hostapd+wpa_supplicant 合体，本板纯 AP，
   supplicant 常驻却无事可做（约 3 MiB RSS）。换 `hostapd-mbedtls`——它与
   `wpad-mbedtls` 同为 full-mbedtls 变体、共用 `hostapd-full.config`
   （`CONFIG_WNM=y` / `CONFIG_IEEE80211R=y`），特性完全一致，只少一个二进制。
   5c 的 `hostapd -t` 结论沿用。
   **2026-11-10 反转**：为 802.11s mesh 改回 full `wpad-mbedtls`——meshif
   需要 wpa_supplicant，只有 full wpad 两样齐（决策链见 5c）。本条瘦身在
   mesh 需求面前让位；其余两条（剔 USB/ext4、内核裁剪）不受影响。
2. **剔除 USB + ext4 全家**：`qualcommax/Makefile` 的 `DEFAULT_PACKAGES` 给所有
   ipq50xx 机型强塞 `kmod-usb3`/`dwc3`/`kmod-fs-ext4`/`e2fsprogs`/`losetup`，
   本板无 USB 口、rootfs 是 UBIFS。这些 kmod 被 `/etc/modules.d` 自动加载
   （实测 xhci_hcd + ext4 + jbd2 + dwc3 常驻约 1 MiB），纯浪费。
   `DEVICE_PACKAGES` 负号排除 + 种子显式 not set + setup.sh forbid 三重闸门。
   依赖的 xhci/usb-core/usb-roles/jbd2/mbcache 随之消失。
3. **内核 built-in 裁剪**（`0003-kernel-config-trim.patch`，改 generic config）：
   - `CONFIG_JFFS2_FS=y` → off：overlay 是 UBIFS、rootfs 是 squashfs，无人挂 JFFS2；
   - `CONFIG_BPF_SYSCALL` / `CONFIG_BPF_JIT` → off：镜像里没有任何 eBPF 使用者
     （nftables/NSS qdisc 都不用），classic BPF（`CONFIG_BPF`）保留给 socket filter。
   合计约省 0.6-0.8 MiB 内核代码。
   注：USB/ext4 在内核里本来就是 `is not set`（=m 全因 kmod 包拉起），
   剔包后内核侧无需再动。

预期合计：常驻 RAM 省约 4-5 MiB，flash 省约 3 MiB。（manifest 校验的口径
随后有变：2026-11-10 起要求 wpad-mbedtls 在、hostapd-mbedtls / wpad-basic-
mbedtls / kmod-usb3 / kmod-fs-ext4 / e2fsprogs 不在，见 5c 决策链。）
其余内存优化方向（zram、conntrack 调小、NSS/M3 region 压缩）见
当轮讨论记录，未在本轮实施。

## 5f. 审计修复镜像的真机复测与 NSS 参数体检（build-20261107_141736）

8 个文件的审计修复（含 `0001` 补丁头手术）合入 `6ccddcd`，CI 产出
`build-20261107_141736`（`build-info.txt` 实证 `project_commit=6ccddcd`、
`base_commit=fb7e09a`）。刷入后做了一轮只读复测，并对 NSS 参数做体检：

| 项 | 实测 |
|---|---|
| NSS 拓扑 | `nss.general.topology='dsa'` 生效：conduit tag 走 `qca-8021q`，`qca-dsa-nss` 为 wan（if_num 29）/ lan1（31）建固件 VLAN 节点，`alloc_failures=0` |
| NSS 转发 | `nssinfo ipv4`（快照）：core0 `eth_rx` RX≈TX≈1.01 亿包、`ipv4` RX≈TX≈1.01 亿包，**Drops 全 0**；回 CPU 的 exceptions 占比约 0.26%（复查时 `ipv4_rx_pkts` 已涨到 1.03 亿，只增不减） |
| ECM | `accelerated_count=71`（tcp 62 / udp 9，快照），`stats_request success=96000 fail=0`，pending 0/0 |
| ath11k 实参 | `/sys/module/ath11k/parameters/nss_offload=1`、`frame_mode=2`（wifili 以太帧模式生效） |
| fullcone | `defaults.fullcone='1'` + wan zone `fullcone='1'` → `dstnat_wan` / `srcnat_wan` 各一条 fullcone 规则，与 NSS/ECM 共存 |
| 连通 | WAN DHCP 192.168.2.165；网关 ping ~1.3 ms、公网 ping 46 ms 0% 丢包 |
| 内存/温度 | MemAvailable ~40 MiB（zram swap 仅用 2.2 MiB），四温区 59–60 °C，load ~0.17 |
| 参数基线 | `max_ipv4/6_conn=512`（默认池，超限回落 CPU 慢路径）、8 MiB NSS DDR（LOW profile）、retail 12.5 固件、`fw_csum` off —— 256 MB 板现阶段不建议动 |

顺带定音的三条无害噪音：procd 找不到 `firmware-2.bin`（ath11k 实际用
`q6_fw.mbn`，固件 WLAN.HK.2.7.0.1 加载成功）、`modprobe ath11k_pci` 失败
（本板 AHB 无 PCI 形态）、nssinfo `Unknown message type 1`（诊断工具 12.5
走在 drv 14.0 的广播消息之前，版本兼容噪音；其 ncurses UI 需要 tty，
`ssh -t` 进去即可看）。文档同步：wireless / config 注释按本次实测更新
（hostapd 是单一全局进程 `hostapd -s -g` 管理 BSS，11k 邻居表按 radio 独立；
HE80 相对 HE160 是峰速减半，不是少 1/3）。

## 5g. 首页状态卡片：无状态重写 + Web 文件缓存键（2026-11-10）

LuCI 首页 14 张卡片里，自制三张（`15_cpu` / `16_net` / `17_nss`）曾把差分
基线存在模块变量里跨轮询复用——这是「页面刷新、卡片解除隐藏、SPA 跳页返回、
后台标签切回后，首帧显示陈旧的长窗平均值或闪 0」的根因。官方 include
（10_system / 20_memory / 60_wifi 等 9 张）与固件自带的 18_thermal / 19_zram
全部无状态：`index.js` 每个轮询周期重新调 `load()`，`render()` 是 `load()`
数据的纯函数。

按同一契约重写三张卡（squash 提交 `92c0276`）：

- 测量窗封闭在单次 `load()` 内，模块零状态：CPU 两次采样 `/proc/stat`
  （1.2 s 窗——tickless idle 短窗可能没有 tick 增量，整窗零增量改判 0%，
  这是无状态下的正确语义而非坏轮）；网速 1 s 窗差分 ubus
  `network.device status`（与官方「端口状态」卡同款调用）；NSS 吞吐 1 s 窗
  读两次 `/sys/kernel/debug/qca-nss-drv/stats/ipv4` 差分。任何首帧都是
  当次实测。
- 缺数据占位符 `—` 改 `?`（官方 10_system / 20_memory 惯例）；速率单位用
  NBSP（60_wifi 惯例）。
- 真机验证：三文件部署 md5 双端一致；页内直调 `load()` 返回当次实测；
  合成数据驱动 `render()` 全分支（满数据 / 缺数据 / 读不到返回 null）通过。
- 期间一并查明的非代码问题：「网速卡内容消失」实为浏览器 localStorage 里
  该卡被用户隐藏（状态页「显示」菜单勾选即自愈）。

**运维注记（缓存键）**：`/www` 下模块的 URL 带 `?v=<resource_version>`，
取自设备 `/usr/share/ucode/luci/version.uc` 的 `revision`（纯文本，可直接
sed）。每次改动设备上的 Web 文件都要掀一版（当前 `.r4`），否则老浏览器会
命中缓存的旧模块；该文件不在仓库跟踪范围内，属设备侧开关。随镜像刷入的
`files/www` 文件不受此影响（镜像版本本身即为缓存键变更）。

## 6. 已知风险

- **wifili 已在本板验证**（5G HE160 站点关联 1921.5 Mbit/s、4300 万包 TX 走
  NSS，`nss_offload=1` / `frame_mode=2` 实值确认，见 5f）：单 rproc + PD 2 的
  写法连同这块板自己的 `boot-args`（PD 2、reset GPIO 27）和 BDF 都已真机跑通。
  余量相关的提醒：256 MB 内存档位下 VDEV/peer 数量受 mode 2 限制；若 wifili
  起不来，射频留在主机栈，路由不受影响。
- **256 MB 的内存余量本来就紧**：802.11s mesh、多 SSID、USB 存储都会吃内存；
  基线明确说 256m 组不编 mesh offload。
- **fullcone NAT 与 NSS/ECM 组合**：基本共存已实测正常（规则、连通性、ECM 计数），
  但 ECM 把已建立连接交给固件转发，后续 conntrack 处理（含 fullcone 的 3 元组映射）
  可能被绕过；长时间大流量下的 EIM/EIF 行为没有专项测试，介意可
  `uci set firewall.@defaults[0].fullcone='0'` 关闭。
- **镜像里的 kmod 不能从官方 feed 装**（vermagic 不同）。要什么就加进种子重编。
- 首次刷入需要 U-Boot TFTP；原厂 `bootipq` 的 A/B 槽未改动，另一槽仍可回退。
