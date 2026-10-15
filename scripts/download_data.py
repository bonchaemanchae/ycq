"""Download TLC yellow taxi trip files and the zone lookup/shapefile into data/.

Usage:
    python scripts/download_data.py                 # zones + 2026-01
    python scripts/download_data.py --months 2026-01 2026-02 2026-03
"""
import argparse
import hashlib
import sys
import zipfile
from pathlib import Path

import requests

BASE = "https://d37ci6vzurychx.cloudfront.net"
DATA = Path(__file__).resolve().parent.parent / "data"

# Known checksums (prefix is enough to catch a wrong or changed file). The zone
# files are pinned too: TLC has changed them before, which would silently
# shift zone counts.
KNOWN_SHA256 = {
    "yellow_tripdata_2026-01.parquet": "8b3933fe6f0d7b6d",
    "yellow_tripdata_2026-02.parquet": "5352ca800f29c40a",
    "yellow_tripdata_2026-03.parquet": "d7af794a7ac06cbb",
    "taxi_zone_lookup.csv": "1a99e105092230f8",
    "taxi_zones.zip": "f6d711917bb4340f",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    if dest.exists():
        print(f"  have {dest.name}")
        return
    print(f"  downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(dest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", "--month", nargs="*", default=["2026-01"])
    args = ap.parse_args()

    (DATA / "zones").mkdir(parents=True, exist_ok=True)
    (DATA / "trips").mkdir(parents=True, exist_ok=True)

    print("zones")
    lookup = DATA / "zones" / "taxi_zone_lookup.csv"
    fetch(f"{BASE}/misc/taxi_zone_lookup.csv", lookup)
    zip_path = DATA / "zones" / "taxi_zones.zip"
    fetch(f"{BASE}/misc/taxi_zones.zip", zip_path)
    if not (verify(lookup) & verify(zip_path)):
        print("zone files differ from the pinned ones; nothing was extracted", file=sys.stderr)
        return 1
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            # flatten: the zip nests files in a taxi_zones/ folder
            fname = Path(name).name
            if not fname or name.endswith("/"):
                continue
            target = DATA / "zones" / fname
            if not target.exists():
                target.write_bytes(z.read(name))

    ok = True
    for month in args.months:
        name = f"yellow_tripdata_{month}.parquet"
        dest = DATA / "trips" / name
        print(name)
        fetch(f"{BASE}/trip-data/{name}", dest)
        ok &= verify(dest)
    return 0 if ok else 1


def verify(path: Path) -> bool:
    """Check a file against KNOWN_SHA256. A file that differs is moved aside
    (renamed to .mismatch) so it can't be loaded by mistake."""
    digest = sha256(path)
    expected = KNOWN_SHA256.get(path.name)
    status, ok = "", True
    if expected:
        if digest.startswith(expected):
            status = "OK"
        else:
            bad = path.with_name(path.name + ".mismatch")
            path.replace(bad)
            status = f"MISMATCH (expected {expected}...), moved to {bad.name}"
            ok = False
    print(f"  {path.name} sha256 {digest} {status}")
    return ok


if __name__ == "__main__":
    sys.exit(main())
