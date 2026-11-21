from backend.product.users import hash_password, verify_password


def test_password_hashes_are_salted_and_verify_only_the_original():
    first, second = hash_password("correct horse"), hash_password("correct horse")
    assert first != second
    assert first.startswith("scrypt$")
    assert verify_password("correct horse", first)
    assert verify_password("correct horse", second)
    assert not verify_password("wrong horse", first)


def test_malformed_or_foreign_hashes_never_verify():
    assert not verify_password("anything", "")
    assert not verify_password("anything", "bcrypt$1$2$3$aa$bb")
    assert not verify_password("anything", "scrypt$x$8$1$zz$00")
