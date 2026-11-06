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
# This project changes six things:
#   1. edits to files the baseline already ships  -> openwrt/0NNN-*.patch
#      (board DTS + image.mk + caldata cases; libnftnl autoreconf for fullcone;
#      kernel config trim)
#   2. files the baseline does not have           -> openwrt/tree/, copied in
#      (Dosilicon backport, BDF package, SONiC fullcone kernel/userspace patches)
#   3. patches into the installed feeds           -> openwrt/feeds/, copied after
#      `feeds install` (luci-app-firewall fullcone UI + zh_Hans strings;
#      nssinfo tolerant of subsystems the kernel did not build)
#   4. the rootfs overlay                        -> files/, copied into the
#      build tree's own files/ (wireless, apk mirror, first-boot repair, rc.local)
#   5. the .config seed                           -> config/
#   6. verification, so a missing piece fails here instead of after a build
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
# 0001 = board (DTS, image.mk, caldata), 0002 = the libnftnl autoreconf hook
# the SONiC fullcone patch needs, 0003 = kernel config trim (JFFS2, BPF).
# More 0NNN- patches are picked up in order.
say "Applying edits to baseline files"
for PATCH in "$HERE"/openwrt/0[0-9][0-9][0-9]-*.patch; do
    [ -f "$PATCH" ] || continue
    if git -C "$OW" apply --reverse --check "$PATCH" 2>/dev/null; then
        echo "  $(basename "$PATCH"): already applied, skipping"
    else
        run 600 git -C "$OW" apply --verbose "$PATCH"
    fi
done

# ---------------------------------------------------------------- 2. new files
say "Copying files the baseline does not have"
( cd "$HERE/openwrt/tree" && find . -type f -print0 |
  while IFS= read -r -d '' f; do
      install -Dm644 "$f" "$OW/${f#./}"
      echo "  ${f#./}"
  done )

