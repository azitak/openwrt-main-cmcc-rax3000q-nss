# CMCC RAX3000Q — OpenWrt main with Qualcomm NSS offload

English | [中文](README.md)

OpenWrt **main** (kernel 6.18.60) for the **CMCC RAX3000Q / RAX3000-QY**
(IPQ5018 + QCA8337 + QCN6102, 256 MB RAM, 128 MB SPI-NAND), with the three
things upstream does not give you:

1. **Dosilicon DS35Q1GA / DS35M1GA SPI-NAND support.** Many boards carry that
   part, not the GigaDevice GD5F1GQ5REYIG the upstream DTS describes. Linux
   6.18 has no driver for manufacturer id `0xe5` (it lands in 7.0), so
   `spi-nand` probe fails, no MTD partitions appear, UBI cannot attach and the
   kernel never mounts root — the router looks bricked after flashing.
2. **Both radios.** Upstream `Device/cmcc_rax3000q` has an empty
   `DEVICE_PACKAGES` (no ath11k firmware, no board BDF) and both wifi nodes are
   `disabled`, because it assumes the 512 MB memory defaults. This is a 256 MB
   board.
3. **Wired and Wi-Fi forwarding inside the NSS core**, following the NSS port
   of [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss)
   for the same SoC and the same switch.

> **Status: code complete, first CI image still has to be validated on hardware.**
> Back up every partition before flashing, `0:art` above all.

## Why the PZ-L8 recipe cannot be used on main

On 2026-07-11 OpenWrt main merged PR #22381: `qualcommax: ipq50xx: convert to
UNIPHY PCS and DWMAC stack` and `kernel: drop qca-nss-dp and qca-ssdk`.
ipq50xx moved from the QSDK data path (`qca-nss-dp` + `qca-ssdk`) to the
upstream `stmmac` driver (`dwmac-ipq5018`) with the QCA8337 behind DSA, and
both packages were deleted from the tree. mufeng05's project — and this
author's previous [v25.12.5 port](https://github.com/azitak/openwrt-cmcc-rax3000q-nss) —
depend on `qca-nss-dp`, `dp1`/`dp2`, the `qca-ssdk` switch driver and eleven
6.12 kernel patches, plus a 159 KB ath11k wifili patch. None of that survives a
baseline change to main.

So this repository takes the path that main itself grew, and feeds the PZ-L8
project's board data and lessons into it:

```
kernel 6.18 stmmac (dwmac-ipq5018)      upstream driver stays; phylink/MDIO/netdev stay with the host
        |  stmmac data-plane claim API (patch 0956)
        v
kmod-qca-dwmac-nss                      TX drained, NAPI off, DMA stopped, ndo_start_xmit redirected
        |  implements the nss-dp API qca-nss-drv expects
        v
qca-nss-drv + NSS firmware (12.5-210)   UBI32 core takes over forwarding
        v
qca-nss-ecm                             conntrack -> acceleration rules (DSA port patches 0051-0057)
```

Wiring is untouched: the QCA8337 keeps its DSA driver, and before netifd runs
the NSS service switches the conduit's tag protocol to `qca-8021q`
(plain 802.1Q), which the firmware can parse; `qca-dsa-nss` then gives every
DSA port and VLAN a firmware VLAN interface so ECM can write rules for it.
**`lan1`-`lan3` and `wan` stay the interface names they are on a stock image.**

| part | source |
|---|---|
| OpenWrt tree | `kuncy7/openwrt-nss-edma`, branch `c3po-tag-8021q`, commit `fb7e09a` — OpenWrt main 2026-10-09 + the NSS series, kernel 6.18.60 |
| NSS packages | its feed `kuncy7/nss-packages`, branch `ipq50xx-rebase` |
| board data | upstream mainline DTS, community QSDK DTS, the official BDF |

## What this repository changes

1. `openwrt/0001-cmcc-rax3000q-nss.patch` — two files:
   `image/ipq50xx.mk` gets `DEVICE_PACKAGES := ath11k-firmware-ipq5018-qcn6122
   ipq-wifi-cmcc_rax3000q`; the board DTS gets `#include "ipq5018-nss.dtsi"`,
   `nand-ecc-strength = <4>` (both parts use on-die 4-bit ECC per 512 B; 8 makes
   what U-Boot wrote unreadable), `ubi.mtd=rootfs`, `coherent_pool=512K`,
   `&nss_region` at 8 MiB (the vendor MP_256 firmware reserves 8 MiB too), both
   radios `okay` with `ath11k-fw-memory-mode = <2>`.
2. `openwrt/tree/` — the Dosilicon driver backport
   (`patches-6.18/0810-…`, Linux 7.0 driver by Ahmed Naseef / Miquel Raynal) and
   `package/ipq-wifi-cmcc_rax3000q/` (the board's official BDF, packed into
   `board-2.bin.{IPQ5018,QCN6122}` with five name variants each).
