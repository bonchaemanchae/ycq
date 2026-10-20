# Login, Roles and Cross-Database User Deletion

**Project:** Yellow Cab Query (YCQ / Traxio), INF2003 Database Systems, Team 24  
**Branch:** `feature/login-roles`  
**Master plan items delivered:** Login and roles (section 3.1), Authentication,
Authorization and User deletion (section 10.2), the planned `/api/auth/*` routes
(section 8.6), and the cross-database ownership decision (section 10.3)

---

## 1. Summary

The application previously treated every request as one shared development user
(`dev@ycq.local`), stored no real passwords and had no way to delete a user.
This work adds:

| Area | Result |
| --- | --- |
| Login | Email and password login with **Argon2id** hashes, returning an **8-hour JWT**. |
| Roles | Every route is protected: public, any role (analyst or admin), or admin only. |
| Accounts | One admin and two analyst accounts created automatically from `.env`. |
| User deletion | Removes a user from **both databases**: MongoDB saved views, then the PostgreSQL account, with plans removed by cascade. Any failure part way leaves a state the admin can safely retry. |
| Website | Login page, logout, Administration tab shown only to admins, and a Users section with Delete. |

**Evidence:** 39 new automated tests (182 in total, all passing), 13
deliberately injected bugs all caught, a concurrency test, a 16-check live test
against the running containers, browser checks and an independent code review
whose one finding was fixed.

---

## 2. How this ties into the master plan

| Master plan requirement | Where in the plan | What was built | Where | Evidence |
| --- | --- | --- | --- | --- |
| Authentication page and JWT token management | 3.4 Login and roles | Login page; token kept in `sessionStorage` and sent as `Bearer` | `web/src/pages/Login.tsx`, `web/src/api.ts` | Browser checks (section 6.5) |
| Verify an Argon2 password hash and issue a JWT | 8.6 `/api/auth/login` | `POST /auth/login` | `api/auth.py`, `api/routers/auth.py` | `test_auth.py`, live test |
| Return the authenticated user's profile | 8.6 `/api/auth/me` | `GET /auth/me` | `api/routers/auth.py` | `test_auth.py` |
| Distinct analyst/admin permissions; JWT and RBAC in the API | 1.2, 2.3 | Router groups `PUBLIC` / `ANY_ROLE` / `ADMIN_ONLY` | `api/main.py`, `api/auth.py` | Route-coverage test calls every route |
| Boroughs, zones and activity routes require authentication | 8.7 | Geography and dashboard routes now require a role | `api/main.py` | Route-coverage test |
| Remove MongoDB saved views before deleting the PostgreSQL account | 10.2 User deletion, 10.3 | Three-step deletion with retry and last-admin guard | `api/users.py`, `api/routers/users.py` | `test_users.py`, failure injection, live test |
| Saved-view ownership enforced by the application, not a cross-store key | 10.3 | Deleted users lose access at once; their views are removed | `api/users.py` | `test_users.py` |
| Admin capabilities on the Administration page | 1.2, 3.4 | Users section: list accounts, delete with confirmation | `web/src/pages/admin/Users.tsx` | Browser checks |

Out of this scope, and still open in the master plan: PostgreSQL `ycq_read` /
`ycq_write` database roles (section 10.3), the Activity Dashboard, saved-view
buttons, and final benchmarks.

---

## 3. What was built

### 3.1 Passwords: `api/passwords.py`

- **Argon2id** through `argon2-cffi`, using its defaults: the RFC 9106
  low-memory profile of 3 passes, 64 MiB and 4 lanes. One verification takes
  about **51 ms** on the development machine, which is negligible for a person
  logging in but slow for an attacker guessing passwords.
- The parameters are stored inside each hash. If they are raised later, login
  automatically re-hashes old passwords (`needs_rehash`); a test proves this.
- Anything that isn't an Argon2 hash, such as the old dev user's `disabled`,
  simply fails verification instead of crashing.

