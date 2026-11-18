"""Classify the addresses a host resolves to, so web fetch can refuse non-public targets."""

from __future__ import annotations

import asyncio
import ipaddress
import socket

_NON_PUBLIC_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",  # unspecified / "this network"
        "10.0.0.0/8",  # private
        "100.64.0.0/10",  # shared address space (carrier-grade NAT)
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local
        "172.16.0.0/12",  # private
        "192.0.0.0/24",  # IETF protocol assignments
        "192.168.0.0/16",  # private
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved, broadcast
        "::/128",  # unspecified
        "::1/128",  # loopback
        "fc00::/7",  # unique local
        "fe80::/10",  # link-local
        "fec0::/10",  # site-local (deprecated)
        "ff00::/8",  # multicast
    )
)


def is_public_address(address: str) -> bool:
    """Whether ``address`` (an IPv4 or IPv6 literal) is outside every non-public range."""
    ip = ipaddress.ip_address(address)
    ip = getattr(ip, "ipv4_mapped", None) or ip
    return not any(ip in network for network in _NON_PUBLIC_NETWORKS)


async def is_public_host(host: str) -> bool:
    """Whether ``host`` resolves to at least one address and every one of them is public.

    Raises:
        OSError: When ``host`` cannot be resolved.
    """
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return bool(infos) and all(is_public_address(str(info[4][0])) for info in infos)
