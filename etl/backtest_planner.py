"""Backtest the Allocation Planner: learn from earlier months, score on a later one.

    python etl/backtest_planner.py                       # learn Jan-Feb, test March 2026
    python etl/backtest_planner.py --fleets 50 200 500

Is the planner's advice any good? Each plan is made from the training months
only, then judged on the test month, which it never saw. Nothing is saved.

The real planner code runs unchanged. It reads zone_hour_observation and
zone_weekday_hour_fare; this script creates temporary tables with those names
holding the training months only, which PostgreSQL finds first for this one
connection, so no test-month number can reach a plan.

For every weekday and hour, the same fleet goes to the same number of zones:

    Planner         the planner with its default weights
    Busiest zones   the zones with the most training pickups, taxis in proportion
    Random zones    random eligible zones, equal taxis (a plan that uses no data)

Each is scored on the test month, summed over every weekday and hour:

    Coverage        share of pickups that started in a zone given taxis
    Fit             how closely taxi shares match pickup shares (100% = identical)
    Shortages       share of the shortage (pickups above drop-offs, by zone)
                    that is in zones given taxis
    Taxis in use    share of taxis that would have a pickup that hour, per date

The data shows trips that happened, not where taxis waited or which passengers
were missed, so this measures how well a plan matched demand, not profit.
"""
import argparse
import random
import sys
from collections import defaultdict
from datetime import date

from common import ROOT, parse_month, pg_connect

sys.path.insert(0, str(ROOT))
from api import planner  # noqa: E402

RANDOM_DRAWS = 100
METRICS = ("Coverage", "Fit", "Shortages", "Taxis in use")

# The same fare rules as zone_weekday_hour_fare (sql/010), for the training months.
TRAINING_FARES_SQL = """
CREATE TEMP TABLE zone_weekday_hour_fare AS
SELECT t.pickup_location_id                                        AS location_id,
       extract(isodow FROM t.pickup_ts)::smallint                  AS iso_dow,
       extract(hour FROM t.pickup_ts)::smallint                    AS local_hour,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY t.fare_amount)::numeric(12,2)
                                                                   AS median_fare
FROM trip t
LEFT JOIN v_trip_flags f USING (import_batch_id, source_row_number, pickup_ts)
WHERE t.pickup_ts < %(cut)s
  AND t.payment_type_id <> 0
  AND t.fare_amount > 0
  AND NOT coalesce(f.skip_fare, false)
  AND NOT coalesce(f.skip_all, false)
GROUP BY 1, 2, 3
"""


def use_training_months(conn, cut: date) -> int:
    """Hide everything from `cut` onwards from this connection's planner
    queries. Returns the training rows; fails if a later row got through."""
    conn.execute("""CREATE TEMP TABLE zone_hour_observation AS
                    SELECT * FROM public.zone_hour_observation WHERE obs_hour < %s""", (cut,))
    conn.execute(TRAINING_FARES_SQL, {"cut": cut})
    (rows, latest) = conn.execute("SELECT count(*), max(obs_hour) FROM zone_hour_observation").fetchone()
    if rows == 0 or latest.date() >= cut:
        sys.exit(f"training data is wrong: {rows} rows up to {latest}")
    return rows


def fair_split(weights: dict[int, float], fleet: int) -> dict[int, int]:
    """Whole taxis in proportion to weight, adding up to exactly `fleet`: the
    largest-remainder method, as the planner uses (ties by weight, then zone)."""
    total = sum(weights.values())
    if total <= 0:
        weights, total = {z: 1.0 for z in weights}, float(len(weights))
    exact = {z: fleet * w / total for z, w in weights.items()}
    taxis = {z: int(e) for z, e in exact.items()}
    spare = fleet - sum(taxis.values())
    order = sorted(exact, key=lambda z: (-(exact[z] - taxis[z]), -weights[z], z))
    for z in order[:spare]:
        taxis[z] += 1
    return taxis


def test_month_actuals(conn, start: date, end: date, zones: set[int]) -> dict:
    """(weekday, hour) -> pickups and net shortage per zone, and pickups per
    date and zone, for the test month."""
    actual = defaultdict(lambda: {"pickups": defaultdict(int), "net": defaultdict(int),
                                  "dates": defaultdict(dict)})
    for dow, hour, day, zone, pickups, dropoffs in conn.execute(
            """SELECT iso_dow, local_hour, local_date, location_id, pickups, dropoffs
               FROM public.zone_hour_observation
               WHERE obs_hour >= %s AND obs_hour < %s""", (start, end)):
        if zone in zones:
            a = actual[(dow, hour)]
            a["pickups"][zone] += pickups
            a["net"][zone] += pickups - dropoffs
            a["dates"][day][zone] = pickups
    return actual


