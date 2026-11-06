#!/bin/bash
# Turn a checkout of the NSS-on-mainline tree into a buildable RAX3000Q tree.
#
#   scripts/setup.sh /path/to/openwrt
#
# The baseline is NOT plain openwrt/openwrt: it is
#   kuncy7/openwrt-nss-edma, branch c3po-tag-8021q
# which is OpenWrt main (2026-10-09) plus the NSS-on-6.18 series: the stmmac
# data-plane claim API, qca-dwmac-nss, qca8337-nss, the ath11k NSS patches and
# the nss-tools service.  OpenWrt main dropped qca-nss-dp and qca-ssdk in July
# 2026, so the older "NSS = nss-dp + ssdk" recipe (mufeng05's PZ-L8 project)
# cannot be applied to main any more; that tree is what replaced it.
#
# This project changes four things:
#   1. edits to files the baseline already ships  -> openwrt/0001-*.patch
#   2. files the baseline does not have           -> openwrt/tree/, copied in
#      (the Dosilicon SPI-NAND backport and the board's BDF package)
#   3. the .config seed                           -> config/
#   4. verification, so a missing piece fails here instead of after a build
#
# Idempotent: re-running on a prepared tree is a no-op for 1 and safe for the
# rest.  RESEED=1 replaces an existing .config with the seed again.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OW=${1:?usage: $0 /path/to/openwrt}
OW=$(cd "$OW" && pwd)

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Network steps are wall-clock bounded: CI has no console, and an unbounded
# `feeds update` that stalls on a flaky mirror parks the job instead of
# failing it.
run() {
    local limit=$1; shift
    printf '    [%s] $ %s\n' "$(date -u +%H:%M:%S)" "$*"
    local rc=0
    timeout "$limit" "$@" || rc=$?
    printf '    [%s]   rc=%d\n' "$(date -u +%H:%M:%S)" "$rc"
    if [ "$rc" -eq 124 ]; then echo "TIMEOUT after ${limit}s: $*" >&2; fi
    return "$rc"
}

[ -f "$OW/rules.mk" ] || { echo "$OW does not look like an OpenWrt tree"; exit 1; }

# ---------------------------------------------------------------- 0. baseline
# The board patch and the DTS both assume the NSS base tree.  Without this
# check a plain openwrt/openwrt checkout fails 40 minutes into the build with
# "No rule to make target .../ipq5018-nss.dtsi".
if [ ! -f "$OW/target/linux/qualcommax/files/arch/arm64/boot/dts/qcom/ipq5018-nss.dtsi" ]; then
    echo "ERROR: $OW is not the NSS base tree (ipq5018-nss.dtsi is missing)." >&2
    echo "       Clone kuncy7/openwrt-nss-edma, branch c3po-tag-8021q, and try again." >&2
    exit 1
fi
if [ -d "$OW/.git" ]; then
    say "Base: $(git -C "$OW" log -1 --format='%h %s' 2>/dev/null || echo unknown)"
fi

# ---------------------------------------------------------------- 1. tracked edits
say "Applying edits to baseline files"
PATCH="$HERE/openwrt/0001-cmcc-rax3000q-nss.patch"
if git -C "$OW" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "already applied, skipping"
else
    run 600 git -C "$OW" apply --verbose "$PATCH"
fi

# ---------------------------------------------------------------- 2. new files
say "Copying files the baseline does not have"
( cd "$HERE/openwrt/tree" && find . -type f -print0 |
  while IFS= read -r -d '' f; do
      install -Dm644 "$f" "$OW/${f#./}"
      echo "  ${f#./}"
  done )

# The board DTS must exist and must carry the NSS include: without the node
# qca-nss-drv never probes and the whole plane stays silent at runtime.
DTS="$OW/target/linux/qualcommax/dts/ipq5018-rax3000q.dts"
[ -f "$DTS" ] || { echo "ERROR: $DTS is missing"; exit 1; }
grep -q 'ipq5018-nss.dtsi' "$DTS" || { echo "ERROR: $DTS does not include ipq5018-nss.dtsi"; exit 1; }

# ---------------------------------------------------------------- 3. feeds
say "Updating and installing feeds"
# feeds.conf.default of the baseline already names the nss feed
# (kuncy7/nss-packages;ipq50xx-rebase).
FEEDS="$OW/feeds.conf"
[ -f "$FEEDS" ] || cp "$OW/feeds.conf.default" "$FEEDS"
grep -q 'nss-packages' "$FEEDS" || {
    echo "ERROR: $FEEDS has no nss feed line; the NSS packages would not exist" >&2
    exit 1
}
feeds_log="$OW/feeds-setup.log"
if ! ( cd "$OW" && run 1800 ./scripts/feeds update -a ) >"$feeds_log" 2>&1; then
    echo "ERROR: feeds update failed or timed out. Last 40 lines:"
    tail -40 "$feeds_log"
    exit 1
