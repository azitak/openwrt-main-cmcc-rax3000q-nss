# CMCC RAX3000Q — OpenWrt main + 高通 NSS 硬件卸载

[English](README.en.md) | 中文

在 **OpenWrt main（主线，内核 6.18.60）** 上，为 **CMCC RAX3000Q / RAX3000-QY**
（IPQ5018 + QCA8337 + QCN6102，256 MB 内存，128 MB SPI-NAND）补齐三件事：

1. **Dosilicon DS35Q1GA / DS35M1GA SPI-NAND 支持** —— 主线 6.18 没有这个厂商的驱动
   （Linux 7.0 才加入），而这块板子大量出货用的是这颗闪存。缺了它 `spi-nand` probe
   失败、MTD 分区不存在、UBI 挂不上、rootfs 无法挂载，**刷完就是一块砖**。
2. **两块射频能起来** —— 主线虽然已经支持这块板（`Device/cmcc_rax3000q`），但它的
   `DEVICE_PACKAGES` 是空的，镜像里既没有 ath11k 固件也没有板级 BDF，而且设备树里
   两个 wifi 节点是 `disabled`（上游按 512 MB 的默认值考虑，256 MB 装不下）。
3. **有线转发进 NSS 核**（Wi-Fi offload 也编进镜像并在真机验证通过）—— 参照
   [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss)
   在 PZ-L8（同 SoC、同交换机）上跑通的 NSS 方案，在 main 上落成当前唯一可行的那条路：
   **保留上游 stmmac 驱动，用一小块 glue 模块把 GMAC 的数据面交给 NSS 固件**。

> **状态：镜像已在真机完整验证**——Dosilicon、UBI、DSA/WAN、NSS 硬件加速（ECM 计数随
> 真实流量增长）、双射频（5G HE160 关联成功）、11k/v/r、LuCI/Argon、USTC apk 源全部通过。
> 最新一轮改动：fullcone NAT 改为**默认开启**（已在真机确认与 NSS/ECM 共存正常）、
> nssinfo 修复（不再对内核没编的 netlink 族报错，退出不再 SIGABRT）。
> 与上一代（v25.12.5 基线）确认过的事实对齐：闪存是 Dosilicon、ECC 必须 4/512、
> bootargs 需要 `ubi.mtd=rootfs`。刷机前**务必备份全部分区**，尤其是 `0:art`。

---

## 为什么不是"把 PZ-L8 那套 NSS 补丁直接搬过来"

2026-07-11，OpenWrt main 合入 PR #22381（`qualcommax: ipq50xx: convert to UNIPHY PCS
and DWMAC stack` / `kernel: drop qca-nss-dp and qca-ssdk`）：

- **ipq50xx 从 QSDK 的 `qca-nss-dp` + `qca-ssdk` 换成了上游 `stmmac`（`dwmac-ipq5018`）
  + UNIPHY PCS**，QCA8337 由 `qca8k` 以 DSA 方式接管；
- `qca-nss-dp`、`qca-ssdk` 两个包**从源码树里删除**。

而 [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss)
（以及本作者上一版
[openwrt-cmcc-rax3000q-nss](https://github.com/azitak/openwrt-cmcc-rax3000q-nss)）建立在
`v25.12.5`（内核 6.12）上，整套数据面依赖 `qca-nss-dp`：`dp1`/`dp2` 虚拟网口、
`qca-ssdk` 的 switch 驱动、`0960`–`0971` 一串针对 6.12 调好的内核补丁、
159 KB 的 ath11k wifili 补丁。**换基线到 main 会让这一整套全部失效**，
不是改几个设备树属性的问题。

所以本仓库采用 main 上已经跑通的那条路，并按 PZ-L8 项目的**思路与板级数据**把它接到
RAX3000Q：

```
kernel 6.18 stmmac (dwmac-ipq5018)          ← 保留上游驱动，phylink/MDIO/netdev 都还在内核
        │  stmmac 数据面 claim API（patch 0956）
        ▼
kmod-qca-dwmac-nss                          ← glue：TX 排空、NAPI 关、DMA 停、ndo_start_xmit 改道
        │  实现 qca-nss-drv 期待的 nss-dp 接口
        ▼
qca-nss-drv + NSS 固件（12.5-210）          ← UBI32 核接管转发
        ▼
