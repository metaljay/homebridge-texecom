#!/usr/bin/env python3
"""
Check whether a UDL login on a Crestron-mode port holds back panel events,
and whether logging out (\\H/) releases them. Nothing is armed or disarmed.

  python3 crestron-logout-probe.py <panel-ip> <port> [homebridge-container] [--udl-from <config.json>]

The UDL code is asked for at a hidden prompt, or read from a Homebridge
config.json with --udl-from (Texecom platform "udl"); it is only sent to the
panel and never printed. If a Homebridge container name is given it is stopped while the probe
runs (the COM-IP accepts one connection) and always started again afterwards.

Steps (walk past a sensor whenever asked):
  1. no login       - events should arrive as they happen
  2. after \\W<udl>/ - reports whether the login was accepted (OK), then
                    shows whether events are held back
  3. after \\H/      - reports the reply, then waits up to 75 s to show when
                    events start arriving again
"""
import json
import getpass
import socket
import subprocess
import sys
import time


def listen(sock, seconds, label):
    sock.settimeout(0.3)
    end = time.time() + seconds
    while time.time() < end:
        try:
            data = sock.recv(4096)
        except socket.timeout:
            continue
        if not data:
            raise ConnectionError("panel closed the connection")
        for line in data.decode("latin1").splitlines():
            if line.strip():
                print(f"  {time.strftime('%H:%M:%S')} [{label}] {line.strip()!r}")


def wait_reply(sock, seconds):
    """Return the first OK/ERROR line within `seconds`, printing anything else."""
    sock.settimeout(0.3)
    end = time.time() + seconds
    while time.time() < end:
        try:
            data = sock.recv(4096)
        except socket.timeout:
            continue
        for line in data.decode("latin1").splitlines():
            line = line.strip()
            if line in ("OK", "ERROR"):
                return line, time.time()
            if line:
                print(f"  {time.strftime('%H:%M:%S')} [other] {line!r}")
    return None, time.time()


def send(sock, command, label):
    print(f"  {time.strftime('%H:%M:%S')} -> {label}")
    sock.sendall(b"\\" + command + b"/")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    args = sys.argv[1:]
    udl_from = None
    if "--udl-from" in args:
        i = args.index("--udl-from")
        udl_from = args[i + 1]
        del args[i:i + 2]
    host, port = args[0], int(args[1])
    container = args[2] if len(args) > 2 else None
    if udl_from:
        platforms = json.load(open(udl_from)).get("platforms", [])
        udl = str(next(p for p in platforms if p.get("platform") == "Texecom")["udl"]).strip()
        print(f"Using the UDL code from {udl_from} ({len(udl)} digits)")
    else:
        udl = getpass.getpass("UDL code (hidden): ").strip()
    if not udl.isdigit():
        sys.exit("UDL should be digits only.")

    if container:
        print(f"Stopping {container}...")
        subprocess.run(["docker", "stop", "-t", "10", container], check=True, capture_output=True)
        time.sleep(2)
    try:
        with socket.create_connection((host, port), timeout=5) as sock:
            print("\nStep 1 (not logged in): walk past a sensor in the next 15 s")
            listen(sock, 15, "no login")

            print("\nStep 2: logging in. Walk past a sensor in the next 20 s")
            sent = time.time()
            send(sock, b"W" + udl.encode(), "login")
            reply, at = wait_reply(sock, 8)
            print(f"  login reply: {reply or 'none'}" + (f" after {at - sent:.1f} s" if reply else " within 8 s"))
            listen(sock, 15, "logged in")

            print("\nStep 3: logging out. Keep walking past a sensor every few seconds")
            sent = time.time()
            send(sock, b"H", "logout \\H/")
            reply, at = wait_reply(sock, 3)
            print(f"  logout reply: {reply or 'none'}")
            listen(sock, 75, "after logout")
    finally:
        if container:
            subprocess.run(["docker", "start", container], check=True, capture_output=True)
            print(f"\nStarted {container} again.")


if __name__ == "__main__":
    main()
