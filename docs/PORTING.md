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
wifili 需要 mode 2、256 MB 板型的四个调整），本仓库逐条对照。固定 commit：

```
fb7e09acfea17c435338d9b631cbd33fc39c3c62   2026-11-05
base：OpenWrt main 2026-10-09（JuliusBairaktaris nss-edma-rework 的 vendor-nss-archive）
```

**为什么必须钉 commit**：NSS 补丁与 6.18.60 内核、mac80211/ath11k 的 backports 版本
绑得很紧；跟着分支头跑，某天上游 rebase 一次，补丁就可能全废。

## 2. 与 mufeng05 项目的对应关系

| mufeng05（v25.12.5）概念 | 本仓库（main / 6.18）的对应物 |
|---|---|
| `kmod-qca-nss-dp`（`dp1`/`dp2` 虚拟网口） | `kmod-qca-dwmac-nss`（在 stmmac 上实现同一套 nss-dp API） |
| `kmod-qca-ssdk` + `qca-ssdk-shell` + swconfig | `qca8k` DSA + `qca-8021q` tagger；`qca-dsa-nss` 给端口挂固件 VLAN 接口 |
| `target patches 0960/0961/0963/0966`（ECM 内核钩子） | 基线自带（`0960`/`0961`/`0966` 系列已 rebase 到 6.18）；DSA 端口用 `0051`-`0057` |
| `0968`-`0971`（qdisc / mcs / bridge-mgr） | qdisc 走 `kmod-qca-nss-drv-qdisc` + `sqm-scripts-nss`；`qca-mcs` 不再需要 |
| `ipq5018-nss.dtsi`（自建） | 基线自带同名文件，内容按 6.18 的 stmmac 语义重写 |
| ath11k `990`-`995` 补丁（6.12 的 wifili） | 基线自带的 ath11k NSS 补丁（对应 6.18 backports） |
| `/etc/init.d/nss-offload` + `nss-ecm` | `nss-tools-dwmac` 的 `nss` 服务 + `/usr/sbin/nss-dwmac-up` |
| 根文件系统覆盖层里的 `nss.general.*` 调参 | 同上，`/etc/config/nss`，无需自建 |
| 板级 BDF 包 / board.d / caldata / platform.sh | **本仓库提供**（见 3） |

## 3. 逐文件

### 3.1 `openwrt/0001-cmcc-rax3000q-nss.patch`（2 个文件）

`target/linux/qualcommax/image/ipq50xx.mk`

```make
DEVICE_PACKAGES := ath11k-firmware-ipq5018-qcn6122 ipq-wifi-cmcc_rax3000q
```

上游这个设备条目**没有** `DEVICE_PACKAGES` —— 这是官方镜像里没有射频的直接原因
（没有 `ath11k-firmware-ipq5018-qcn6122`，也没有板级 BDF）。同一文件里
`cmcc_mr3000d-ci`、`yuncore_ax830` 等都有，只有 `cmcc_rax3000q` 漏了。

`target/linux/qualcommax/dts/ipq5018-rax3000q.dts`

| 改动 | 证据 |
|---|---|
| `#include "ipq5018-nss.dtsi"` | 基线 README："**Every** IPQ5018 board DTS in this branch already carries the line … without it there is no `nss@40000000` node, so `qca-nss-drv` never probes and nothing in this branch works - **quietly**" |
| `nand-ecc-strength` 8 → **4** | 上一版在真机上验证：可启动的 `mxw.ubi` 设备树是 4；Dosilicon/GigaDevice 两颗片的片上 ECC 都是 4 bit/512 B（`NAND_ECCREQ(4, 512)`）；用 8 会让 U-Boot 写入的 UBI 数据 CRC/ECC 报错 |
| `bootargs-append` 加 `ubi.mtd=rootfs` | 同上，可启动镜像带这个参数；原厂 U-Boot 不保证传，带上更稳 |
| `coherent_pool` 2M → **512K** | 基线 "256 MB boards" 一节：只有在 patch `0828`（MDT 分段用 `GFP_KERNEL` 分配）之后才安全；2M 实际吃掉 8 MB（三个 2 MiB pool，其中一个会翻倍） |
| `&nss_region` 16 MiB → **8 MiB** | 基线 "256 MB boards"：原厂 MP_256 固件同样只留 8 MiB；驱动把这里的大小当 `heap_ddr_size` 上报，8 MiB 足够满速 |
| `&q6v5_wcss` / `&wifi` / `&wifi1` → `okay` | 上游把三个节点关掉的原因是 "256M RAM is too small for ath11k"，而它按 512 MB 档位编译。本仓库用 `ATH11K_MEM_PROFILE_256M` + `NSS_MEM_PROFILE_LOW`，这条路在 EX511 v2 / Cudy P5 / AX3000T v2 / RG-MA3063 上验证过（RG-MA3063 同样是 IPQ5018 + QCA8337 + QCN6122） |
| `ath11k-fw-memory-mode` 1 → **2** | 基线：wifili 在 QCN6122 上需要 mode 2；256 MB 板型两个射频都用 2 |
| 保留 `bdf-addr` / `m3-dump-addr` | 上游这块板的 Q6 内存布局；与 `qcn6122.dtsi` 里 `q6_region_ipq5018`（0x4c400000）对齐 |