qca-nss-ecm                                 ← 连接跟踪 → 加速规则（`qca-dsa-nss` 为 DSA 端口建固件 VLAN 节点）
```

数据面之上，交换机的接线方式不变：QCA8337 仍然由 `qca8k` 以 DSA 驱动，NSS 服务在 netifd
起来之前把 conduit 的 tag 协议换成 `qca-8021q`（普通 802.1Q），固件才解析得了；
`qca-dsa-nss` 再给每个 DSA 端口/VLAN 一个固件 VLAN 接口，ECM 才能为它们下发规则。
**`lan1`-`lan3` / `wan` 这些接口名和 stock 镜像一致**，不改成 `eth0.1`/`eth0.2`。

这条路上的工作来自 [Julius Bairaktaris](https://github.com/JuliusBairaktaris) 的
NSS-on-mainline 系列与 [kuncy7](https://github.com/kuncy7/openwrt-nss-edma) 的 ipq50xx
实现（GL-B3000 等 15+ 台 IPQ5018 实测）。本仓库的基线就是它：

| 部分 | 取自 | 说明 |
|---|---|---|
| OpenWrt 树 | `kuncy7/openwrt-nss-edma` 分支 `c3po-tag-8021q`，commit `fb7e09a` | OpenWrt main 2026-10-09 + NSS 系列，内核 6.18.60 |
| NSS 包 | 该树的 feeds：`kuncy7/nss-packages` 分支 `ipq50xx-rebase` | `qca-nss-drv` / `ecm` / `clients` / `nss-firmware` / `sqm-scripts-nss` |
| 板级数据 | 上游 mainline DTS + 社区 QSDK DTS + 官方 BDF | 见下 |

---

## 硬件

| 部件 | 型号 / 说明 |
|---|---|
| SoC | Qualcomm IPQ5018（2× Cortex-A53 @ 1 GHz，集成 256 MB DDR、1 GHz NPU、2.4G Wi-Fi 6） |
| 5 GHz | QCN6102，2×2 / 160 MHz；ath11k 侧按 `QCN6122/hw1.0` 走固件 |
| 交换 | QCA8337-AL3C（MDIO 0x11），DSA（`qca8k`）驱动 |
| Flash | GigaDevice GD5F1GQ5REYIG **或 Dosilicon DS35Q1GA-IB / DS35M1GA**，128 MB SPI-NAND |
| 端口 | 1 WAN + 3 LAN：QCA8337 物理口 1=WAN(PHY0)、2=LAN1(PHY1)、4=LAN2(PHY3)、5=LAN3(PHY4) |
| 内存 | 256 MB（这就是必须用 256M 内存档位的原因） |
| 按键 / LED | reset GPIO23、wps GPIO38；红 GPIO24、绿 GPIO19(WAN)、蓝 GPIO17 |
| 串口 | 3-pin，115200n8 |

CPU 链路：**QCA8337 port0 --SGMII--> gmac1（`eth0`）**。gmac0（内部 GE PHY）在主线这块板
的设备树里没有接出，保持关闭；因此 NSS 只需要接管 `phys_if 1`（`fw_mask=0x2`）。

---

## 本仓库改了什么

下面六类，全部可审：

### 1. `openwrt/0001-*.patch` / `0002-*.patch` / `0003-*.patch`（改基线已有的文件）

0001 改 `ipq50xx.mk`、板级 DTS 和 `11-ath11k-caldata` 三个文件；0002 给
`package/libs/libnftnl/Makefile` 加 `PKG_FIXUP:=autoreconf`（fullcone 补丁需要）；
0003 裁掉内核里用不到的 built-in（JFFS2、BPF syscall/JIT，省约 0.6-0.8 MiB）。

- `target/linux/qualcommax/image/ipq50xx.mk`
  `Device/cmcc_rax3000q` 补上 `DEVICE_PACKAGES := ath11k-firmware-ipq5018-qcn6122
  ipq-wifi-cmcc_rax3000q -wpad-basic-mbedtls -wpad-mbedtls hostapd-mbedtls
  -kmod-usb3 -kmod-usb-dwc3 -kmod-usb-dwc3-qcom -e2fsprogs -kmod-fs-ext4 -losetup`。
  **上游这里为空，所以官方镜像没有射频。**
- `target/linux/qualcommax/dts/ipq5018-rax3000q.dts`
  - `#include "ipq5018-nss.dtsi"` —— 没有这个节点 `qca-nss-drv` 根本不 probe，
    而且**静默**：整条加速链路不工作，系统照常能上网；
  - `nand-ecc-strength = <8>` → **`<4>`**：两颗闪存的片上 ECC 都是 4 bit/512 B，
    用 8 会让 U-Boot 写进 `rootfs` 的数据变成 ECC 错误；
  - `bootargs-append` 增加 `ubi.mtd=rootfs`，把 `coherent_pool` 从 2M 降到 **512K**
    （基线 256 MB 板型的通行做法：旧的 MPD 固件加载器已从内核移除，multi-PD 改由
    ath11k 处理，不再需要从 atomic DMA pool 取分段缓冲，见 `ipq5018-cr8806.dts` 注释）；
  - `&nss_region` 从 16 MiB 改成 **8 MiB**（原厂 MP_256 固件同样是 8 MiB，
    省回 8 MB `MemTotal`）；
  - `&q6v5_wcss` / `&wifi` / `&wifi1` 全部 `okay`，`ath11k-fw-memory-mode = <2>`
    （256 MB 板型进一步缩减固件内存占用的档位，VDEV/peer 数更少）；两个射频改成基线的
    **单 rproc + 固定内存区**写法
    （上游那份 DTS 用的 `q6_wcss_pd1`/`q6_wcss_pd2` 标签在这棵树里已经不存在，
    直接用会让 `dtc` 报 `phandle_references` 错误，构建在最后一步失败）。