### 3.2 Tokens and roles: `api/auth.py`, `api/main.py`

- **JWT claims:** only `sub` (the user id), `iat` and `exp`, signed with HS256.
  Decoding accepts only HS256 and requires all three claims.
- **Every request reloads the user and roles from PostgreSQL.** The token proves
  identity only. Removing a role, deactivating or deleting a user therefore takes
  effect on their **next request**, with no token blacklist and no refresh tokens.
- **Access is set per router** in `api/main.py`:

  | Group | Routers | Rule |
  | --- | --- | --- |
  | `PUBLIC` | health, login | No token needed (`/auth/me` checks its own token) |
  | `ANY_ROLE` | zones, dashboard, flows, plans, saved views | Active user with the analyst or admin role |
  | `ADMIN_ONLY` | admin, users | Admin role |

- **Responses:** a missing, invalid or expired token, or an inactive or deleted
  user, gets **401** with `WWW-Authenticate: Bearer`. A valid user without the
  role gets **403**. All login failures return the same **401 "wrong email or
  password"**, and unknown emails still run one Argon2 check, so neither the
  message nor the timing reveals which accounts exist.
- **Secret check:** the API refuses to start if `JWT_SECRET` is shorter than 32
  characters. The example value `change-me` would otherwise let anyone forge an
  admin token.

### 3.3 Default accounts: `scripts/seed_users.py`

Run by the loader on every start, after the schema is applied.

| Account | Role | Password from `.env` |
| --- | --- | --- |
| `admin@ycq.local` | admin | `YCQ_ADMIN_PASSWORD` |
| `analyst1@ycq.local` | analyst | `YCQ_ANALYST1_PASSWORD` |
| `analyst2@ycq.local` | analyst | `YCQ_ANALYST2_PASSWORD` |

- **Idempotent:** a rerun leaves ids and hashes unchanged and creates no
  duplicates. The hash is replaced only when the `.env` password changes.
- **Safe:** every password is checked before anything is written; anything
  shorter than 12 characters or containing `change-me` is refused. An unset
  variable skips that account, so no account exists with a password nobody chose.
- The API container receives these variables as empty strings; only the loader
  needs them.

### 3.4 Deleting a user across two databases: `api/users.py`

PostgreSQL's `ON DELETE CASCADE` removes a user's roles and saved plans, with
their versions, boroughs and results. It cannot reach MongoDB, and the two
databases share no transaction. Deletion therefore runs in three ordered steps:

| Step | Database | Action | If it fails |
| --- | --- | --- | --- |
| 1 | PostgreSQL | Lock active admins, refuse to remove the last one, set `is_active = false` | Nothing has changed |
| 2 | MongoDB | Delete the user's saved views | User is inactive; views and plans are intact → **503, retry** |
| 3 | PostgreSQL | Delete the user; cascade removes roles and plans | User is inactive; views are gone → **503, retry** |

**Why MongoDB comes before the PostgreSQL user:** the PostgreSQL row is the only
handle for a retry. If it were deleted first and MongoDB then failed, the views
would be orphaned: their owner no longer exists and no endpoint can target them,
because a second DELETE returns 404. With this order, every failure leaves an
inactive user whom the admin can simply delete again.

**Why deactivate first:** step 1 immediately blocks the user's login and every
token they hold. It also makes a half-finished deletion visible as "inactive"
in the Users table.

**Views being saved during a deletion:** a request that passed the login check
just before step 1 could otherwise store a view after step 2 and leave an
orphan. To prevent this, `create_view` in `api/saved_views.py` locks the
owner's row (`SELECT … AND is_active FOR SHARE`) until the MongoDB insert
finishes. Step 1's `UPDATE` must wait for that lock, so a save already in
progress is stored before step 2 deletes it, and any save that starts after
step 1 finds the owner inactive and is refused.

**Guards:**

