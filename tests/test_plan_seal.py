"""The hash chain over saved plan versions (sql/017).

Versions are saved through the real planner on a committing connection, as
the API does, because a version is sealed when its transaction commits. The
tampering is done the way a database owner could: switch an immutability
trigger off, change a row, switch it back on.
"""
import sys

import psycopg
import pytest

from conftest import ROOT, login

sys.path.insert(0, str(ROOT))
from api import planner  # noqa: E402

CHECK = "SELECT version_no, problem FROM plan_seal_check(%s) ORDER BY version_no"
ADD_NOTE = "UPDATE allocation_plan_version SET note = 'approved' WHERE allocation_plan_id = %s AND version_no = 2"


@pytest.fixture
def chain(db, make_user):
    """A plan with three saved versions. Returns (owner, plan_id)."""
    owner = make_user("sealer@test.local", "analyst")
    manhattan = db.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()[0]
    plan_id = planner.create_plan(db, owner, "Sealed plan")
    for fleet in (7, 8, 9):
        planner.save_version(db, owner, plan_id, planner.PlanParams(
            fleet_size=fleet, iso_dow=1, start_hour=8, end_hour=9, borough_ids=[manhattan],
            max_zones_per_hour=2, min_sample=0))
    return owner, plan_id


def behind_the_triggers(db, table, statement, params):
    """Run one statement on `table` with its immutability trigger switched off."""
    db.execute(f"ALTER TABLE {table} DISABLE TRIGGER {table}_immutable")
    try:
        db.execute(statement, params)
    finally:
        db.execute(f"ALTER TABLE {table} ENABLE TRIGGER {table}_immutable")


def test_every_version_is_sealed_and_follows_the_one_before(db, chain):
    _, plan_id = chain
    seals = db.execute(
        """SELECT version_no, prev_hash, hash FROM allocation_plan_version_seal
           WHERE allocation_plan_id = %s ORDER BY version_no""", (plan_id,)).fetchall()
    assert [s[0] for s in seals] == [1, 2, 3]
    assert seals[0][1] is None                                    # the first has nothing before it
    assert [s[1] for s in seals[1:]] == [s[2] for s in seals[:-1]]
    assert len({s[2] for s in seals}) == 3 and all(len(s[2]) == 64 for s in seals)
    assert db.execute(CHECK, (plan_id,)).fetchall() == [(1, None), (2, None), (3, None)]


def test_the_hash_does_not_depend_on_the_session(db, chain):
    _, plan_id = chain
    with db.transaction(force_rollback=True):
        db.execute("SET LOCAL TIME ZONE 'Asia/Singapore'")
        db.execute("SET LOCAL DateStyle = 'German'")
        assert all(problem is None for _, problem in db.execute(CHECK, (plan_id,)))


@pytest.mark.parametrize("table, statement", [
    ("allocation_result",
     """UPDATE allocation_result SET reason = 'edited later'
        WHERE (allocation_plan_id, version_no, hour, location_id) =
              (SELECT allocation_plan_id, version_no, hour, location_id FROM allocation_result
               WHERE allocation_plan_id = %s AND version_no = 2 LIMIT 1)"""),
    ("allocation_plan_version", ADD_NOTE),
    ("allocation_plan_version_borough",
     """UPDATE allocation_plan_version_borough
        SET borough_id = (SELECT borough_id FROM borough WHERE name = 'Unknown')
        WHERE allocation_plan_id = %s AND version_no = 2"""),
])
def test_a_change_behind_the_triggers_is_detected(db, chain, table, statement):
    owner, plan_id = chain
    behind_the_triggers(db, table, statement, (plan_id,))
    assert db.execute(CHECK, (plan_id,)).fetchall() == [
        (1, None), (2, "changed after it was saved"), (3, None)]
    # The Planner's version list and the Administration check both say so.
    listed = {v["version_no"]: v["seal_problem"] for v in planner.list_versions(db, owner, plan_id)}
    assert listed == {1: None, 2: "changed after it was saved", 3: None}
    assert {"allocation_plan_id": plan_id, "version_no": 2,
            "problem": "changed after it was saved"} in planner.check_seals(db)["problems"]


