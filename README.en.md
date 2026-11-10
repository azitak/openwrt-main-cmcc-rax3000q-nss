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
3. **Wired forwarding inside the NSS core** (Wi-Fi offload is built and
   validated on this board), following the NSS port
   of [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss)
   for the same SoC and the same switch.

> **Status:** validated on hardware (Dosilicon/UBI, DSA/WAN, NSS offload,
> both radios 5 GHz HE160, 11k/v/r, fullcone, LuCI/USTC mirror). Back up
> every partition before flashing, `0:art` above all.

## What this repository changes

1. `openwrt/0001-*.patch` + `0002-*.patch` + `0003-*.patch` — edits to files the
   baseline ships:
   `image/ipq50xx.mk` (`DEVICE_PACKAGES` gains the ath11k firmware, the board
   BDF, `-wpad-basic-mbedtls wpad-mbedtls`, and negatives for
   the subtarget's USB/ext4 DEFAULT_PACKAGES), the board DTS (NSS include,
   4-bit ECC, `ubi.mtd=rootfs`, `coherent_pool=512K`, 8 MiB NSS region, both
   radios `okay` with `ath11k-fw-memory-mode = <2>` and the baseline's single
   rproc wiring), two `cmcc,rax3000q` caldata cases, `PKG_FIXUP:=autoreconf`
   in libnftnl for the fullcone patch, and the kernel config trim (no JFFS2,
   no BPF syscall/JIT - unused on this board).
2. `openwrt/tree/` — files the baseline lacks: the Dosilicon backport, the
   board's BDF package, and the SONiC fullcone NAT kernel/userspace patches.
3. `openwrt/feeds/` — the `luci-app-firewall` fullcone UI patch and zh_Hans
   strings, plus the `nss-userspace-oss` nssinfo fix (skip netlink families the
   kernel did not register; no SIGABRT on exit), both installed by `setup.sh`
   after `feeds install`.
4. `files/` — the shipped wireless config (11k/11v/11r), the USTC apk mirror,
   a first-boot repair for kept-config upgrades, a uci-defaults script that
   enables fullcone NAT, an rc.local that loads `qca-nss-netlink` so
   `nssinfo` works, and three custom LuCI overview cards (`15_cpu` / `16_net`
   / `17_nss`) that follow the stock cards' stateless `load()`/`render()`
   contract.
5. `config/cmcc_rax3000q.config` — 256M group, NSS/ECM + wifili, firmware 12.5,
   SQM (off by default), full `wpad-mbedtls` (802.11s mesh needs its
   supplicant half; `hostapd-mbedtls` is excluded), `luci` + argon + UPnP + four
   zh_Hans i18n packages, `zram-swap`, and the USTC `VERSION_REPO`.
6. `scripts/setup.sh` + `.github/workflows/build.yml` — apply all of the above
   to a clean baseline and verify every boot-critical piece before spending 90
   minutes on a build that would produce an unbootable image.

## Build

```sh
git clone -b c3po-tag-8021q https://github.com/kuncy7/openwrt-nss-edma.git openwrt
# to reproduce a CI build: cd openwrt && git checkout <base_commit from build-info.txt>

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

The image carries the FULL `wpad-mbedtls` (not basic). This was decided after
a `hostapd -t` probe on the real device: the basic build accepts the 802.11k
RRM keys and the 802.11r FT keys, but rejects `bss_transition` /
`wnm_sleep_mode` (802.11v) as "unknown configuration item", so the image
first moved to full `hostapd-mbedtls`; on 2026-11-10 it moved back to full
`wpad-mbedtls` because 802.11s mesh needs the wpa_supplicant half that only
wpad ships. The mesh variant maps to the same full hostapd .config, so
11k/11v/11r + SAE are all compiled in and all three are present in the
shipped wireless config; the cost is a resident supplicant (~3 MiB). The
decision chain is documented in docs/PORTING.md (5c/5e).
802.11r needs encryption: wifi-scripts' `iface_roaming()` returns early unless
wpa >= 2, so while the SSIDs are open the FT options are inert; add a key and
FT-PSK/FT-SAE becomes active with no other change. 11k and 11v work already.

5 GHz is channel 36 / HE160 / country CN, so the first boot spends ~60 s in
DFS CAC before the 5 GHz beacon appears; HE80 avoids that.

**apk mirror**: this is a SNAPSHOT image. TUNA explicitly does not mirror
snapshots (only releases), so the sources point at USTC, an OpenWrt tier-1
mirror in China; all four indexes were checked. `luci`, `luci-theme-argon`
(a local src-link feed), `luci-app-upnp` and four zh_Hans i18n packages are in
the image; bootstrap stays the default theme.

**SONiC fullcone NAT**: the kernel/fw4/libnftnl/nftables/LuCI patches from
`mufeng05/openwrt-sonic-fullcone` are built in (6.18 supported, verified to
apply cleanly against Linux 6.18). It is ON by default: a uci-defaults script
sets `defaults.fullcone=1` and `fullcone=1` on every masquerading zone on each
flash. Coexistence with NSS/ECM was verified on the device (rules generated,
WAN connectivity and ECM connection counting all normal). Turn it off with
`uci set firewall.@defaults[0].fullcone=0`,
`uci set firewall.@zone[1].fullcone=0`, `uci commit firewall`,
`/etc/init.d/firewall restart`; `nft list ruleset | grep fullcone` should then
be empty. Long-run EIM/EIF behaviour under heavy NAT load has no dedicated
test; NSS/ECM hands established connections to the firmware, which bypasses
later conntrack processing.

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
the images as artifacts only, and `base_ref` to pin the baseline commit.
By default the baseline follows the head of c3po-tag-8021q on every build.

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

## Credits

- [kuncy7/openwrt-nss-edma](https://github.com/kuncy7/openwrt-nss-edma) — baseline (OpenWrt main + NSS on 6.18)
- [JuliusBairaktaris](https://github.com/JuliusBairaktaris) — NSS-on-upstream-driver work
- [mufeng05/openwrt-cmcc-pz-l8-nss](https://github.com/mufeng05/openwrt-cmcc-pz-l8-nss) — reference port and board data
- [hzyitc/openwrt-redmi-ax3000](https://github.com/hzyitc/openwrt-redmi-ax3000) — BDF and QSDK DTS