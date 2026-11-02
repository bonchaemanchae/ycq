"""Load test: how many requests a second the running API handles at once.

    docker compose build loader
    docker compose run --rm loader python etl/load_test.py
    docker compose run --rm loader python etl/load_test.py --users 1 10 --seconds 10

Each simulated user sends one request after another, waiting for each answer,
through the real login, role checks and limited database logins. Everything
here only reads, so no data changes. Every question is run at every number of
users, and the script reports requests per second, the median and 95th
percentile response time, and failures.

It logs in as the analyst1 account (YCQ_ANALYST1_PASSWORD), or --email with
LOAD_TEST_PASSWORD. The API and this script share one machine, so compare the
ratios rather than quoting the absolute numbers.
"""
import argparse
import os
import statistics
import sys
import threading
import time

import httpx

from benchmark import percentile

ALL_MONTHS = "dateFrom=2026-01-01&dateTo=2026-03-31"

# name, method, path, JSON body (filled in at the start where it needs ids)
QUESTIONS = [
    ("Map, daily summary", "GET", f"/dashboard?{ALL_MONTHS}", None),
    ("Map, hourly data", "GET", f"/dashboard?{ALL_MONTHS}&hourFrom=7&hourTo=19", None),
    ("Weekday chart", "GET", f"/dashboard/weekdays?{ALL_MONTHS}", None),
    ("Flow Explorer", "GET", "/flows?originZoneId=161&month=2026-03&dayType=weekday&timeBucket=am_peak", None),
    ("Planner preview", "POST", "/plans/preview", "planner"),
]


def log_in(client: httpx.Client, email: str, password: str) -> dict:
    r = client.post("/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        sys.exit(f"login failed for {email}: {r.status_code}")
    return {"Authorization": f"Bearer {r.json()['token']}"}


def user(url: str, headers: dict, method: str, path: str, body, stop_at: float,
         start: threading.Barrier, times: list, failures: list) -> None:
    """One simulated user: send, wait for the answer, send again until stop_at."""
    with httpx.Client(base_url=url, headers=headers, timeout=120) as client:
        start.wait()
        while time.perf_counter() < stop_at:
            t0 = time.perf_counter()
            try:
                ok = client.request(method, path, json=body).status_code == 200
            except httpx.HTTPError:
                ok = False
            (times if ok else failures).append((time.perf_counter() - t0) * 1000)


def run(url: str, headers: dict, question: tuple, users: int, seconds: float) -> dict:
    _, method, path, body = question
    times, failures = [], []
    start = threading.Barrier(users + 1)
    stop_at = time.perf_counter() + seconds + 1
    threads = [threading.Thread(target=user, args=(url, headers, method, path, body, stop_at,
                                                   start, times, failures)) for _ in range(users)]
    for t in threads:
        t.start()
    start.wait()
    t0 = time.perf_counter()
    for t in threads:
        t.join()
    elapsed = time.perf_counter() - t0
    return {"users": users, "rps": len(times) / elapsed, "failed": len(failures),
            "median": statistics.median(times) if times else 0,
            "p95": percentile(times, 95) if times else 0}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://api:8000", help="the API (default http://api:8000)")
    ap.add_argument("--users", type=int, nargs="+", default=[1, 5, 10, 20, 50, 80],
                    help="numbers of simultaneous users (default 1 5 10 20 50 80)")
    ap.add_argument("--seconds", type=float, default=15, help="seconds per run (default 15)")
    ap.add_argument("--email", default="analyst1@ycq.local")
    ap.add_argument("--only", help="run only the questions whose name contains this")
    args = ap.parse_args()
    password = os.getenv("LOAD_TEST_PASSWORD") or os.getenv("YCQ_ANALYST1_PASSWORD")
    if not password:
        sys.exit("set LOAD_TEST_PASSWORD, or YCQ_ANALYST1_PASSWORD in .env")

    with httpx.Client(base_url=args.url, timeout=30) as client:
        headers = log_in(client, args.email, password)
        boroughs = client.get("/boroughs", headers=headers).json()
    manhattan = next(b["borough_id"] for b in boroughs if b["name"] == "Manhattan")
    plan = {"fleet_size": 50, "iso_dow": 1, "start_hour": 7, "end_hour": 9, "borough_ids": [manhattan]}

    print(f"{args.seconds:.0f} seconds per run, one API process, {os.cpu_count()} CPUs in this container\n")
    print(f"{'question':<22}{'users':>6}{'req/s':>9}{'median ms':>11}{'p95 ms':>9}{'failed':>8}")
    for question in QUESTIONS:
        name, method, path, body = question
        if args.only and args.only.lower() not in name.lower():
            continue
        for users in args.users:
            q = (name, method, path, plan if body == "planner" else None)
            r = run(args.url, headers, q, users, args.seconds)
            print(f"{name:<22}{r['users']:>6}{r['rps']:>9.1f}{r['median']:>11.1f}{r['p95']:>9.1f}"
                  f"{r['failed']:>8}", flush=True)
            time.sleep(1)


if __name__ == "__main__":
    main()