def test_resealing_a_changed_version_breaks_the_chain(db, chain):
    """Covering the change by giving version 2 a matching seal shows at
    version 3, which still names the old hash."""
    _, plan_id = chain
    behind_the_triggers(db, "allocation_plan_version", ADD_NOTE, (plan_id,))
    behind_the_triggers(
        db, "allocation_plan_version_seal",
        """UPDATE allocation_plan_version_seal
           SET hash = plan_version_hash(allocation_plan_id, version_no, prev_hash)
           WHERE allocation_plan_id = %s AND version_no = 2""", (plan_id,))
    assert db.execute(CHECK, (plan_id,)).fetchall() == [
        (1, None), (2, None), (3, "does not follow the version before it")]


def test_a_sealed_version_takes_no_more_rows(db, chain):
    _, plan_id = chain
    with pytest.raises(psycopg.errors.CheckViolation, match="is sealed"):
        # 0 taxis, so the hour still adds up to the fleet
        db.execute("""INSERT INTO allocation_result
                      VALUES (%s, 1, 8, 3, 0, 0, 0.1, 3, 0, 'slipped in')""", (plan_id,))
    with pytest.raises(psycopg.errors.CheckViolation, match="is sealed"):
        db.execute("""INSERT INTO allocation_plan_version_borough
                      SELECT %s, 1, borough_id FROM borough WHERE name = 'Unknown'""", (plan_id,))


@pytest.mark.parametrize("statement", [
    "UPDATE allocation_plan_version_seal SET hash = repeat('0', 64) WHERE allocation_plan_id = %s",
    "DELETE FROM allocation_plan_version_seal WHERE allocation_plan_id = %s",
])
def test_seals_cannot_be_changed_or_deleted_on_their_own(db, chain, statement):
    _, plan_id = chain
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(statement, (plan_id,))


def test_deleting_the_plan_removes_its_seals(db, chain):
    owner, plan_id = chain
    planner.delete_plan(db, owner, plan_id)
    assert db.execute("SELECT count(*) FROM allocation_plan_version_seal WHERE allocation_plan_id = %s",
                      (plan_id,)).fetchone()[0] == 0


def test_a_version_that_is_refused_is_not_sealed(db, make_user):
    owner = make_user("sealer2@test.local", "analyst")
    manhattan = db.execute("SELECT borough_id FROM borough WHERE name = 'Manhattan'").fetchone()[0]
    plan_id = planner.create_plan(db, owner, "Refused")
    with pytest.raises(planner.PlanError):
        # the edit leaves hour 8 one taxi over the fleet
        planner.save_version(db, owner, plan_id, planner.PlanParams(
            fleet_size=7, iso_dow=1, start_hour=8, end_hour=9, borough_ids=[manhattan],
            max_zones_per_hour=2, min_sample=0), overrides={(8, 1): 8})
    assert db.execute("SELECT count(*) FROM allocation_plan_version_seal WHERE allocation_plan_id = %s",
                      (plan_id,)).fetchone()[0] == 0


def test_routes_report_the_seals(client, db, chain, make_user):
    _, plan_id = chain
    make_user("sealadmin@test.local", "admin")
    versions = client.get(f"/plans/{plan_id}/versions", headers=login(client, "sealer@test.local")).json()
    assert all(len(v["hash"]) == 64 and v["seal_problem"] is None for v in versions)
    admin = login(client, "sealadmin@test.local")
    before = client.get("/admin/plan-seals", headers=admin).json()
    assert before["versions"] >= 3 and before["problems"] == []
    behind_the_triggers(db, "allocation_plan_version", ADD_NOTE, (plan_id,))
    assert client.get("/admin/plan-seals", headers=admin).json()["problems"] == [
        {"allocation_plan_id": plan_id, "version_no": 2, "problem": "changed after it was saved"}]
