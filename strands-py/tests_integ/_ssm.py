"""Reusable SSM Parameter Store resolution for integration tests.

Integration tests that depend on provisioned AWS resources discover them at
runtime by reading SSM parameters the provisioning stack publishes under stable
``/strands/test-infra/<feature>/<name>`` paths. This module is the one place
that SSM plumbing lives so every integ suite shares it instead of re-deriving
boto3 calls and skip logic.

This module reads only published SSM **parameter paths** (a runtime data
contract); it imports nothing from the provisioning stack and the stack imports
nothing from here.

Resolution is best-effort: when SSM is unreachable (no credentials, wrong
account, parameter absent) the helpers return ``None`` for the missing values
rather than raising, so a suite can ``pytest.skip(...)`` cleanly instead of
erroring. Per-key environment overrides take precedence over SSM, which lets a
developer point a suite at their own resources without touching SSM.
"""

from __future__ import annotations

import logging
import os

import boto3

from tests_integ._aws import resolve_region

logger = logging.getLogger(__name__)

# Root namespace the provisioning stack publishes every test parameter under.
# This string is a published runtime contract, not an import.
SSM_PARAMETER_NAMESPACE = "/strands/test-infra"


def ssm_parameter_path(feature: str, *segments: str) -> str:
    """Build the SSM parameter path for a provisioned test resource.

    Args:
        feature: The feature namespace (e.g. ``"ssh-ec2"``).
        *segments: Path segments naming the value (e.g. ``"instance-id"``).

    Returns:
        The full parameter path, e.g. ``/strands/test-infra/ssh-ec2/instance-id``.
    """
    return "/".join([SSM_PARAMETER_NAMESPACE, feature, *segments])


def read_ssm_parameter(name: str, *, with_decryption: bool = False, region: str | None = None) -> str | None:
    """Read a single SSM parameter by name.

    Args:
        name: The SSM parameter name.
        with_decryption: Decrypt the value (required for ``SecureString`` parameters).
        region: AWS region override; defaults via :func:`~tests_integ._aws.resolve_region`.

    Returns:
        The parameter value, or ``None`` if it can't be read (missing, no access, SSM unreachable).
    """
    try:
        client = boto3.Session(region_name=resolve_region(region)).client("ssm")
        response = client.get_parameter(Name=name, WithDecryption=with_decryption)
    except Exception as error:  # noqa: BLE001 - any failure means "unavailable", not "error".
        logger.warning("name=<%s>, error=<%s> | failed to read SSM parameter", name, error)
        return None

    return response["Parameter"]["Value"]


def resolve_ssm_parameters(
    params: dict[str, str],
    *,
    overrides: dict[str, str] | None = None,
    region: str | None = None,
) -> dict[str, str | None]:
    """Batch-resolve named SSM values, honoring environment overrides.

    Args:
        params: Map of result key -> SSM parameter name to batch-read.
        overrides: Optional map of result key -> environment variable name. When the
            env var is set, its value takes precedence over SSM for that key.
        region: AWS region override; defaults via :func:`~tests_integ._aws.resolve_region`.

    Returns:
        Map of each key in ``params`` to its resolved value, or ``None`` when neither
        an override nor SSM provides one. When SSM is unreachable every SSM-sourced
        value is ``None`` (overrides still apply), so callers can decide to skip.
    """
    override_values = {key: os.environ.get(env_var) for key, env_var in (overrides or {}).items()}
    resolved = _batch_get(params, region=region) or {}
    return {key: override_values.get(key) or resolved.get(key) for key in params}


def _batch_get(params: dict[str, str], *, region: str | None) -> dict[str, str | None] | None:
    try:
        client = boto3.Session(region_name=resolve_region(region)).client("ssm")
        response = client.get_parameters(Names=list(params.values()))
    except Exception as error:  # noqa: BLE001 - any failure means "skip", not "error".
        logger.warning("error=<%s> | failed to resolve SSM parameters", error)
        return None

    by_name = {param["Name"]: param["Value"] for param in response.get("Parameters", [])}
    return {key: by_name.get(name) for key, name in params.items()}