| Situation | Response |
| --- | --- |
| Unknown user | 404 |
| Admin deletes their own account | 409 |
| Target is the last active admin | 409 |
| Analyst calls the endpoint | 403 |

The last-admin rule locks the active admin rows (`SELECT … ORDER BY user_id FOR
UPDATE`), so two admins deleting each other at the same moment take turns. Exactly
one deletion succeeds and the other is refused. Locking in id order prevents
deadlocks.

Every step is logged with the user id and counts, for example:

```text
INFO:     ycq.users: deleting user 7: deactivated
INFO:     ycq.users: deleted user 7: 2 saved views, 1 plans
```

This reuses Caleb's existing `delete_views_for_user()` from `api/saved_views.py`.

### 3.5 Website

- **`web/src/api.ts`:** stores the token in `sessionStorage`, sends it as
  `Authorization: Bearer …`, and on any 401 forgets it and returns to the login
  page.
- **`web/src/App.tsx`:** shows the login page until someone logs in. The header
  shows the email and a Log out button. Administration is hidden from
  non-admins, and `/admin` redirects them to the dashboard. The backend refuses
  them anyway.
- **`web/src/pages/admin/Users.tsx`:** lists accounts with roles, active state
  and plan count. Delete asks for confirmation and reports how many plans and
  views were removed. Your own row shows "you" instead of Delete.

---

## 4. Key decisions and alternatives considered

| Decision | Chosen | Rejected and why |
| --- | --- | --- |
| Password library | `argon2-cffi` directly | `passlib`: unmaintained |
| JWT library | `PyJWT` | `python-jose`: weaker maintenance record |
| Roles in the token? | No, re-read from the database on each request | Roles in claims stay valid until expiry after a demotion or deletion; avoiding that would need a revocation list |
| Token transport | `HTTPBearer` + `sessionStorage` | httpOnly cookie: more resistant to script theft but needs CSRF handling; Bearer also works with `/docs` Authorize |
| Who deletes users | Admins only, through `/admin/users` | Self-deletion through `/auth/me`: not in the master plan and easy to trigger by mistake |
| Deletion order | Deactivate → MongoDB → PostgreSQL; saving a view locks its owner's row | PostgreSQL first: a MongoDB failure would leave unreachable orphans. A final MongoDB "sweep" (the first version): it could fail after the user was gone, and a slow save could still land after it |
| Keep at least one admin | Lock admin rows, refuse the last one | Relying only on "no self-delete": fails when two admins delete each other at once (found by review, proved by test) |
| Weak `JWT_SECRET` | API refuses to start | Warning only: a forged admin token would still be possible |
| Accounts | Seeded from `.env` by the loader | Hard-coded passwords would be committed to Git |

### Adapting the original task prompt

The original step-by-step prompt was followed in spirit, with discovery first,
reasoning, implementation and verification. It was adapted where it did not fit
this repository:

- It referred to files and fields that don't exist: `Login.tsx`,
  `seed_users.py`, roles in `sql/013` (which holds R8/R9 rejection codes), `id`
  instead of `user_id`, `username` instead of email, and a single role per user.
- It suggested `passlib` and `python-jose`, and a `role` claim in the token.
- Its test list was mostly happy paths. The added tests target what can really
  fail: token tampering, inactive users, unprotected routes, database failures
  part way through deletion, and concurrency.

---

## 5. How to use it

1. In `.env`, set `JWT_SECRET` to at least 32 random characters
   (`python -c "import secrets; print(secrets.token_hex(32))"`) and set
   `YCQ_ADMIN_PASSWORD`, `YCQ_ANALYST1_PASSWORD` and `YCQ_ANALYST2_PASSWORD`
   (at least 12 characters each).
2. Run `docker compose up -d --build`. The loader prints
   `admin@ycq.local: created`, and so on.
3. Open http://localhost:8080 and log in. For the API, use
   http://localhost:8000/docs → `POST /auth/login` → **Authorize** → paste the token.
