#!/usr/bin/env python3
"""
Drive the panel's virtual keypad over a Crestron-mode port (no UDL login),
as github.com/JumpMaster/TexecomManager does, and watch whether the event
feed keeps flowing. Interactive: you choose every key.

  python3 crestron-keypad-probe.py <panel-ip> <port> [homebridge-container] [--no-crlf | --lf]

--no-crlf sends KEY commands without a line ending, as the
homebridge-texecom-connect plugin (garethflowers) and openhab-texecom-bridge
v2 (Prinsessen) do; --lf sends them with LF only, as openhab-texecom-bridge v1
did; TexecomManager sends them with CR LF. Queries (ASTATUS/LSTATUS) always
use CR LF.

You are asked for a keypad user code at a hidden prompt; it is only sent to
the panel as keypresses and never printed. If a Homebridge container name is
given it is stopped while the probe runs and always started again on exit.

Commands at the prompt:
  code   type the user code on the virtual keypad (KEY<digit> per digit)
  y      press YES   (KEYY)
  d      press DOWN  (KEYD)
  r      press RESET (KEYR) - TexecomManager's abort key
  l      read the keypad screen (LSTATUS)
  a      read the armed state  (ASTATUS)
  q      quit (warns if the panel reports armed)
Everything the panel sends is printed as it arrives.
"""
import getpass
import socket
import subprocess
import sys
import threading
import time

T0 = time.time()
last_astatus = {"value": None}


def stamp():
    return f"{time.strftime('%H:%M:%S')} (t={time.time() - T0:6.1f})"


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
        *lines, buf = buf.split(b"\n")
        for raw in lines:
            line = raw.decode("latin1").strip()
            if not line:
                continue
            if line.startswith('"Y') or line.startswith('"N'):
                if len(line) <= 4:
                    last_astatus["value"] = line
            print(f"\n  {stamp()} <- {line!r}", flush=True)


KEY_ENDING = b"\r\n"


def send_line(sock, text, shown=None):
    ending = KEY_ENDING if text.startswith("KEY") else b"\r\n"
    note = {b"": "  (no line ending)", b"\n": "  (LF only)"}.get(ending, "")
    print(f"  {stamp()} -> {shown or text}{note}")
    sock.sendall(text.encode() + ending)


def main():
    global T0, KEY_ENDING
    args = sys.argv[1:]
    if "--no-crlf" in args:
        args.remove("--no-crlf")
        KEY_ENDING = b""
    if "--lf" in args:
        args.remove("--lf")
        KEY_ENDING = b"\n"
    if len(args) < 2:
        sys.exit(__doc__)
    host, port = args[0], int(args[1])
    container = args[2] if len(args) > 2 else None
    code = getpass.getpass("Keypad user code (hidden): ").strip()
    if not code.isdigit():
        sys.exit("The code should be digits only.")

    if container:
        print(f"Stopping {container}...")
        subprocess.run(["docker", "stop", "-t", "10", container], check=True, capture_output=True)
        time.sleep(2)
    stop = threading.Event()
    try:
        with socket.create_connection((host, port), timeout=5) as sock:
            T0 = time.time()
            threading.Thread(target=reader, args=(sock, stop), daemon=True).start()
            send_line(sock, "ASTATUS")
            time.sleep(1.5)
            send_line(sock, "LSTATUS")
            time.sleep(1.5)
            print(__doc__.split("Commands at the prompt:")[1])
            while True:
                try:
                    cmd = input("key> ").strip().lower()
                except EOFError:
                    cmd = "q"
                if cmd == "code":
                    for digit in code:
                        send_line(sock, "KEY" + digit, shown="KEY*")
                        time.sleep(0.5)
                    print(f"  {stamp()} code entered ({len(code)} digits); use 'l' to read the screen")
                elif cmd in ("y", "d", "r"):
                    send_line(sock, "KEY" + cmd.upper())
                    time.sleep(0.8)
                    send_line(sock, "LSTATUS")
                elif cmd == "l":
                    send_line(sock, "LSTATUS")
                elif cmd == "a":
                    send_line(sock, "ASTATUS")
                elif cmd == "q":
                    send_line(sock, "ASTATUS")
                    time.sleep(1.5)
                    state = last_astatus["value"] or "unknown"
                    if "Y" in state[1:]:
                        print(f"  WARNING: the panel reports ARMED ({state}). Disarm it before leaving.")
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
