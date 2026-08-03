"""Deterministic, read-only audit helpers for the local Cricsheet archive."""

from .scanner import AuditError, scan_archive

__all__ = ["AuditError", "scan_archive"]
