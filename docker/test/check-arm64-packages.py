#!/usr/bin/env python3
"""Check every apt package this image installs against the Debian arm64 indexes.

The Dockerfile is architecture-neutral: it never pins a platform, and both the
Node base image and the package list are resolved inside the target-architecture
build. This script gives the arm64 half of that claim a cheap, network-only
check that does not need an arm64 host or QEMU.

    python3 docker/test/check-arm64-packages.py
    python3 docker/test/check-arm64-packages.py --mirror https://deb.debian.org/debian

Exit code 0 means every requested package is available for arm64 (or is
architecture-independent, present in ``binary-all``).
"""

from __future__ import annotations

import argparse
import lzma
import re
import sys
import urllib.request

DEFAULT_DEBIAN = "https://deb.debian.org/debian"
DEFAULT_SECURITY = "https://deb.debian.org/debian-security"

# Packages the runtime stage installs, plus the builder stage's toolchain.
REQUIRED_PACKAGES = """
bash bash-completion ca-certificates curl wget vim nano less coreutils findutils
grep sed gawk diffutils tar gzip xz-utils bzip2 unzip zip procps psmisc htop
tree file bc jq git openssh-client net-tools netcat-openbsd iproute2
iputils-ping dnsutils lsof tmux rsync ripgrep fd-find bat
python3 make g++ pkg-config
""".split()


def index_urls(debian: str, security: str) -> list[tuple[str, str]]:
    """Return the (url, label) pairs covering bookworm main and security for arm64."""
    debian = debian.rstrip("/")
    security = security.rstrip("/")
    return [
        (f"{debian}/dists/bookworm/main/binary-arm64/Packages.xz", "bookworm/main arm64"),
        (f"{debian}/dists/bookworm/main/binary-all/Packages.xz", "bookworm/main all"),
        (f"{debian}/dists/bookworm-updates/main/binary-arm64/Packages.xz", "bookworm-updates/main arm64"),
        (f"{security}/dists/bookworm-security/main/binary-arm64/Packages.xz", "bookworm-security/main arm64"),
        (f"{security}/dists/bookworm-security/main/binary-all/Packages.xz", "bookworm-security/main all"),
    ]


def collect_names(urls: list[tuple[str, str]]) -> set[str]:
    """Download and index the package names of every Packages.xz given."""
    available: set[str] = set()
    for url, label in urls:
        try:
            with urllib.request.urlopen(url, timeout=180) as response:
                raw = response.read()
        except Exception as error:  # noqa: BLE001 - reported, not raised
            print(f"  ! could not read {label}: {error}")
            continue
        names = set(re.findall(rb"^Package: (\S+)$", lzma.decompress(raw), re.M))
        print(f"  {label}: {len(names)} packages")
        available |= {name.decode() for name in names}
    return available


def main() -> int:
    """Report whether every required package exists for arm64."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mirror", default=DEFAULT_DEBIAN, help="Debian archive root")
    parser.add_argument("--security-mirror", default=DEFAULT_SECURITY, help="Debian security archive root")
    args = parser.parse_args()

    print("reading Debian arm64 package indexes")
    available = collect_names(index_urls(args.mirror, args.security_mirror))
    missing = [name for name in REQUIRED_PACKAGES if name not in available]

    print(f"\nchecked {len(REQUIRED_PACKAGES)} packages against the arm64 indexes")
    if missing:
        print(f"MISSING on arm64: {' '.join(missing)}")
        return 1
    print("AVAILABLE on arm64: all requested packages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