fi
if ! ( cd "$OW" && run 1800 ./scripts/feeds install -a ) >"$feeds_log" 2>&1; then
    echo "ERROR: feeds install failed or timed out. Last 40 lines:"
    tail -40 "$feeds_log"
    exit 1
fi
echo "feeds updated and installed"

# ---------------------------------------------------------------- 4. config
if [ -f "$OW/.config" ] && [ "${RESEED:-0}" != 1 ]; then
    say "Keeping the existing .config  (RESEED=1 to replace it with the seed)"
else
    say "Seeding .config"
    cp "$HERE/config/cmcc_rax3000q.config" "$OW/.config"
fi

# The seed is a fragment: defconfig fills in everything it does not name.  It
# is run every time, because it is also what pulls in the kconfig defaults of
# a baseline that moved.
if ! ( cd "$OW" && run 900 make defconfig ) >"$OW/defconfig.log" 2>&1; then
    echo "ERROR: make defconfig failed or timed out. Last 40 lines:"
    tail -40 "$OW/defconfig.log"
    exit 1
fi
grep -E '^CONFIG_TARGET_(BOARD|SUBTARGET|PROFILE)|^CONFIG_TARGET_qualcommax_ipq50xx_DEVICE_' "$OW/.config" || true

# ---------------------------------------------------------------- 5. verification
# Every symbol here is either boot-critical (the NAND driver, the DTS values)
# or silently wrong when it is missing (an NSS build without wifili links fine
# and offloads nothing).  The workflow checks the same list; failing here costs
# seconds, failing there costs a build.
say "Checking the boot- and offload-critical pieces"
missing=0
check() { grep -qx "$1" "$OW/.config" || { echo "  MISSING: $1"; missing=1; }; }

check 'CONFIG_TARGET_qualcommax_ipq50xx_DEVICE_cmcc_rax3000q=y'
check 'CONFIG_PACKAGE_kmod-qca-dwmac-nss=y'
check 'CONFIG_PACKAGE_kmod-qca-nss-drv=y'
check 'CONFIG_PACKAGE_kmod-qca-nss-ecm=y'
check 'CONFIG_PACKAGE_kmod-qca8337-nss=y'
check 'CONFIG_PACKAGE_nss-tools-dwmac=y'
check 'CONFIG_PACKAGE_nss-firmware=y'
check 'CONFIG_NSS_FIRMWARE_VERSION_12_5=y'
check 'CONFIG_NSS_DRV_WIFIOFFLOAD_ENABLE=y'
check 'CONFIG_ATH11K_NSS_SUPPORT=y'
check 'CONFIG_PACKAGE_ath11k-firmware-ipq5018-qcn6122=y'
check 'CONFIG_PACKAGE_ipq-wifi-cmcc_rax3000q=y'
check 'CONFIG_ATH11K_MEM_PROFILE_256M=y'
check 'CONFIG_NSS_MEM_PROFILE_LOW=y'

for f in \
  "$OW/target/linux/qualcommax/patches-6.18/0810-mtd-spinand-add-support-for-Dosilicon-DS35Q1GA-DS35M1GA.patch" \
  "$OW/package/ipq-wifi-cmcc_rax3000q/Makefile"
do
    [ -f "$f" ] || { echo "  MISSING FILE: ${f#$OW/}"; missing=1; }
done
grep -q 'DS35Q1GA' "$OW/target/linux/qualcommax/patches-6.18/0810-*.patch" 2>/dev/null ||
    { echo "  MISSING: DS35Q1GA in the Dosilicon patch"; missing=1; }
grep -q 'nand-ecc-strength = <4>' "$DTS" ||
    { echo "  MISSING: 4-bit ECC in $DTS"; missing=1; }
grep -q 'ubi.mtd=rootfs' "$DTS" ||
    { echo "  MISSING: ubi.mtd=rootfs in $DTS bootargs-append"; missing=1; }

if [ "$missing" != 0 ]; then
    echo
    echo "ERROR: the tree is not in the state this project needs." >&2
    echo "       A missing file means the base tree moved; a missing symbol means" >&2
    echo "       defconfig dropped it (run RESEED=1 $0 $OW)." >&2
    exit 1
fi
echo "  all present"

say "Ready.  Build with:  cd $OW && make -j\$(nproc)"
echo "        Pick packages with:  make menuconfig"
echo "        Keep your selection: ./scripts/diffconfig.sh > $HERE/config/cmcc_rax3000q.config"
