#!/usr/bin/env python3
"""
Supervised test: arm/part-arm/disarm over the Crestron port using the binary
UDL commands found in ricol99/casa and shuckc/pytexalarm, instead of the
Crestron text commands (\\A, \\Y, \\D), which can only reach Part Arm 1.

  python3 crestron-udl-arm-test.py <panel-ip> <port> [homebridge-container] [--config <config.json>]

Each command is one transaction, as the plugin does it: \\W<udl>/ (wait for
OK), then one binary frame, then the Wintex logout 03 48 B4. The panel then
holds back its text feed for ~30 s, so ASTATUS/LSTATUS replies only resume
after that.

The UDL code is read from the Texecom platform in the Homebridge config
(default /home/pi/homebridge/config.json) and never printed. If a Homebridge
container name is given it is stopped while the test runs and always started
again on exit.

THIS ARMS THE REAL PANEL. Remote arms set almost at once (Remote Arm
Instant). Stay out of the zones being armed until you have disarmed.

Commands at the prompt:
  1 / 2 / 3  part arm 1, 2 or 3   (binary S 00 0n; asks you to type ARM)
  d          disarm               (binary D 00)
  t          disarm the old way   (text \\D, the plugin's proven path)
  a          read the armed state (ASTATUS)
  l          read the keypad screen (LSTATUS)
  q          quit (offers to disarm if the panel reports armed)
Everything the panel sends is printed as it arrives.
"""
import json
import socket
import subprocess
import sys
import threading
import time

T0 = time.time()
state = {"astatus": None, "ok": threading.Event(), "frames": []}


def stamp():
    return f"{time.strftime('%H:%M:%S')} (t={time.time() - T0:6.1f})"


def frame(cmd, payload=()):
    data = [len(payload) + 3, cmd, *payload]
    return bytes(data + [(0xFF - sum(data)) & 0xFF])


def hexs(b):
    return " ".join(f"{x:02x}" for x in b)


def reader(sock, stop):
    buf = b""
    sock.settimeout(0.3)
    while not stop.is_set():
        try:
            data = sock.recv(4096)
        except socket.timeout:
            continue
        except OSError:
            break
        if not data:
            print(f"\n  {stamp()} panel closed the connection")
            break
        buf += data
        while buf:
            first = buf[0]
            if first in (0x0D, 0x0A):
                buf = buf[1:]
                continue
            if 3 <= first < 0x20:
                if len(buf) < first:
                    break  # wait for the rest of the binary frame
                f = buf[:first]
                if sum(f) & 0xFF == 0xFF:
                    buf = buf[first:]
                    state["frames"].append(f)
                    note = "  (ACK)" if f == b"\x03\x06\xf6" else "  (NAK)" if f[1:2] == b"\x0f" else ""
                    print(f"\n  {stamp()} <- binary {hexs(f)}{note}", flush=True)
                    continue
            if b"\n" not in buf:
                break
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("latin1").strip()
            if not line:
                continue
            if line == "OK":
                state["ok"].set()
            if (line.startswith('"Y') or line.startswith('"N')) and len(line) <= 4:
                state["astatus"] = line
            print(f"\n  {stamp()} <- {line!r}", flush=True)


def send_text(sock, text):
    print(f"  {stamp()} -> {text}")
    sock.sendall(text.encode("latin1") + b"\r\n")


def transaction(sock, udl, binary=None, text_command=None, label=""):
    """\\W<udl>/, then one binary frame or Crestron text command, then logout."""
    state["ok"].clear()
    print(f"  {stamp()} -> \\W<udl>/  (login)")
    sock.sendall(b"\\W" + udl.encode("latin1") + b"/")
    # This panel often opens the session without a text OK (review 2.0b), so
    # carry on either way: a frame sent without a session is just refused.
    if not state["ok"].wait(8):
        print("  no text OK to the login (normal on this panel); carrying on")
    before = len(state["frames"])
    if binary is not None:
        print(f"  {stamp()} -> binary {hexs(binary)}  ({label})")
        sock.sendall(binary)
        deadline = time.time() + 5
        while len(state["frames"]) == before and time.time() < deadline:
            time.sleep(0.1)
        if len(state["frames"]) == before:
            print("  no binary reply within 5 s")
    else:
        state["ok"].clear()
        print(f"  {stamp()} -> \\{text_command[0]}<area 1>/  ({label})")
        sock.sendall(b"\\" + text_command.encode("latin1") + b"/")
        print("  OK" if state["ok"].wait(5) else "  no OK within 5 s")
    print(f"  {stamp()} -> binary {hexs(frame(0x48))}  (logout)")
    sock.sendall(frame(0x48))
    print("  The text feed should resume in ~30 s; then use 'a' / 'l' to check.")
    return True


def main():
    args = sys.argv[1:]
    config_path = "/home/pi/homebridge/config.json"
    if "--config" in args:
        i = args.index("--config")
        config_path = args[i + 1]
        del args[i:i + 2]
    if len(args) < 2:
        sys.exit(__doc__)
    host, port = args[0], int(args[1])
    container = args[2] if len(args) > 2 else None

    platform = next(p for p in json.load(open(config_path))["platforms"] if p.get("platform") == "Texecom")
    udl = str(platform["udl"]).strip()
    print(f"Using the UDL code from {config_path} ({len(udl)} digits)")

    if container:
        print(f"Stopping {container}...")
        subprocess.run(["docker", "stop", "-t", "10", container], check=True, capture_output=True)
        time.sleep(2)
    stop = threading.Event()
    try:
        with socket.create_connection((host, port), timeout=5) as sock:
            global T0
            T0 = time.time()
            threading.Thread(target=reader, args=(sock, stop), daemon=True).start()
            send_text(sock, "ASTATUS")
            time.sleep(1.5)
            send_text(sock, "LSTATUS")
            time.sleep(1.5)
            if not (state["astatus"] or "").startswith('"N'):
                print(f"\n  The panel does not report area 1 disarmed ({state['astatus']}). Not continuing.")
                return
            print(__doc__.split("Commands at the prompt:")[1])
            while True:
                try:
                    cmd = input("cmd> ").strip().lower()
                except EOFError:
                    cmd = "q"
                if cmd in ("1", "2", "3"):
                    n = int(cmd)
                    print(f"  Part Arm {n} arms the real panel within seconds. Stay out of its zones.")
                    if input("  Type ARM to continue: ").strip() != "ARM":
                        print("  cancelled")
                        continue
                    transaction(sock, udl, binary=frame(0x53, (0x00, n)), label=f"S area 0, part arm {n}")
                elif cmd == "d":
                    transaction(sock, udl, binary=frame(0x44, (0x00,)), label="D area 0, disarm")
                elif cmd == "t":
                    transaction(sock, udl, text_command="D\x01", label="text disarm")
                elif cmd == "a":
                    send_text(sock, "ASTATUS")
                elif cmd == "l":
                    send_text(sock, "LSTATUS")
                elif cmd == "q":
                    send_text(sock, "ASTATUS")
                    time.sleep(1.5)
                    current = state["astatus"] or "unknown"
                    if "Y" in current[1:] or current == "unknown":
                        print(f"  WARNING: the panel reports {current}. 'd' or 't' disarms; quitting leaves it as it is.")
                        if input("  Quit anyway? [y/N] ").strip().lower() != "y":
                            continue
                    break
                elif cmd:
                    print("  unknown command")
                time.sleep(0.2)
    finally:
        stop.set()
        if container:
            subprocess.run(["docker", "start", container], check=True, capture_output=True)
            print(f"\nStarted {container} again.")


if __name__ == "__main__":
    main()
