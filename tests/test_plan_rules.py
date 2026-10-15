"""Rules the database enforces on saved allocation plans.

Each test runs in a transaction that is rolled back, so nothing is kept.
SET CONSTRAINTS ALL IMMEDIATE makes the deferred triggers fire straight away.
"""
import psycopg
import pytest

from conftest import pg_connect


@pytest.fixture
def plan(loaded):
    conn = pg_connect()
    conn.execute(
        "INSERT INTO app_user (email, display_name, password_hash) VALUES ('t@test', 'T', 'x')"
    )
    plan_id = conn.execute(
        """INSERT INTO allocation_plan (owner_user_id, name)
           SELECT user_id, 'Test plan' FROM app_user WHERE email = 't@test'
           RETURNING allocation_plan_id"""
    ).fetchone()[0]
    yield conn, plan_id
    conn.rollback()
    conn.close()


def save(conn, plan_id, results, fleet=3, hours=(8, 9), borough="Manhattan"):
    """Save version 1 with results [(hour, zone, taxis)] and check it now."""
    conn.execute(
        """INSERT INTO allocation_plan_version
               (allocation_plan_id, version_no, fleet_size, iso_dow, start_hour, end_hour)
           VALUES (%s, 1, %s, 1, %s, %s)""",
        (plan_id, fleet, *hours),
    )
    conn.execute(
        """INSERT INTO allocation_plan_version_borough
           SELECT %s, 1, borough_id FROM borough WHERE name = %s""",
        (plan_id, borough),
    )
    for rank, (hour, zone, taxis) in enumerate(results, start=1):
        conn.execute(
            """INSERT INTO allocation_result VALUES (%s, 1, %s, %s, %s, %s, 0.5, %s, 30, 'test')""",
            (plan_id, hour, zone, taxis, taxis, rank),
        )
    conn.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_complete_plan_saves(plan):
    conn, plan_id = plan
    save(conn, plan_id, [(8, 1, 2), (8, 2, 1), (9, 1, 3)])


def test_hour_not_adding_up_to_fleet_is_refused(plan):
    conn, plan_id = plan
    with pytest.raises(psycopg.errors.CheckViolation, match="add up to 2"):
        save(conn, plan_id, [(8, 1, 2), (9, 1, 3)])


def test_missing_hour_is_refused(plan):
    conn, plan_id = plan
    with pytest.raises(psycopg.errors.CheckViolation, match=r"no allocations for hour\(s\) 9"):
        save(conn, plan_id, [(8, 1, 3)])


def test_hour_outside_plan_is_refused(plan):
    conn, plan_id = plan
    with pytest.raises(psycopg.errors.CheckViolation, match="outside the plan hours"):
        save(conn, plan_id, [(8, 1, 3), (9, 1, 3), (10, 1, 3)])


def test_negative_taxis_are_refused(plan):
    conn, plan_id = plan
    with pytest.raises(psycopg.errors.CheckViolation):
        save(conn, plan_id, [(8, 1, 4), (8, 2, -1), (9, 1, 3)])


def test_deleting_saved_results_is_refused(plan):
    conn, plan_id = plan
    save(conn, plan_id, [(8, 1, 3), (9, 1, 3)])
    with pytest.raises(psycopg.errors.CheckViolation, match="can't be changed"):
        conn.execute("DELETE FROM allocation_result WHERE allocation_plan_id = %s AND hour = 9",
                     (plan_id,))


@pytest.mark.parametrize("sql", [
    # the review's example: a saved version edited into breaking its own rules
    "UPDATE allocation_plan_version SET fleet_size = 50 WHERE allocation_plan_id = %s",
    "UPDATE allocation_plan_version SET end_hour = 12 WHERE allocation_plan_id = %s",
    "UPDATE allocation_result SET final_taxis = 0 WHERE allocation_plan_id = %s",
    "UPDATE allocation_plan_version_borough SET borough_id = borough_id WHERE allocation_plan_id = %s",
    "DELETE FROM allocation_plan_version_borough WHERE allocation_plan_id = %s",
    "DELETE FROM allocation_plan_version WHERE allocation_plan_id = %s",
])
def test_saved_versions_cannot_be_changed(plan, sql):
    conn, plan_id = plan
    save(conn, plan_id, [(8, 1, 3), (9, 1, 3)])
    with pytest.raises(psycopg.errors.CheckViolation, match="can't be (changed|deleted on its own)"):
        conn.execute(sql, (plan_id,))


def test_deleting_the_plan_still_removes_its_versions(plan):
    conn, plan_id = plan
    save(conn, plan_id, [(8, 1, 3), (9, 1, 3)])
    conn.execute("DELETE FROM allocation_plan WHERE allocation_plan_id = %s", (plan_id,))
    for table in ("allocation_plan_version", "allocation_plan_version_borough", "allocation_result"):
        assert conn.execute(f"SELECT count(*) FROM {table} WHERE allocation_plan_id = %s",
                            (plan_id,)).fetchone()[0] == 0


def test_zone_outside_the_plans_boroughs_is_refused(plan):
    conn, plan_id = plan
    # The version only allows "Unknown"; zone 1 is in Manhattan.
    with pytest.raises(psycopg.errors.CheckViolation, match="zone 1 is not in the plan's boroughs"):
        save(conn, plan_id, [(8, 1, 3), (9, 1, 3)], borough="Unknown")


def test_zone_without_a_map_shape_is_refused(plan):
    conn, plan_id = plan
    # Zone 264 is in the Unknown borough and has no shape.
    with pytest.raises(psycopg.errors.CheckViolation, match="zone 264 .* no map shape"):
        save(conn, plan_id, [(8, 264, 3), (9, 264, 3)], borough="Unknown")


def test_weights_must_add_up_to_one(plan):
    conn, plan_id = plan
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            """INSERT INTO allocation_plan_version
                   (allocation_plan_id, version_no, fleet_size, iso_dow, start_hour, end_hour, w_pickup)
               VALUES (%s, 1, 3, 1, 8, 9, 0.9)""",
            (plan_id,),
        )


def test_plan_names_unique_per_user(plan):
    conn, plan_id = plan
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            """INSERT INTO allocation_plan (owner_user_id, name)
               SELECT owner_user_id, name FROM allocation_plan WHERE allocation_plan_id = %s""",
            (plan_id,),
        )