4. Delete users from Administration → Users.

**Teammates with an existing `.env`** must add the three password variables and
make sure `JWT_SECRET` is long enough. Until then, the API will not start, and
the error message explains why.

**A deleted default account** returns, empty, on the next start while its
password is still in `.env`. Remove the variable to keep it deleted.

---

## 6. Verification evidence

### 6.1 Automated tests: `pytest`, isolated `ycq_test` databases

| Suite | Tests | Covers |
| --- | ---: | --- |
| `tests/test_auth.py` | 28 | Argon2id format and salting; weak secrets refused, including at API start; token round trip; 8 kinds of bad token (expired, other secret, `alg: none`, missing `sub`/`exp`, non-numeric `sub`, altered payload, garbage); identical login failures; case-insensitive email; hash upgrade; role removal and deactivation applying to existing tokens; **every route called as nobody, role-less user, analyst and admin**; malformed headers; seed creation, idempotency, password change, skip and refusal |
| `tests/test_users.py` | 10 | Full deletion with a two-version saved plan through the plan-history triggers; bystander untouched; unknown user; **MongoDB outage** then retry; **real PostgreSQL error** (temporary trigger) then retry; **a view being saved in another connection when deletion starts** is waited for and deleted; last admin refused; **two admins deleting each other concurrently**; API delete, 404 on repeat and the deleted user's token rejected; self-delete 409; 503 mapping |
| `tests/test_saved_views.py` | +1 | An inactive or unknown owner cannot save a view (the suite's two test owners are now real users) |
| Existing suites | 143 | Unchanged and still passing |
| **Total** | **182** | **All pass** |

### 6.2 Do the tests catch real bugs? Mutation check

Each bug below was injected into the code temporarily, and the new tests were run.
A useful test suite must fail every time.

| Injected bug | Caught by |
| --- | --- |
| Delete PostgreSQL user before MongoDB views | MongoDB-outage test |
| Remove the save's row lock (`FOR SHARE`) | Concurrent-save test (re-checked after the fix) |
| Skip deactivation | MongoDB-outage test |
| Admin routers open to analysts | Route-coverage test |
| Zone routes made public | Route-coverage test |
| Users with no role allowed | Route-coverage test |
| Inactive users can log in | Login-failure test |
| `alg: none` tokens accepted | Bad-token test |
| Expiry not required | Bad-token test |
| Self-delete allowed | Self-delete test |
| Last admin deletable | Last-admin test |
| Seed rehashes on every run | Seed idempotency test |
| Weak seed password accepted | Seed refusal test |

**13 of 13 caught.** Removing the admin row lock made the concurrency test fail
in **5 of 5** runs, because both admins were deleted. With the lock, it passed
**10 of 10** runs.

The mutation check also found a weakened test after the last-admin rule was added:
the self-delete test passed only because its admin was also the last one. The test
now uses two admins, so it checks the self-delete rule itself.

### 6.3 Live test against the running containers

Run through the website proxy (`http://localhost:8080/api`), with the API using
its restricted MongoDB account (`ycq_app`, `readWrite` on `ycq` only).
**16 of 16 checks passed:**

- The three seeded hashes start with `$argon2id$v=19$m=65536,t=3,p=4$`.
- Valid logins return 200 and a JWT. A wrong password, an unknown email and the
  old dev user all return 401.
- No token gives 401. An analyst gets 403 on `/admin/imports` and
  `/admin/users`, and 200 on `/plans` and `/flows/months`. An admin gets 200.
  `/health` stays public.
- **Cross-database deletion:** a temporary analyst created a plan, saved two
  versions (**60 allocation results**) and two saved views, all through the API.
  The admin then deleted the user.

  | Data | Before | After |
  | --- | ---: | ---: |
  | `app_user` | 1 | 0 |
  | `app_user_role` | 1 | 0 |
  | `allocation_plan` | 1 | 0 |
  | `allocation_plan_version` | 2 | 0 |
  | `allocation_result` | 60 | 0 |
  | MongoDB `saved_analysis_views` | 2 | 0 |

- The deleted user's token gives 401, a repeat delete gives 404, and
  self-deletion gives 409.
- Rerunning the seed in the loader container reports all three accounts as
  `unchanged`.

### 6.4 Builds

- `npm run build` (TypeScript check and Vite production build) passes.
- `docker compose -f docker-compose.yml build api loader web` passes in normal
  mode.

### 6.5 Browser checks

Run in the VS Code browser with temporary accounts, which were removed afterwards:

- Logged out, the app shows only the login page. A wrong password shows
  "wrong email or password".
- Analyst: tabs are Activity Dashboard, Flow Explorer and Allocation Planner;
  opening `/admin` redirects to `/dashboard`. Login survives a page reload;
  Log out clears the token.
- A forged token in storage returns the user to the login page and is removed.
- Admin: the Administration tab is visible; Users lists accounts, with "you"
  on their own row. Delete shows a confirmation, then "Deleted …: 0 plan(s),
  0 saved view(s)", and the row disappears.

### 6.6 Independent code review

A separate review agent checked every changed file. It found **no significant
issues** and one low-severity race: two admins deleting each other
simultaneously could leave no active admin. This was fixed with the row lock
described in section 3.4 and proved by the concurrency test.

---

## 7. Files changed

| File | Lines added / removed | Purpose |
| --- | ---: | --- |
| `api/auth.py` | 113 / 34 | Tokens, `current_user`, `require_role`, login; dev user removed |
| `api/passwords.py` | 30 / 0 | Argon2id hashing |
| `api/users.py` | 107 / 0 | User listing and three-step deletion |
| `api/saved_views.py` | 8 / 1 | Saving a view locks its owner's row, so deletion can't miss it |
| `api/routers/auth.py` | 30 / 0 | `/auth/login`, `/auth/me` |
| `api/routers/users.py` | 34 / 0 | `/admin/users` routes |
| `api/main.py` | 19 / 8 | Router access groups, secret check, logging |
| `scripts/seed_users.py` | 87 / 0 | Default accounts |
| `etl/load_all.py` | 1 / 0 | Runs the seed |
| `docker-compose.yml`, `.env.example`, `requirements.txt` | 25 / 3 | Variables and the `argon2-cffi`, `PyJWT` and `httpx` dependencies |
| `web/src/api.ts`, `App.tsx`, `pages/Login.tsx`, `pages/Admin.tsx`, `pages/admin/Users.tsx`, `styles.css` | 201 / 17 | Website |
| `tests/conftest.py`, `tests/test_auth.py`, `tests/test_users.py` | 551 / 0 | Tests |
| `README.md`, `STATUS.md`, `master_plan.md` | — | Documentation and status |

Application code is about **420 lines of Python and 200 of TypeScript**. The
tests are larger than the code they test, which is intentional for security and
data-integrity work. No new abstractions were added beyond what is listed.

---

## 8. Limitations and deliberate omissions

- **No login rate limiting.** Argon2 slows each guess, but repeated attempts are
  not blocked.
- **No refresh tokens, password reset or sign-up.** Accounts come from `.env`,
  as the schema comment in `sql/003_users.sql` intended.
- **Tokens can't be revoked individually** before expiry. Deactivating or
  deleting the user is the immediate kill switch.
- **`sessionStorage` is readable by scripts on the page.** React escapes output
  and the app renders no user HTML, so the risk is low; an httpOnly cookie would
  be the next step.
- **PostgreSQL database roles** (`ycq_read` / `ycq_write`) are a separate
  master-plan decision and were not part of this work.
- **The old `dev@ycq.local` row** remains in existing databases. It cannot log in
  (`disabled` is not a hash), owns no data, and can be deleted from the Users
  section.
