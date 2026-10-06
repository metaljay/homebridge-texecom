#!/usr/bin/env python3
"""
Does ASTATUS still answer while a UDL login has silenced the Crestron feed,
and does sending it restart the ~60 s blackout? Nothing is armed or disarmed.

  python3 crestron-astatus-during-login.py <panel-ip> <port> [homebridge-container] --udl-from <config.json>

The UDL code is read from a Homebridge config.json (Texecom platform "udl"),
or asked for at a hidden prompt if --udl-from is not given. It is only sent
to the panel and never printed. If a Homebridge container name is given it is
stopped while the probe runs and always started again afterwards.

Timeline:
  t=0     ASTATUS (baseline, not logged in)
  t=5     \\W<udl>/ login
  t=10    ASTATUS, LSTATUS     (during the blackout)
  t=30    ASTATUS              (during the blackout)
  then    listen up to 90 s, printing everything, to see when the held
          events are released: ~60 s after the login means ASTATUS does not
          restart the blackout; ~60 s after the last ASTATUS means it does.
"""
import getpass
import json
import socket
import subprocess
import sys
import time

T0 = time.time()


def stamp():
    return f"{time.strftime('%H:%M:%S')} (t={time.time() - T0:5.1f})"


def listen(sock, seconds):
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
                print(f"  {stamp()} <- {line.strip()!r}")


def send(sock, raw, label):
    print(f"  {stamp()} -> {label}")
    sock.sendall(raw)


def main():
    global T0
    args = sys.argv[1:]
    udl_from = None
    if "--udl-from" in args:
        i = args.index("--udl-from")
        udl_from = args[i + 1]
        del args[i:i + 2]
    if len(args) < 2:
        sys.exit(__doc__)
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
            T0 = time.time()
            send(sock, b"ASTATUS\r\n", "ASTATUS (not logged in)")
            listen(sock, 5)
            send(sock, b"\\W" + udl.encode() + b"/", "login")
            listen(sock, 5)
            send(sock, b"ASTATUS\r\n", "ASTATUS (during blackout)")
            listen(sock, 3)
            send(sock, b"LSTATUS\r\n", "LSTATUS (during blackout)")
            listen(sock, 17)
            send(sock, b"ASTATUS\r\n", "ASTATUS (during blackout, last command)")
            print("  ... listening for up to 90 s; held events will appear when released")
            listen(sock, 90)
    finally:
        if container:
            subprocess.run(["docker", "start", container], check=True, capture_output=True)
            print(f"\nStarted {container} again.")


if __name__ == "__main__":
    main()
