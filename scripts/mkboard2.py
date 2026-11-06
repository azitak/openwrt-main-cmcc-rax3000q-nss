#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
#
# Re-pack an ath11k board-2.bin so one calibration payload is reachable under
# several board names.
#
# Why this exists
# ---------------
# The CMCC RAX3000Q board data published by the community (originally from
# hzyitc/openwrt-redmi-ax3000, package/firmware/ipq-wifi/src/board-cmcc_rax3000q.*)
# is a single-entry board-2.bin named
#
#   bus=ahb,qmi-chip-id=0,qmi-board-id=36   (IPQ5018, 2.4 GHz)
#   bus=ahb,qmi-chip-id=0,qmi-board-id=96   (QCN6122/QCN6102, 5 GHz)
#
# Those are the QSDK DT board IDs.  Mainline ath11k gets its board ID from the
# QMI WLFW service, which on IPQ5018 boards generally reports 255 and uses the
# DT property qcom,ath11k-calibration-variant to tell boards apart.  It then
# tries, in order (Linux 6.12 drivers/net/wireless/ath/ath11k/core.c):
#
#   1. bus=ahb,qmi-chip-id=N,qmi-board-id=M,variant=<variant>
#   2. bus=ahb,qmi-chip-id=N,qmi-board-id=M          (no variant)
#   3. bus=ahb,qmi-chip-id=N
#   4. board.bin (API 1)
#
# A one-entry file only works if the board reports exactly that ID.  This tool
# duplicates the (id, payload) pair under every name ath11k could ask for, so
# the same blob works on a QSDK-derived board ID and on mainline's 255+variant
# naming without guessing which one a given firmware reports.
#
# Format (board API 2)
# --------------------
#   magic   "QCA-ATH11K-BOARD" + NUL, padded to 4 bytes            (20 bytes)
#   outer IE:  u32 id=ATH11K_BD_IE_BOARD(0), u32 len, u8 data[]
#       inner IE: u32 id=BOARD_NAME(0), u32 len, name padded to 4
#       inner IE: u32 id=BOARD_DATA(1), u32 len, payload
#   ... more outer IEs
#
# IE data is 4-byte aligned.  Padding in the upstream blobs is 0x6d ('m'); we
# emit NUL padding, which the parser ignores (it only uses ie_len).
#
# Usage:
#   scripts/mkboard2.py SRC DST --name NAME [--name NAME ...]
#
# The generated files are checked in so a build needs no Python at image time.

import argparse
import struct
from pathlib import Path

MAGIC = b"QCA-ATH11K-BOARD\x00"
MAGIC_LEN = (len(MAGIC) + 3) & ~3
IE_HDR = struct.Struct("<II")


def ie(ident: int, payload: bytes) -> bytes:
    """Emit one IE with its data padded to a 4-byte boundary."""
    pad = (-len(payload)) & 3
    return IE_HDR.pack(ident, len(payload)) + payload + b"\x00" * pad


def parse_ies(buf: bytes):
    """Yield (id, unpadded_data) from a packed IE stream."""
    off = 0
    while off + IE_HDR.size <= len(buf):
        ident, length = IE_HDR.unpack_from(buf, off)
        off += IE_HDR.size
        if length > len(buf) - off:
            raise ValueError(f"truncated IE id={ident} len={length}")
        yield ident, buf[off:off + length]
        off += (length + 3) & ~3


def extract(src: Path):
    data = src.read_bytes()
    if not data.startswith(MAGIC):
        raise ValueError(f"{src}: bad board-2.bin magic")
    outer = list(parse_ies(data[MAGIC_LEN:]))
    name_id = data_id = payload = None
    for ident, body in outer:
        for iid, idata in parse_ies(body):
            if name_id is None:
                name_id = iid
            elif data_id is None:
                data_id, payload = iid, idata
    if payload is None:
        raise ValueError(f"{src}: no BOARD_DATA IE found")
    return name_id, data_id, payload


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--name", action="append", required=True,
                    help="board name to publish the payload under (repeatable)")
    args = ap.parse_args()

    name_id, data_id, payload = extract(args.src)
    body = b"".join(ie(name_id, n.encode()) + ie(data_id, payload)
                    for n in args.name)
    out = MAGIC.ljust(MAGIC_LEN, b"\x00") + ie(0, body)
    args.dst.parent.mkdir(parents=True, exist_ok=True)
    args.dst.write_bytes(out)
    print(f"{args.src.name} -> {args.dst}: {len(out)} bytes, "
          f"{len(args.name)} names, payload {len(payload)} bytes")
    for n in args.name:
        print(f"  {n}")


if __name__ == "__main__":
    main()
