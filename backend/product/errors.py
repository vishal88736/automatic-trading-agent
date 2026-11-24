"""Expected rejections from product operations."""


class ConflictError(ValueError):
    """The operation conflicts with existing account or strategy state."""


class NotFoundError(LookupError):
    """The requested product record is unavailable to this account."""


class LiveRejected(ValueError):
    """A live operation was rejected before it could be submitted."""