3. `config/cmcc_rax3000q.config` — 256M group (`ATH11K_MEM_PROFILE_256M`,
   `NSS_MEM_PROFILE_LOW`), `nss-tools-dwmac`, Wi-Fi offload, firmware 12.5,
   SQM (in the image, off by default), LuCI with Chinese (the NSS tree's own
   images ship without LuCI).
4. `scripts/setup.sh` + `.github/workflows/build.yml` — apply all of the above
   to a clean baseline and verify the boot-critical pieces before spending 90
   minutes on a build that would produce an unbootable image.

## Build

```sh
git clone -b c3po-tag-8021q https://github.com/kuncy7/openwrt-nss-edma.git openwrt
cd openwrt && git checkout fb7e09acfea17c435338d9b631cbd33fc39c3c62 && cd ..

git clone https://github.com/azitak/openwrt-main-cmcc-rax3000q-nss.git rax3000q
bash rax3000q/scripts/setup.sh ./openwrt
cd openwrt && make -j$(nproc)
```

Products: `*-squashfs-factory.ubi` (vendor U-Boot over TFTP: `tftpboot …` then
`flash rootfs`) and `*-squashfs-sysupgrade.bin`. Default LAN is 192.168.1.1.
Both radios come up enabled as `RAX3000Q-2G` / `RAX3000Q-5G`, **open with no
password** (as in the earlier 25.12 build for this board). Add a key before
using it anywhere that matters: `uci set wireless.default_radio0.encryption='sae-mixed'`,
`set ... .key='your-key'`, repeat for `default_radio1`, then
`uci commit wireless && wifi reload`.

The image carries `wpad-basic-mbedtls`: WPA2 / WPA3-SAE / OWE / 802.11r /
802.11w, but NOT 802.11k/v or mesh - hostapd rejects `rrm_neighbor_report`
and friends outright, which takes *both* radios down. Replace it with
`apk add wpad-mbedtls` if 11k/v is needed. 5 GHz is channel 36 / HE160 /
country CN, so the first boot after powering on spends ~60 s in DFS CAC before
the 5 GHz beacon appears; HE80 avoids that.

Calibration data is extracted by `11-ath11k-caldata` from `0:art` at 0x1000
(2.4 GHz) and 0x26800 (5 GHz), 128 KiB each, raw - patching the MAC into this
board's blob makes the firmware assert. The baseline script had no
`cmcc,rax3000q` case, so both radios failed to probe with
`failed to load board data file: -12` and no wiphy appeared. `files/` also
ships the wireless config, a first-boot repair for upgrades from that image,
and an rc.local that loads `qca-nss-netlink` so `nssinfo` works.

CI is **manual only**: Actions -> "Build CMCC RAX3000Q" -> Run workflow.
Pushes and PRs do not trigger a build (one image costs ~90 minutes). Use
`prepare_only` for a ~5 minute tree/config check, `make_release=false` to keep
the images as artifacts only, and `base_ref` to change the baseline commit.
The baseline is pinned because the NSS patches are tied to kernel 6.18.60.

## Checking that the offload is on

```sh
dmesg | grep -i 'spi-nand'                     # Dosilicon SPI NAND was found. 128 MiB
cat /sys/kernel/debug/qca-dwmac-nss/status     # phys_if 1: started dev=eth0
logread -e nss                                 # "NSS wired plane + ECM up"
cat /sys/kernel/debug/ecm/ecm_nss_ipv4/tcp_accelerated_count   # > 0 under traffic
```

If the takeover fails the router still routes on the host path with the same
topology; `uci set nss.general.enabled='0'` makes that permanent. Keep
`firewall.@defaults[0].flow_offloading` off — an nft flowtable steals flows
before ECM sees them. The single-CPU-port ceiling is ~911 Mbit/s; that is the
board's wiring, not the offload.

## Known limits

- **Wi-Fi offload is not validated on this board** (the wired path is, on the
  GL-B3000 — same SoC, same switch). This board's QCN6102 uses mainline's
  multi-PD idiom (`q6_wcss_pd2`), the validated boards use the single-rproc
  one. If wifili fails, the radios stay on the host path; routing is unaffected.
- sysupgrade follows upstream main (`elecom_upgrade_prepare` group); it has not
  been run on hardware here.
- kmods not in the image cannot be installed from the official feeds (kernel
  vermagic differs) — add them to the seed and rebuild.

See [docs/PORTING.md](docs/PORTING.md) for the file-by-file reasoning.

## Credits

[kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma) (baseline),
[JuliusBairaktaris](https://github.com/JuliusBairaktaris) (NSS on upstream
drivers), [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss)
(reference port, board data, runtime checks), [hzyitc/openwrt-redmi-ax3000](https://github.com/hzyitc/openwrt-redmi-ax3000)
(BDF and QSDK DTS), OpenWrt's own RAX3000Q commit `d592680cc501`, and Ahmed
Naseef for the Dosilicon driver.