def measure(taxis: dict[int, int], a: dict) -> dict[str, tuple[float, float]]:
    """Each metric as (numerator, denominator), so hours can be added up."""
    pickups, net = a["pickups"], a["net"]
    used = {z for z, t in taxis.items() if t > 0}
    fleet = sum(taxis.values())
    total = sum(pickups.values())
    fit = sum(min(taxis.get(z, 0) / fleet, p / total) for z, p in pickups.items()) if fleet and total else 0
    in_use = sum(min(taxis.get(z, 0), by_zone.get(z, 0)) for by_zone in a["dates"].values() for z in used)
    return {
        "Coverage": (sum(pickups[z] for z in used if z in pickups), total),
        "Fit": (fit * total, total),                   # weighted by the hour's pickups
        "Shortages": (sum(net[z] for z in used if net.get(z, 0) > 0),
                      sum(n for n in net.values() if n > 0)),
        "Taxis in use": (in_use, fleet * len(a["dates"])),
    }


def add(totals: dict, result: dict, scale: float = 1.0) -> None:
    for metric, (top, bottom) in result.items():
        totals[metric][0] += top * scale
        totals[metric][1] += bottom * scale


def share(totals: dict, metric: str) -> float:
    top, bottom = totals[metric]
    return 100 * top / bottom if bottom else 0.0


def backtest(conn, boroughs: list[int], fleet: int, actual: dict, rng: random.Random) -> dict:
    """One scope and fleet size over every weekday and hour."""
    totals = {m: {metric: [0.0, 0.0] for metric in METRICS}
              for m in ("Planner", "Busiest zones", "Random zones")}
    hours = wins = 0
    for dow in range(1, 8):
        params = planner.PlanParams(fleet_size=fleet, iso_dow=dow, start_hour=0, end_hour=23,
                                    borough_ids=boroughs)
        by_hour = defaultdict(list)
        for row in planner.score(conn, params):
            by_hour[row["hour"]].append(row)
        for hour, rows in by_hour.items():
            a = actual.get((dow, hour))
            if a is None or not sum(a["pickups"].values()):
                continue
            n = sum(r["selected"] for r in rows)
            eligible = [r["location_id"] for r in rows]
            busiest = sorted(rows, key=lambda r: (-r["avg_pickups"], r["location_id"]))[:n]
            planned = {r["location_id"]: r["proposed_taxis"] for r in rows if r["selected"]}
            ours = measure(planned, a)
            theirs = measure(fair_split({r["location_id"]: float(r["avg_pickups"]) for r in busiest}, fleet), a)
            add(totals["Planner"], ours)
            add(totals["Busiest zones"], theirs)
            for _ in range(RANDOM_DRAWS):
                picked = rng.sample(eligible, n)
                add(totals["Random zones"], measure(fair_split({z: 1.0 for z in picked}, fleet), a),
                    1 / RANDOM_DRAWS)
            hours += 1
            wins += ours["Shortages"][0] > theirs["Shortages"][0]
    return {"totals": totals, "hours": hours, "shortage_wins": wins}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test-month", default="2026-03", help="month to score on (default 2026-03)")
    ap.add_argument("--next-month", default="2026-04", help="the month after it (default 2026-04)")
    ap.add_argument("--fleets", type=int, nargs="+", default=[50, 200, 500],
                    help="fleet sizes per hour (default 50 200 500)")
    args = ap.parse_args()
    start, end = parse_month(args.test_month), parse_month(args.next_month)
    rng = random.Random(2003)

    with pg_connect(autocommit=True) as conn:
        print(f"training rows before {start}: {use_training_months(conn, start):,}")
        scopes = {"All boroughs": [b for (b,) in conn.execute(
            """SELECT DISTINCT borough_id FROM taxi_zone WHERE geom IS NOT NULL ORDER BY 1""")]}
        scopes["Manhattan"] = [b for (b,) in conn.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'")]
        for scope, boroughs in scopes.items():
            zones = {z for (z,) in conn.execute(
                "SELECT location_id FROM taxi_zone WHERE geom IS NOT NULL AND borough_id = ANY(%s)", (boroughs,))}
            actual = test_month_actuals(conn, start, end, zones)
            for fleet in args.fleets:
                result = backtest(conn, boroughs, fleet, actual, rng)
                print(f"\n{scope}, fleet {fleet}: {result['hours']} weekday-hours")
                print(f"  {'':<15}" + "".join(f"{m:>14}" for m in METRICS))
                for method, totals in result["totals"].items():
                    print(f"  {method:<15}" + "".join(f"{share(totals, m):>13.1f}%" for m in METRICS))
                print(f"  Planner covers more shortage than Busiest zones in "
                      f"{result['shortage_wins']} of {result['hours']} weekday-hours")


if __name__ == "__main__":
    main()