### 2. `openwrt/tree/`（基线没有的文件）

- `target/linux/qualcommax/patches-6.18/0810-mtd-spinand-add-support-for-Dosilicon-DS35Q1GA-DS35M1GA.patch`
  —— 上游 Linux 7.0 驱动（Ahmed Naseef / Miquel Raynal）在 6.18 上的回移：
  `drivers/mtd/nand/spi/dosilicon.c` + Makefile/Kconfig/core.c/spinand.h 四处挂钩。
  厂商 ID `0xE5`，`readid` 0x71（DS35Q1GA）/ 0x21（DS35M1GA），
  1 Gbit、2048 B 页 + 64 B OOB、64 页/块、1024 块、`NAND_ECCREQ(4, 512)`。
- `package/ipq-wifi-cmcc_rax3000q/` —— 这块板子的官方 BDF（`src/`），由
  `scripts/mkboard2.py` 打包成 `board-2.bin.{IPQ5018,QCN6122}`，每个文件里放了 5 组
  NAME→DATA（QSDK 的 36/96、主线的 255+variant、无 variant 兜底、纯 chip-id 兜底），
  安装时覆盖 `ath11k-firmware-ipq5018-qcn6122` 的通用 BDF。

### 2b. `openwrt/0001-*.patch` 里的 caldata 规则 + `files/`（rootfs overlay）

BDF 只解决"板级射频参数"，**校准数据（caldata）是另一份文件**，ath11k 6.18 在
AHB 平台上硬性要求它：`11-ath11k-caldata` 按 `$FIRMWARE` 从 `0:art` 提取出
`cal-ahb-c000000.wifi.bin`（2.4G，偏移 `0x1000`）和
`cal-ahb-b00a040.wifi.bin`（5G，偏移 `0x26800`），各 128 KiB。基线脚本没有
`cmcc,rax3000q` 分支，两个文件都生成不出来，驱动报
`failed to load board data file: -12` 后放弃 probe —— 表现为没有 `phy`、没有
wlan 接口、`/etc/config/wireless` 是 0 字节。补丁给这块板加了两条 **raw extract**
规则：不做 `ath11k_patch_mac` / `ath11k_remove_regdomain`，因为这块板的 cal blob
开头就是它自己的 RF 表，改 0x0e–0x13 会让固件在 `phyrf_reset.c` 断言、
WMI 永远不 ready（上一版 25.12 在真机上踩过）。

`files/` 里的五个文件随镜像进入 rootfs：

