"""Canonical IPL identity registry construction and resolution."""

from .builder import RegistryBuildError, build_registry_bytes, generate_registries
from .integrity import RegistryIntegrityError
from .resolver import (
    IdentityResolutionError,
    IdentityResolver,
    IngestionSafetyError,
    require_ingestion_safe_resolution,
)

__all__ = [
    "IdentityResolutionError",
    "IdentityResolver",
    "IngestionSafetyError",
    "RegistryBuildError",
    "RegistryIntegrityError",
    "build_registry_bytes",
    "generate_registries",
    "require_ingestion_safe_resolution",
]
