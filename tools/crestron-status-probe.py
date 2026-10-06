#!/usr/bin/env python3
"""
Ask a Texecom panel on a Crestron-mode port for its armed state and keypad
screen, without arming or disarming anything.

  python3 crestron-status-probe.py <panel-ip> <port> [homebridge-container]

The COM-IP accepts one connection at a time, so if a Homebridge container
name is given it is stopped for the few seconds the probe takes and always
started again afterwards.

Queries sent (as used by github.com/JumpMaster/TexecomManager):
  ASTATUS   armed state   -> expected '"Y...' (armed) or '"N...' (disarmed)
  LSTATUS   keypad screen -> expected the text on the keypad display
"""
import socket
import subprocess
import sys
import time


def read_for(sock, seconds):
    sock.settimeout(0.3)
    end = time.time() + seconds
    data = b""
    while time.time() < end:
        try:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        except socket.timeout:
            pass
    return data


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    host, port = sys.argv[1], int(sys.argv[2])
    container = sys.argv[3] if len(sys.argv) > 3 else None

    if container:
        print(f"Stopping {container}...")
        subprocess.run(["docker", "stop", "-t", "10", container], check=True, capture_output=True)
        time.sleep(2)
    try:
        with socket.create_connection((host, port), timeout=5) as sock:
            idle = read_for(sock, 1.0)
            if idle:
                print(f"(received on connect: {idle!r})")
            for query in (b"ASTATUS\r\n", b"LSTATUS\r\n"):
                sock.sendall(query)
                reply = read_for(sock, 3.0)
                print(f"{query.strip().decode()}: {reply!r}")
    finally:
        if container:
            subprocess.run(["docker", "start", container], check=True, capture_output=True)
            print(f"Started {container} again.")


if __name__ == "__main__":
    main()