| 文件 | 作用 |
|---|---|
| `etc/config/wireless` | 两个射频开机即启用，SSID `RAX3000Q-2G/-5G`，开放网络，country CN，2.4G HE40 / 5G HE160；带完整的 11k / 11v / 11r 选项（11r 需加密，见下文） |
| `etc/apk/repositories.d/distfeeds.list` | 覆盖构建时生成的源列表，指向中科大 USTC 镜像 |
| `etc/uci-defaults/99-rax3000q-firstboot` | 从首版镜像**保留配置** sysupgrade 时，`/etc/config/wireless`（0 字节）和 `/etc/rc.local` 都在 `keep.d/base-files-essential` 里，会被旧版盖住新文件；脚本从 `/rom` 恢复无线配置、按运行时 sysfs 校正 radio path，并补回 rc.local 里的 netlink 加载行 |
| `etc/rc.local` | 开机末段 `modprobe qca-nss-netlink`。这个 kmod 故意没有 `AUTOLOAD`（放 `/etc/modules.d` 会让 kmodloader 在 NSS 服务 arm 端口之前把 `qca-nss-drv` 拉起来）；不加载它 `nssinfo` 的每个 netlink mcast group 都报 `-22`，而数据面转发本身完全正常 |
| `etc/uci-defaults/16-rax3000q-fullcone` | 打开 fullcone 总开关和所有 masq zone 的 fullcone（见 2c）；uci-defaults 每次刷机后重新执行，关掉的用户会在下次升级时恢复默认 |

### 2c. SONiC fullcone NAT（`openwrt/tree/` 的内核与用户态补丁）

来自 `mufeng05/openwrt-sonic-fullcone`（SONiC / Broadcom 的 conntrack
`nat_by_manip_src` 3 元组哈希方案），不是 `xt_FULLCONENAT` 那种独立内核模块：
功能直接编译进 `nf_nat` / `nft_masq` / `xt_MASQUERADE`，per-rule 开关，
非 fullcone 流量零开销。支持内核 6.6 / 6.12 / **6.18**，四个内核补丁
（984/985/986/987）已在 Linux 6.18 源码上逐个 `patch` 验证过能干净应用。
整套补丁清单：

| 位置 | 内容 |
|---|---|
| `target/linux/generic/hack-6.18/984..987-*` | 内核：conntrack 3 元组哈希、iptables / nftables 的 fullcone 表达式、竞态与丢包修复 |
| `package/libs/libnftnl`, `package/network/utils/nftables`, `.../iptables` | 用户态 `fullcone` 表达式/关键字；`0002-*.patch` 给 libnftnl 加 `PKG_FIXUP:=autoreconf` |
| `package/network/config/firewall4/patches` | fw4 生成 `fullcone` 规则、读 `defaults.fullcone` 总开关与 zone 级开关 |
| `openwrt/feeds/luci-app-firewall/` | LuCI 原生防火墙页面的 Fullcone 复选框 + 中文翻译，由 `setup.sh` 在 `feeds install` 之后装进 luci feed |

**默认开启**：`files/etc/uci-defaults/16-rax3000q-fullcone` 在每次刷机后设置
`firewall.@defaults[0].fullcone='1'` 并给所有 masq zone 开 `fullcone`。已在真机
确认与 NSS/ECM 共存正常（规则生成、WAN 连通、ECM 连接计数都正常）。关闭：

```sh
uci set firewall.@defaults[0].fullcone='0'
uci set firewall.@zone[1].fullcone='0'
uci commit firewall && /etc/init.d/firewall restart
nft list ruleset | grep fullcone     # 应为空
```

⚠️ NSS/ECM 会把已建立连接交给固件转发，绕过后续 conntrack 处理；fullcone 的
EIM/EIF 深度行为（长时间大流量下的端口映射稳定性）未做专项测试，介意可按上面关闭。

### 2d. nssinfo feed 补丁（`openwrt/feeds/nss-userspace-oss/`）

`nss-userspace-oss` 源码里 nssinfo 的问题（`0040-*.patch` 修复，由 `setup.sh`
在 `feeds install` 之后装进 nss feed）：

1. **报错噪音**：nssinfo 无条件订阅所有 NSS netlink 族的 mcast 组，而本内核
   只编了一部分（capwap / c2c / edma / reasm / l2tpv2 等都没有），每个缺失的族
   都要打三行错误。补丁把"组不存在"从 `-EINVAL` 报错改为静默 `-ENOENT`，
   nssinfo 直接跳过这些族。
