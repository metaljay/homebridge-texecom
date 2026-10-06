#!/usr/bin/env python3
"""
Check whether a UDL login on a Crestron-mode port holds back panel events,
and whether logging out (\\H/) releases them. Nothing is armed or disarmed.

  python3 crestron-logout-probe.py <panel-ip> <port> [homebridge-container]

You are asked for the UDL code at a hidden prompt; it is only sent to the
panel. If a Homebridge container name is given it is stopped while the probe
runs (the COM-IP accepts one connection) and always started again afterwards.

Steps (walk past a sensor whenever asked):
  1. no login       - events should arrive as they happen
  2. after \\W<udl>/ - events expected to be held back
  3. after \\H/      - events expected to be released straight away
"""
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


def send(sock, command, label):
    print(f"  {time.strftime('%H:%M:%S')} -> {label}")
    sock.sendall(b"\\" + command + b"/")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    host, port = sys.argv[1], int(sys.argv[2])
    container = sys.argv[3] if len(sys.argv) > 3 else None
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
            send(sock, b"W" + udl.encode(), "login")
            listen(sock, 20, "logged in")

            print("\nStep 3: logging out. Anything held back should appear now; walk past a sensor again")
            send(sock, b"H", "logout \\H/")
            listen(sock, 20, "after logout")
    finally:
        if container:
            subprocess.run(["docker", "start", container], check=True, capture_output=True)
            print(f"\nStarted {container} again.")


if __name__ == "__main__":
    main()
