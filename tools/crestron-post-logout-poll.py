#!/usr/bin/env python3
"""
After a \\W<udl>/ login the port answers in Wintex binary framing
([len][type][...][checksum], checksum = 0xFF - sum of the other bytes), and
the Crestron text feed stops for ~60 s. After the Wintex logout ('H',
03 48 B4) the feed resumes ~30 s later. This polls ASTATUS every 2 s after
the logout to see exactly when the port answers in text again, and whether
polling brings that forward. Nothing is armed or disarmed.

  python3 crestron-post-logout-poll.py <panel-ip> <port> [homebridge-container] --udl-from <config.json>

The UDL code is read from a Homebridge config.json (Texecom platform "udl"),
or asked for at a hidden prompt if --udl-from is not given. It is only sent
to the panel and never printed. If a Homebridge container name is given it is
stopped while the probe runs and always started again afterwards.

Timeline:
  t=0     listen 4 s (not logged in), ASTATUS baseline
  t=6     \\W<udl>/ login, logout 2 s later
  then    ASTATUS every 2 s for 50 s, printing each reply ('"N…'/'"Y…' text
          means the port is back in Crestron mode; 03 0F ED means it is not)
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
            listen(sock, 4)
            send(sock, b"ASTATUS\r\n", "ASTATUS (baseline)")
            listen(sock, 2)
            send(sock, b"\\W" + udl.encode() + b"/", "login")
            listen(sock, 2)
            send(sock, bytes([0x03, 0x48, 0xB4]), "Wintex logout 03 48 B4")
            listen(sock, 1)
            end = time.time() + 50
            while time.time() < end:
                send(sock, b"ASTATUS\r\n", "ASTATUS")
                listen(sock, 2)
    finally:
        if container:
            subprocess.run(["docker", "start", container], check=True, capture_output=True)
            print(f"\nStarted {container} again.")


if __name__ == "__main__":
    main()