2. **退出即崩溃**：`nssinfo_deinit()` 先关 socket 再跑各子系统 deinit，后者对已
   关闭的 socket 调 `nss_nlsock_leave_grp()`，触发 `ref_cnt` 断言 → 每次退出
   SIGABRT。补丁把关 socket 挪到 deinit 之后。

### 3. `config/cmcc_rax3000q.config`（kconfig 种子）

`Device/cmcc_rax3000q` 单设备 + 256M 档位（`ATH11K_MEM_PROFILE_256M=y`、
`NSS_MEM_PROFILE_LOW=y`）+ `nss-tools-dwmac` + Wi-Fi offload + 12.5 固件 +
SQM（装进镜像但默认关闭）。默认包还包含：

- **LuCI**：`luci` 元包、`luci-theme-argon`（第三方，由 `setup.sh` 以本地
  `src-link` feed 提供；bootstrap 仍是默认主题，主题坏了也不会拖垮 Web UI）、`luci-app-upnp` +
  `miniupnpd`、以及 base/firewall/package-manager/upnp 四个简体中文语言包。
- **完整 hostapd**：`hostapd-mbedtls`（full 变体，含 WNM = 802.11v），并在
  `DEVICE_PACKAGES` 里排除 `wpad-basic-mbedtls` / `wpad-mbedtls`——本板只有
  AP 场景，supplicant 那一半纯属闲置（省约 3 MiB 内存）。
- **剔除 USB / ext4**：qualcommax 的 `DEFAULT_PACKAGES` 会给所有 ipq50xx 机型
  强塞 `kmod-usb3`/`dwc3`/`kmod-fs-ext4`/`e2fsprogs`/`losetup`；本板没有 USB 口、
  rootfs 是 UBIFS，这些纯属浪费（还会被 `/etc/modules.d` 自动加载吃内存），
  已在 `DEVICE_PACKAGES` 里负号排除。
- **`zram-swap`**：压缩交换分区，默认容量为内存一半（约 124 MiB）。
- **apk 镜像源**：`CONFIG_VERSION_REPO` 指向中科大 USTC 的 snapshots。
  清华 TUNA 官方说明「本站不包含 snapshots 镜像」，而本固件是 SNAPSHOT，
  用清华会让 `apk update` 全部 404；USTC 是 OpenWrt 官方 tier-1 镜像，
  四个索引都实测 200。`CONFIG_IMAGEOPT=y` + `CONFIG_VERSIONOPT=y` 是必需的：
  `VERSION_REPO` 藏在这两个 menuconfig 下面，不开它们 defconfig 会静默丢弃。
  `files/etc/apk/repositories.d/distfeeds.list` 是第二重保障（直接覆盖生成文件）。
- `CONFIG_FEED_nss=m` / `CONFIG_FEED_argon=m`：两个本地 feed 官方镜像站没有
  index，tristate `m` 只把它们的 repository 行注释掉，包照常编译进镜像。

### 4. `scripts/setup.sh` + `.github/workflows/build.yml`

`setup.sh` 把上面几类装进一棵干净的基线树，并在**编译前**校验：Dosilicon 补丁、
4-bit ECC、`ubi.mtd=rootfs`、NSS 节点、caldata 规则、fullcone 补丁与中文翻译、
fullcone 默认开启、nssinfo feed 补丁、USTC 源、11k/v/r 选项，以及全部关键
kconfig 符号（并显式禁止 `wpad-*` / `nss-tools` / USB / ext4 包被选回）。
任何一条不满足，几秒内失败，而不是等 90 分钟编译出一个开不了机的镜像。

---

## 自己编译

```sh
# 1) 基线：OpenWrt main + NSS（约 1.5 GB）
git clone -b c3po-tag-8021q https://github.com/kuncy7/openwrt-nss-edma.git openwrt
cd openwrt && git checkout fb7e09acfea17c435338d9b631cbd33fc39c3c62 && cd ..

# 2) 本仓库的板级适配
git clone https://github.com/azitak/openwrt-main-cmcc-rax3000q-nss.git rax3000q
bash rax3000q/scripts/setup.sh ./openwrt     # 打补丁 + 装文件 + feeds + 种子 + 校验

# 3) 编译
cd openwrt && make -j$(nproc)

# 产物
ls bin/targets/qualcommax/ipq50xx/
#  openwrt-qualcommax-ipq50xx-cmcc_rax3000q-squashfs-factory.ubi
#  openwrt-qualcommax-ipq50xx-cmcc_rax3000q-squashfs-sysupgrade.bin
```