# ------------------------------------------------------------ 2b. rootfs overlay
# OpenWrt copies the top-level files/ directory verbatim into the image.  It is
# where the shipped wireless config, apk mirror, first-boot repair script and
# nss-netlink loader live: none of them belong in the source tree itself.
if [ -d "$HERE/files" ]; then
    say "Installing the rootfs overlay (files/)"
    mkdir -p "$OW/files"
    ( cd "$HERE/files" && find . -type f -print0 |
      while IFS= read -r -d '' f; do
          install -Dm644 "$f" "$OW/files/${f#./}"
          echo "  files/${f#./}"
      done )
    chmod 755 "$OW/files/etc/rc.local" "$OW"/files/etc/uci-defaults/*
fi

# The board DTS must exist and must carry the NSS include: without the node
# qca-nss-drv never probes and the whole plane stays silent at runtime.
DTS="$OW/target/linux/qualcommax/dts/ipq5018-rax3000q.dts"
[ -f "$DTS" ] || { echo "ERROR: $DTS is missing"; exit 1; }
grep -q 'ipq5018-nss.dtsi' "$DTS" || { echo "ERROR: $DTS does not include ipq5018-nss.dtsi"; exit 1; }

# ---------------------------------------------------------------- 3. feeds
say "Updating and installing feeds"
# feeds.conf lists exactly four feeds: packages (sqm-scripts, tc), luci, the
# nss feed, and argon (luci-theme-argon).  routing/telephony/video would be
# ~60% of the clone for nothing.  feeds update uses -a so that every feed
# declared below gets an index - a hand-maintained list here once forgot argon
# and defconfig silently dropped luci-theme-argon.
#
# The git feeds use GitHub mirrors rather than git.openwrt.org: the Actions
# runners reach github.com directly and git.openwrt.org over a much slower path
# that occasionally stalls for tens of minutes (observed 2026-11-06: one run
# spent 100 s here, the next was still cloning after 40 min).
#
# Argon is a src-link, not a src-git.  OpenWrt's include/scan.mk:77 strips
# "/Makefile:.*" from each grep hit, which only works when the Makefile is in a
# SUBDIRECTORY of the feed.  jerrykuku keeps it at the repository root, and its
# trailing "# call BuildPackage - OpenWrt buildroot signature" comment then
# survives as a whole line in FILELIST, making the next make fail with
# "target pattern contains no '%'".  Staging the tarball one level down avoids
# that; src-link also means no git pull and no extra clone.
ARGON_LOCAL="$OW/feeds/argon-local"
ARGON_PKG="$ARGON_LOCAL/luci-theme-argon"
if [ ! -f "$ARGON_PKG/Makefile" ]; then
    say "Staging the Argon theme into a local src-link feed"
    mkdir -p "$ARGON_PKG"
    ARGON_TGZ="$OW/argon-theme.tar.gz"
    run 300 curl -fsSL "https://codeload.github.com/jerrykuku/luci-theme-argon/tar.gz/refs/heads/master" -o "$ARGON_TGZ"
    tar -xzf "$ARGON_TGZ" -C "$ARGON_PKG" --strip-components=1
    rm -f "$ARGON_TGZ"
    rm -rf "$ARGON_PKG/Screenshots" "$ARGON_PKG/tests" "$ARGON_PKG/docs" "$ARGON_PKG/.github"
    echo "  staged: $ARGON_PKG"
fi
# src-link init creates feeds/argon as a symlink; a stale one must go first.
[ ! -L "$OW/feeds/argon" ] || rm -f "$OW/feeds/argon"

FEEDS="$OW/feeds.conf"
NSS_LINE=$(grep -m1 'nss-packages' "$OW/feeds.conf.default" 2>/dev/null || true)
[ -n "$NSS_LINE" ] || {
    echo "ERROR: $OW/feeds.conf.default names no nss feed; the NSS packages would not exist" >&2
    exit 1
}
cat > "$FEEDS" <<EOF
src-git packages https://github.com/openwrt/packages.git
src-git luci https://github.com/openwrt/luci.git
$NSS_LINE
# luci-theme-argon is not in the official luci feed.  jerrykuku's master has
# ucode templates and is maintained against LuCI snapshot (PKG_RELEASE
# 20261106); the sbwml fork targets the 25.12 branch instead.  It is staged
# into feeds/argon-local/luci-theme-argon/ above (see the scan.mk note).
src-link argon $OW/feeds/argon-local
EOF
cat "$FEEDS"

# A stalled clone should give up in a minute, not hold the runner for an hour.
export GIT_HTTP_LOW_SPEED_LIMIT=1000
export GIT_HTTP_LOW_SPEED_TIME=60
feeds_log="$OW/feeds-setup.log"
: > "$feeds_log"

# tee, not a redirect: this is the one step whose progress is worth watching
# live, and the file is what the workflow uploads when it fails.
feeds_update() {
    ( cd "$OW" && run 1800 ./scripts/feeds update -a ) 2>&1 | tee -a "$feeds_log"
    return "${PIPESTATUS[0]}"
}
feeds_install() {
    ( cd "$OW" && run 1800 ./scripts/feeds install -a ) 2>&1 | tee -a "$feeds_log"
    return "${PIPESTATUS[0]}"
}

ok=0
for attempt in 1 2; do
    # A clone that died mid-way leaves a directory that is not a git checkout.
    # scripts/feeds then refuses to touch it, and the retry fails the same way.
    # argon is a src-link (no .git); only the three git feeds need this check.
    for d in packages luci nss; do
        if [ -d "$OW/feeds/$d" ] && [ ! -d "$OW/feeds/$d/.git" ]; then
            echo "WARNING: feeds/$d is not a git checkout, removing it for a clean clone" >&2
            rm -rf "$OW/feeds/$d"
        fi
    done
    echo "--- feeds update, attempt $attempt"
    if feeds_update; then ok=1; break; fi
    echo "WARNING: feeds update attempt $attempt failed; retrying" >&2
done
if [ "$ok" != 1 ]; then
    echo "ERROR: feeds update failed twice. Last 40 lines:"
    tail -40 "$feeds_log"
    exit 1
fi

if ! feeds_install; then
    echo "ERROR: feeds install failed or timed out. Last 40 lines:"
    tail -40 "$feeds_log"
    exit 1
fi
echo "feeds updated and installed"
grep -c 'Installing package' "$feeds_log" | sed 's/^/  packages installed: /' || true

# Derive this from feeds.conf, not from a hand-written list: a feed without an
# index is silently skipped by `feeds install`, and its packages then vanish
# from .config with no error until the verification stage much later.
while read -r kind name _rest; do
    case "$kind" in src-git|src-link|src-svn|src-git-full) ;; *) continue ;; esac
    [ -f "$OW/feeds/$name.index" ] || {
        echo "ERROR: feed '$name' has no index after 'feeds update -a'" >&2
        exit 1
    }
    echo "  feed index ok: $name"
done < <(grep -vE '^[[:space:]]*(#|$)' "$FEEDS")

# An index that exists but contains no packages is just as bad (this is what
# the root-Makefile scan.mk bug produced before argon became a src-link).
grep -q '^Package: luci-theme-argon$' "$OW/feeds/argon.index" || {
    echo "ERROR: argon feed index has no luci-theme-argon package" >&2
    exit 1
}
echo "  feed index ok: argon (luci-theme-argon present)"

# The SONiC fullcone LuCI patch belongs to luci-app-firewall, which only exists
# once the luci feed has been cloned, so it has to be copied now rather than
# with openwrt/tree/ above.  The Chinese strings are appended to the .po file:
# a patch would not reach it because po/ is read outside the build directory.
LUCIFW="$OW/feeds/luci/applications/luci-app-firewall"
if [ -d "$LUCIFW" ]; then
    say "Installing the fullcone LuCI integration"
    install -dm755 "$LUCIFW/patches"
    for p in "$HERE"/openwrt/feeds/luci-app-firewall/patches/*.patch; do
        [ -f "$p" ] && install -m644 "$p" "$LUCIFW/patches/$(basename "$p")"
    done
    ZH="$LUCIFW/po/zh_Hans/firewall.po"
    if [ -f "$ZH" ]; then
        sed '/^# BEGIN openwrt-sonic-fullcone$/,/^# END openwrt-sonic-fullcone$/d' \
            "$ZH" > "$ZH.tmp" && mv "$ZH.tmp" "$ZH"
        cat "$HERE/openwrt/feeds/luci-app-firewall/zh_Hans.po" >> "$ZH"
        echo "  LuCI patch + zh_Hans strings installed"
    else
        echo "WARNING: $ZH not found - fullcone controls will be untranslated" >&2
    fi
else
    echo "ERROR: $LUCIFW missing after feeds install; fullcone LuCI UI unavailable" >&2
    exit 1
fi

# Same story for the nssinfo fix: the patch belongs to the nss feed package
# nss-userspace-oss, which only exists after the nss feed has been cloned.
# It makes nssinfo skip netlink subsystems the kernel did not register and
# fixes the SIGABRT on exit (see the patch header for details).
NSSUSR="$OW/feeds/nss/nss-userspace-oss"
if [ -d "$NSSUSR" ]; then
    say "Installing the nssinfo feed patch"
    install -dm755 "$NSSUSR/patches"
    for p in "$HERE"/openwrt/feeds/nss-userspace-oss/patches/*.patch; do
        [ -f "$p" ] && install -m644 "$p" "$NSSUSR/patches/$(basename "$p")"
    done
    echo "  nssinfo patch installed"
else
    echo "ERROR: $NSSUSR missing after feeds install; nssinfo fix unavailable" >&2
    exit 1
fi

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
#
# Everything printed here also goes to $OW/setup-checks.txt, which the workflow
# uploads on failure: a job log that is cancelled or lost must not be the only
# record of why the tree was rejected.
say "Checking the boot- and offload-critical pieces"
CHECKS="$OW/setup-checks.txt"
: > "$CHECKS"
missing=0

say2file() { printf '%s\n' "$*" | tee -a "$CHECKS"; }

check() {
    local want=$1
    if grep -qx "$want" "$OW/.config"; then
        say2file "  ok       $want"
    else
        say2file "  MISSING  $(printf '%-46s' "$want") have: $(grep -E "^${want%%=*}=" "$OW/.config" || echo unset)"
        missing=1
    fi
}

# A package that must NOT be selected: kconfig has a habit of silently
# resolving conflicts by dropping the package we actually need.
forbid() {
    local bad=$1
    if grep -qx "$bad" "$OW/.config"; then
        say2file "  FORBIDDEN  $bad"
        missing=1
    else
        say2file "  ok         not selected: $bad"
    fi
}

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
# tristate M comments the feed's repository line out of distfeeds.list.
# The nss feed is local to this project and is on no public OpenWrt mirror,
# so leaving it at Y makes `apk update` report a missing index on every device.
check 'CONFIG_FEED_nss=m'
check 'CONFIG_PACKAGE_kmod-qca-nss-drv-netlink=y'
# apk mirror: a SNAPSHOT image needs a mirror that carries snapshots/.
check 'CONFIG_VERSION_REPO="https://mirrors.ustc.edu.cn/openwrt/snapshots"'
check 'CONFIG_IMAGEOPT=y'
check 'CONFIG_VERSIONOPT=y'
check 'CONFIG_FEED_argon=m'
# LuCI + Chinese + UPnP + Argon
check 'CONFIG_PACKAGE_luci=y'
check 'CONFIG_PACKAGE_luci-theme-argon=y'
check 'CONFIG_PACKAGE_luci-app-upnp=y'
check 'CONFIG_PACKAGE_luci-i18n-base-zh-cn=y'
# full hostapd is what enables 802.11v; no wpad at all (AP-only board)
check 'CONFIG_PACKAGE_hostapd-mbedtls=y'
forbid 'CONFIG_PACKAGE_wpad-mbedtls=y'
forbid 'CONFIG_PACKAGE_wpad-basic-mbedtls=y'
# nss-tools (the ipq807x/ipq60xx variant) is @BROKEN here and conflicts with
# nss-tools-dwmac.  The luci meta package must not resurrect it.
forbid 'CONFIG_PACKAGE_nss-tools=y'
# no USB port and a UBIFS rootfs: the subtarget's DEFAULT_PACKAGES must not
# drag USB + ext4 back in (they auto-load from /etc/modules.d and cost RAM)
forbid 'CONFIG_PACKAGE_kmod-usb3=y'
forbid 'CONFIG_PACKAGE_kmod-usb-dwc3=y'
forbid 'CONFIG_PACKAGE_kmod-usb-dwc3-qcom=y'
forbid 'CONFIG_PACKAGE_kmod-fs-ext4=y'
forbid 'CONFIG_PACKAGE_e2fsprogs=y'
forbid 'CONFIG_PACKAGE_losetup=y'

for f in \
  "$OW/target/linux/qualcommax/patches-6.18/0810-mtd-spinand-add-support-for-Dosilicon-DS35Q1GA-DS35M1GA.patch" \
  "$OW/package/ipq-wifi-cmcc_rax3000q/Makefile" \
  "$OW/files/etc/config/wireless" \
  "$OW/files/etc/uci-defaults/99-rax3000q-firstboot" \
  "$OW/files/etc/uci-defaults/16-rax3000q-fullcone" \
  "$OW/files/etc/rc.local" \
  "$OW/target/linux/generic/hack-6.18/984-add-sonic-fullcone-support.patch" \
  "$OW/target/linux/generic/hack-6.18/987-sonic-fullcone-fix-races-and-drops.patch" \
  "$OW/package/network/config/firewall4/patches/001-sonic-fullcone.patch" \
  "$OW/package/network/utils/nftables/patches/002-nftables-add-fullcone-expression-support.patch" \
  "$OW/package/libs/libnftnl/patches/001-libnftnl-add-fullcone-expression-support.patch" \
  "$OW/feeds/luci/applications/luci-app-firewall/patches/001-add-fullcone-options.patch"
do
    if [ -f "$f" ]; then
        say2file "  ok       ${f#$OW/}"
    else
        say2file "  MISSING  ${f#$OW/}"
        missing=1
    fi
done
DOSI="$OW/target/linux/qualcommax/patches-6.18/0810-mtd-spinand-add-support-for-Dosilicon-DS35Q1GA-DS35M1GA.patch"
# No glob inside quotes: "$DOSI" is one path, and a glob written *inside* the
# quotes is not expanded - grep then looks for a file called "0810-*.patch",
# fails, and the check reports a missing patch that is sitting right there.
grep -q 'SPINAND_MFR_DOSILICON' "$DOSI" || { say2file "  MISSING  manufacturer id 0xe5 in $DOSI"; missing=1; }
grep -q 'DS35Q1GA' "$DOSI" || { say2file "  MISSING  DS35Q1GA device entry in $DOSI"; missing=1; }
grep -q 'nand-ecc-strength = <4>' "$DTS" ||
    { say2file "  MISSING  4-bit ECC in $DTS"; missing=1; }
grep -q 'ubi.mtd=rootfs' "$DTS" ||
    { say2file "  MISSING  ubi.mtd=rootfs in $DTS bootargs-append"; missing=1; }
CAL="$OW/target/linux/qualcommax/ipq50xx/base-files/etc/hotplug.d/firmware/11-ath11k-caldata"
n=$(grep -c '^[[:space:]]*cmcc,rax3000q)' "$CAL" 2>/dev/null || echo 0)
[ "$n" = 2 ] ||
    { say2file "  MISSING  rax3000q caldata cases in 11-ath11k-caldata (have $n, need 2)"; missing=1; }
grep -q 'caldata_extract "0:art" 0x1000 0x20000' "$CAL" ||
    { say2file "  MISSING  2.4 GHz caldata offset 0x1000"; missing=1; }
grep -q 'caldata_extract "0:art" 0x26800 0x20000' "$CAL" ||
    { say2file "  MISSING  5 GHz caldata offset 0x26800"; missing=1; }
grep -q 'config wifi-device' "$OW/files/etc/config/wireless" ||
    { say2file "  MISSING  radios in files/etc/config/wireless"; missing=1; }
grep -q 'qca-nss-netlink' "$OW/files/etc/rc.local" ||
    { say2file "  MISSING  qca-nss-netlink loader in files/etc/rc.local"; missing=1; }
WIFI="$OW/files/etc/config/wireless"
for k in ieee80211k rrm_neighbor_report bss_transition wnm_sleep_mode ieee80211r; do
    grep -q "option $k " "$WIFI" ||
        { say2file "  MISSING  802.11k/v/r option '$k' in wireless config"; missing=1; }
done
grep -q '^PKG_FIXUP:=autoreconf' "$OW/package/libs/libnftnl/Makefile" ||
    { say2file "  MISSING  PKG_FIXUP:=autoreconf in libnftnl (fullcone patch needs it)"; missing=1; }
grep -q '^# BEGIN openwrt-sonic-fullcone' "$OW/feeds/luci/applications/luci-app-firewall/po/zh_Hans/firewall.po" ||
    { say2file "  MISSING  fullcone zh_Hans strings in luci-app-firewall"; missing=1; }
grep -q "fullcone='1'" "$OW/files/etc/uci-defaults/16-rax3000q-fullcone" ||
    { say2file "  MISSING  fullcone enable in 16-rax3000q-fullcone"; missing=1; }
grep -q 'return -ENOENT' "$OW/feeds/nss/nss-userspace-oss/patches/0040-nssinfo-tolerate-missing-nl-subsystems.patch" ||
    { say2file "  MISSING  nssinfo -ENOENT fix in the nss feed patch"; missing=1; }
DIST="$OW/files/etc/apk/repositories.d/distfeeds.list"
grep -q 'mirrors.ustc.edu.cn/openwrt/snapshots' "$DIST" ||
    { say2file "  MISSING  USTC mirror in $DIST"; missing=1; }
if grep -q 'downloads.openwrt.org\|mirrors.tuna' "$DIST"; then
    say2file "  FORBIDDEN  official/TUNA URL still present in $DIST"
    missing=1
fi

# Not a check: a per-symbol report of what defconfig did to the seed.  This is
# what tells a dropped LuCI component from a dropped NSS driver, and it is the
# reason the file is uploaded when this script exits non-zero.
say2file ""
say2file "seed fragment vs .config (DROPPED = kconfig did not keep it):"
while IFS= read -r want; do
    case "$want" in \#*|'') continue ;; esac
    if grep -qx "$want" "$OW/.config"; then
        say2file "  kept     $want"
    else
        say2file "  DROPPED  $(printf '%-46s' "$want") have: $(grep -E "^${want%%=*}=" "$OW/.config" || echo unset)"
    fi
done < <(grep -E '^CONFIG_[A-Za-z0-9_-]+=' "$HERE/config/cmcc_rax3000q.config")

if [ "$missing" != 0 ]; then
    echo
    echo "ERROR: the tree is not in the state this project needs." >&2
    echo "       See $CHECKS (uploaded by the workflow on failure)." >&2
    echo "       A missing file means the base tree moved; a missing symbol means" >&2
    echo "       defconfig dropped it (run RESEED=1 $0 $OW)." >&2
    exit 1
fi
say2file "  all present"

say "Ready.  Build with:  cd $OW && make -j\$(nproc)"
echo "        Pick packages with:  make menuconfig"
echo "        Keep your selection: ./scripts/diffconfig.sh > $HERE/config/cmcc_rax3000q.config"
