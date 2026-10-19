"""Password hashing (Argon2id).

A module of its own, without database imports, so scripts/seed_users.py can
hash passwords without starting the API's database clients.

argon2-cffi's defaults are the RFC 9106 low-memory profile: Argon2id, 3
passes, 64 MiB, 4 lanes. The parameters are stored inside each hash, so they
can be raised later; needs_rehash() then tells login to upgrade old hashes.
"""
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """False for a wrong password and for anything that isn't an Argon2 hash
    (such as the old dev user's 'disabled'), instead of raising."""
    try:
        return _hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)
