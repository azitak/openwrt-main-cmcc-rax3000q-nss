#!/usr/bin/env python3
"""Resolve every &label in the board DTS against the labels that exist.

A build that fails here fails at minute 95, in dtc, after the kernel, the
toolchain and every package have been built:

    ipq5018.dtsi: ERROR (phandle_references): /soc@0/wifi@c000000:
        Reference to non-existent node or label "q6_wcss_pd1"

That is exactly what happened once: the board DTS was taken from upstream
OpenWrt, where the Q6 still has q6_wcss_pd1/q6_wcss_pd2, while this kernel has
a single q6v5_wcss rproc. dtc says so in a second - it just says it last.

This script does the same check in a second, as text: collect every label
defined in the given directories (dtc label syntax, `foo: node {`), plus the
labels added by kernel patch files, then compare with the board DTS.

Usage:
    check-dts-labels.py <board.dts> <dir-or-file>...

Directories are searched for *.dts and *.dtsi; *.patch files are read for
added `+	label: ...` lines.  Exit status 1 lists the unresolved labels.
"""
import os
import re
import sys

LABEL_DEF = re.compile(r'^\s*([a-z_][a-z0-9_]*):\s', re.M)
LABEL_NODE = re.compile(r'([a-z_][a-z0-9_]*):\s*[a-zA-Z0-9,._@+-]+\s*\{')
PATCH_LABEL = re.compile(r'^\+\s*([a-z_][a-z0-9_]*):\s*[a-zA-Z0-9,._@+-]+\s*\{', re.M)
COMMENT = re.compile(r'/\*.*?\*/', re.S)
LINE_COMMENT = re.compile(r'^\s*//.*$', re.M)
REF = re.compile(r'&([a-z_][a-z0-9_]*)')


def read(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


def strip_comments(text):
    return LINE_COMMENT.sub('', COMMENT.sub('', text))


def collect(paths):
    labels = set()
    for path in paths:
        if os.path.isdir(path):
            for root, _dirs, files in os.walk(path):
                for name in files:
                    full = os.path.join(root, name)
                    if name.endswith(('.dts', '.dtsi')):
                        text = read(full)
                        labels |= set(LABEL_DEF.findall(text))
                        labels |= set(LABEL_NODE.findall(text))
                    elif name.endswith('.patch'):
                        labels |= set(PATCH_LABEL.findall(read(full)))
        elif path.endswith('.patch'):
            labels |= set(PATCH_LABEL.findall(read(path)))
        else:
            text = read(path)
            labels |= set(LABEL_DEF.findall(text))
            labels |= set(LABEL_NODE.findall(text))
    return labels


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2

    board = argv[1]
    src = strip_comments(read(board))
    local = set(LABEL_DEF.findall(src)) | set(LABEL_NODE.findall(src))
    refs = sorted(set(REF.findall(src)))
    defined = collect(argv[2:]) | local

    print(f'{os.path.basename(board)}: {len(refs)} &references, '
          f'{len(defined)} labels known')

    # Properties that are plain strings or numbers can look like references
    # only inside comments, which are stripped above; anything left is a real
    # node reference.
    missing = [r for r in refs if r not in defined]
    if missing:
        print('UNRESOLVED node references:')
        for r in missing:
            print(f'  &{r}')
        print('\ndtc would fail with "Reference to non-existent node or label".')
        return 1

    if src.count('{') != src.count('}'):
        print(f'brace imbalance: {src.count("{")} "{{" vs {src.count("}")} "}}"')
        return 1

    print('all references resolve, braces balanced')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
