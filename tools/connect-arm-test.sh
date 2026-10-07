#!/bin/bash
# Arms and disarms the REAL panel through a test Homebridge running the plugin
# in Connect mode. Only run with the owner present and agreeing, everyone clear
# of armed zones (Night = Part Arm 1 on the test system arms downstairs).
#
#   tools/connect-arm-test.sh <hap-port> <area-aid> [pin]
#
# Sequence: Night -> wait until armed -> wait HOLD seconds (default 5) -> Off
# -> wait until disarmed. Works for Connect and Crestron mode alike.
# Prints HomeKit current/target every second so "Arming..." and the
# transitions are visible. Ctrl+C at any time, then disarm at the keypad.
set -u
PORT=${1:?hap port}; AID=${2:?area aid}; PIN=${3:-031-45-154}
read -r -p "This will ARM the real alarm (Night). Everyone clear of armed zones? Type ARM to continue: " ok
[ "$ok" = "ARM" ] || { echo "aborted"; exit 1; }
get() { curl -s -m 5 -H "Authorization: $PIN" "localhost:$PORT/characteristics?id=$AID.10,$AID.11" |
  python3 -c "import json,sys;c=json.load(sys.stdin)['characteristics'];n={0:'stay',1:'away',2:'night',3:'disarmed',4:'TRIGGERED'};print('current='+n[c[0]['value']],'target='+n.get(c[1]['value'],c[1]['value']))"; }
put() { curl -s -m 30 -o /dev/null -w "%{http_code}" -X PUT "localhost:$PORT/characteristics" -H "Authorization: $PIN" \
  -H 'Content-Type: application/json' -d "{\"characteristics\":[{\"aid\":$AID,\"iid\":11,\"value\":$1}]}"; }
watch_until() { for i in $(seq 1 "$2"); do s=$(get); echo "  $(date +%T) $s"; [[ $s == current=$1* ]] && return 0; sleep 1; done; return 1; }
echo "$(date +%T) start: $(get)"
code=$(put 2); echo "$(date +%T) Night -> HTTP $code"
[ "$code" = "204" ] || { echo "Night was rejected (HTTP $code); nothing was armed. Stopping."; exit 1; }
watch_until night 40 || echo "  did not reach Night within 40 s"
sleep "${HOLD:-5}"
code=$(put 3); echo "$(date +%T) Off -> HTTP $code"
[ "$code" = "204" ] || echo "  Off was rejected (HTTP $code) - DISARM AT THE KEYPAD"
watch_until disarmed 20 || echo "  did not reach Disarmed within 20 s - DISARM AT THE KEYPAD"
echo "$(date +%T) end: $(get)"