想改包就 `make menuconfig`，改完用
`./scripts/diffconfig.sh > ../rax3000q/config/cmcc_rax3000q.config` 存回去。
`RESEED=1 scripts/setup.sh ./openwrt` 会丢掉现有 `.config` 重新按种子生成。

### CI

**只手动触发**：GitHub Actions → `Build CMCC RAX3000Q` → `Run workflow`。
push / PR 都**不会**编译（一次完整镜像约 90 分钟，改文档不值得跑一轮）。
需要时可选：

- `prepare_only=true`：只准备树 + 校验配置，约 5 分钟，不编译也不发 Release；
- `make_release=false`：编译出固件并上传 artifact，但不发 Release；
- `base_ref`：换基线 commit。

默认编译并发布 Release（`build-YYYYMMDD_HHMMSS`）。基线是**按 commit 固定**的：
NSS 补丁与 6.18.60 内核绑得很紧，跟着分支头跑容易踩空。

---

## 刷机

两种镜像：

| 文件 | 用途 |
|---|---|
| `*-squashfs-factory.ubi` | 从原厂 U-Boot 走 TFTP 首次刷入 |
| `*-squashfs-sysupgrade.bin` | 已经在跑 OpenWrt 的机器升级：`sysupgrade <file>`（保留配置时首启脚本会修复旧配置） |

原厂 U-Boot（3-pin 串口 115200n8 打断，PC 侧起 TFTP，原厂示例用 192.168.10.19）：

```
tftpboot 192.168.10.19:openwrt-qualcommax-ipq50xx-cmcc_rax3000q-squashfs-factory.ubi
flash rootfs
reset
```

**先备份**（U-Boot 里或进 OpenWrt 后）：

```
nanddump -f art.bin /dev/mtd$(grep '"0:art"' /proc/mtd | cut -d: -f1)
```

默认 LAN 地址 **192.168.1.1**。两个射频开机即启用，SSID
`RAX3000Q-2G` / `RAX3000Q-5G`，**默认开放无密码**（沿用上一版这块板的行为）。
在任何正式场合使用前请先加密码：

```
uci set wireless.default_radio0.encryption='sae-mixed'
uci set wireless.default_radio0.key='至少八位'
uci set wireless.default_radio1.encryption='sae-mixed'
uci set wireless.default_radio1.key='至少八位'
uci commit wireless && wifi reload
```

镜像里是**完整版** hostapd（`hostapd-mbedtls`，不是 basic）。这是在真机上用
`hostapd -t` 逐项实测后换的：

| 能力 | `wpad-basic-mbedtls`（首版） | 本版 `hostapd-mbedtls`（full） |
|---|---|---|
| 802.11k RRM | ✅ `rrm_neighbor_report` / `rrm_beacon_report` 接受 | ✅ |
| 802.11v WNM | ❌ `bss_transition` / `wnm_sleep_mode` 报 `unknown configuration item` | ✅ |
| 802.11r FT | ✅ `mobility_domain` / `ft_over_ds` / `ft_psk_generate_local` 接受 | ✅ |
| mesh / 11w / SAE / OWE / DPP | 部分 | ✅ 全量 |

配置里 11k / 11v / 11r 选项都已写好。**11r 需要加密**：wifi-scripts 的
`iface_roaming()` 在 `wpa < 2` 时直接返回，所以开放网络下 `ieee80211r` 是
惰性的；按上面设了密码后，FT-PSK / FT-SAE 会自动生效，无需再改别的。
11k 和 11v 在开放网络下就已经生效。

5 GHz 默认 36 信道 / HE160、country `CN`；这一段覆盖 DFS，开机第一次起 5G
有一次约 60 s 的 CAC，之后才发信标。想去掉等待就改成 `HE80`。

---

## 开机后怎么确认

