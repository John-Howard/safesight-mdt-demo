from mdt import token_store
from mdt.safesight_client import Tokens


def test_put_get_drop():
    tokens = Tokens("a", "r")
    sid = token_store.put(tokens)
    assert token_store.get(sid) is tokens
    token_store.drop(sid)
    assert token_store.get(sid) is None


def test_ids_are_unique_and_opaque():
    ids = {token_store.put(Tokens("a", "r")) for _ in range(50)}
    assert len(ids) == 50
    assert all(len(i) >= 32 for i in ids)


def test_unknown_and_none():
    assert token_store.get("nope") is None
    assert token_store.get(None) is None
    token_store.drop("nope")  # no error