**没有改的**：`&gmac1`（sgmii → QCA8337 port0）、`&mdio1` 的四个 PHY 与
`ethernet-switch@11` 的 DSA 端口映射（wan=port1、lan1=port2、lan2=port4、lan3=port5）、
按键/LED/串口引脚、`qcom,smem-part` 分区。这些都来自上游对这块板的支持，是对的。

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

加上文件存在性、Dosilicon 补丁含 `DS35Q1GA`、DTS 含 `nand-ecc-strength = <4>` /
`ubi.mtd=rootfs` / `ipq5018-nss.dtsi`。

## 4. 本地已经验证的

- `git apply --check` 打过补丁的基线树 → 干净（`scripts/setup.sh` 也据此幂等重跑）。
- 所有 kconfig 符号名在基线树/feed 的 `Config.in`、`Makefile` 里都存在
  （`NSS_DRV_*` 44 个符号逐一核对、`KernelPackage/qca-dwmac-nss` → `kmod-qca-dwmac-nss` 等）。
- Dosilicon 补丁与基线里 mediatek 目标使用的是**同一份**文件，已经在 6.18 上编译过。
- BDF 打包脚本往返解析：5 个名字都能读回，payload 与上游 BDF 字节一致（上一版已验证）。
- 板级事实（交换机映射、ECC 4/512、`ubi.mtd=rootfs`、内存档位）来自上一版在**真机**上
  对照可启动镜像得出的结论，不是推测。

## 5. 还需要真机确认（按顺序）

1. `dmesg | grep -i spi-nand` → `Dosilicon SPI NAND was found. 128 MiB, 2048, OOB 64`，
   并且 `/proc/mtd` 有 16 个 SMEM 分区。
2. UBI attach、`/dev/ubiblock0_1` 出现、rootfs 挂载（这一步就是上一版失败的根因）。
3. `ls /etc/rc.d | grep S19nss`、`cat /sys/kernel/debug/qca-dwmac-nss/status` →
   `phys_if 1: started dev=eth0`。
4. 两个射频 probe（`iw dev` 看到 `phy0-ap0` / `phy1-ap0`），2.4G 与 5G 都能关联。
5. WAN DHCP 通、LAN 通、`tcp_accelerated_count` 在跑流量时增长、`top` 里 idle > 90%。
6. `logread -e nss` 是否出现 "Wi-Fi on the NSS path" —— **本板最不确定的一条**
   （多 PD 写法 vs 已验证板型的单 rproc 写法）。
7. `sysupgrade -n` 从已运行的 OpenWrt 升级一次，确认 UBI 卷与分区布局没变。

## 6. 已知风险

- **wifili 未在本板验证**：`q6_wcss_pd2` + `bdf-addr` 是主线这块板的写法，
  基线的 wifi offload 只在单 rproc 写法的板子上验证过。失败表现为射频留在主机栈，
  路由不受影响。
- **256 MB 的内存余量本来就紧**：802.11s mesh、多 SSID、USB 存储都会吃内存；
  基线明确说 256m 组不编 mesh offload。
- **镜像里的 kmod 不能从官方 feed 装**（vermagic 不同）。要什么就加进种子重编。
- 首次刷入需要 U-Boot TFTP；原厂 `bootipq` 的 A/B 槽未改动，另一槽仍可回退。