```sh
# 1) 闪存认出来了（这是能不能开机的前提）
dmesg | grep -i 'spi-nand'
#   spi-nand spi0.0: Dosilicon SPI NAND was found. 128 MiB, 2048, OOB 64

# 2) 加速服务在
ls /etc/rc.d | grep S19nss
# 2b) 两个射频都起来了
iw dev                  # phy0-ap0 / phy1-ap0

# 3) 数据面接管成功
cat /sys/kernel/debug/qca-dwmac-nss/status
#   phys_if 1: started dev=eth0 ...
# 4) 整条平面起来了
logread -e nss          # 结尾 "NSS wired plane + ECM up (Wi-Fi on the NSS|host path)"

# 5) 跑流量再看
cat /sys/kernel/debug/ecm/ecm_nss_ipv4/tcp_accelerated_count   # > 0
grep -m1 ipv4_rx_pkts /sys/kernel/debug/qca-nss-drv/stats/ipv4 # 在涨
top                     # 满速转发时 idle > 90%
```

如果第 3 步没有 `started`，说明固件接管失败——**路由器仍然能正常路由**（走主机协议栈，
拓扑不变），只是没有硬件加速。`uci set nss.general.enabled='0'` 可以永久选择这条退路。

几点容易误判的：

- **`firewall.@defaults[0].flow_offloading` 必须关**（首次开机会被 `98-nss-offload` 清掉）。
  nft flowtable 会在 ECM 看到之前把已建立连接全部截走，结果是"平面已 armed、
  `tcp_accelerated_count` 不动、CPU 30–60%"。
- 单 CPU 口的天花板约 **911 Mbit/s**（一个方向的载荷和反方向的 ACK 共用同一条 1 GbE），
  这是板子的接线决定的，不是加速没生效。
- `eth0.1`/`eth0.2` 的计数器看不到加速流量；DSA 端口计数器来自交换机 MIB，能看。

---

## 已知限制（诚实版）

- **Wi-Fi offload（wifili）已在真机验证**：5G HE160 关联成功、流量走 NSS 路径
  （`logread -e nss` 的 "Wi-Fi on the NSS path"）。留意两点：mode 2 + 256M 档位
  会减少固件可创建的 VDEV/peer 数量（补丁 `903`，配合 `ATH11K_MEM_PROFILE_256M`
  才能在 256 MB 里同时容纳两个射频与 NSS；上游按 512 MB 档位编译，因此把 wifi
  关掉了）；若 wifili 起不来，两个射频会留在主机协议栈上（ath11k 的握手失败会
  打日志），路由不受影响。
- **sysupgrade 用的是上游 main 的路径**（`cmcc,rax3000q` 与 PZ-L8 同组，
  `elecom_upgrade_prepare` + `nand_do_upgrade`）。上一代项目为了兼容原厂 U-Boot
  改成过 `CI_UBIPART="rootfs"`；本仓库跟随上游。首版镜像已由用户通过 U-Boot TFTP
  刷入并正常启动，但 **sysupgrade 路径本身仍未在真机上跑过**。
- 镜像里没有的 kmod（wireguard、tun、USB 存储等）**不能从官方 feed 装**：
  内核不是官方编译的那一个，`apk` 会以 `kernel=...~vermagic` 拒绝。
  要用就在种子配置里加，重新编译。
- 首次从原厂固件切换需要 U-Boot TFTP；原厂 `bootipq` 的 A/B 槽逻辑没有改动。

---

## 参考与致谢

- [kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma) —— 本仓库的基线：
  OpenWrt main + NSS on 6.18，ipq50xx 的 `qca-dwmac-nss` / `qca8337-nss` / `nss-tools-dwmac`
- [JuliusBairaktaris](https://github.com/JuliusBairaktaris) —— NSS-on-upstream-driver 的思路与内核侧 patch
- [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss) ——
  同平台机型的 NSS 移植范本、板级数据与运行期读数（本仓库的参照对象）
- [hzyitc/openwrt-redmi-ax3000](https://github.com/hzyitc/openwrt-redmi-ax3000) ——
  RAX3000Q 的官方 BDF 与 QSDK 设备树
- OpenWrt main 的 RAX3000Q 支持（commit `d592680cc501`）—— 主线 DTS、镜像 profile、board.d
- Ahmed Naseef —— Dosilicon DS35Q1GA 驱动（Linux 7.0）

细节与逐文件决策见 [docs/PORTING.md](docs/PORTING.md)。
