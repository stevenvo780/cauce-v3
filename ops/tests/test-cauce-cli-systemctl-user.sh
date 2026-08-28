#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted grep patterns below are meant to stay literal
# (no login session) there is no XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS, so `systemctl --user`
# cannot reach the bus and fails -- and the old `systemctl --user start "$u" || true` swallowed
# that failure silently, leaving cmd_on to poll /proc for 120s over a unit that was never asked
# to start. Extracts the real `systemctl_user_o_avisa` helper out of ops/cli/cauce (not a copy)
# so this test tracks whatever ships, not a duplicate that can drift.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$HERE/../cli/cauce"

fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1" >&2; fail=1; }
assert_eq() { # $1=got $2=want $3=msg
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got='$1' want='$2')"; fi
}
assert_contains() { # $1=haystack $2=needle $3=msg
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3 (missing '$2' in: $1)" ;;
  esac
}

helper_src=$(awk '/^systemctl_user_o_avisa\(\) \{/{p=1} p{print; if (/^}$/) exit}' "$CLI")
[ -n "$helper_src" ] || { echo "FAIL: systemctl_user_o_avisa() not found in $CLI" >&2; exit 1; }
eval "$helper_src"

WORK=$(mktemp -d)
FAKE_UID_DIR=""
# shellcheck disable=SC2329  # invoked indirectly, via the EXIT trap below
cleanup() { rm -rf "$WORK"; [ -n "$FAKE_UID_DIR" ] && rm -rf "$FAKE_UID_DIR"; }
trap cleanup EXIT

BINDIR="$WORK/bin"
mkdir -p "$BINDIR"

# --- 1) reproduce the bug as it shipped: `... || true` hides a real systemctl failure --------
cat > "$BINDIR/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "Failed to connect to bus: No such file or directory" >&2
exit 1
EOF
chmod +x "$BINDIR/systemctl"

rc_old=0
(PATH="$BINDIR:$PATH" bash -c 'unset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; systemctl --user start bogus.service || true')
rc_old=$?
assert_eq "$rc_old" "0" "bug reproduced: old '|| true' pattern hides the real systemctl failure"

# --- 2) the fix: same broken systemctl, same missing env -> must fail LOUD (nonzero + message) -
err_new=$(PATH="$BINDIR:$PATH" bash -c "$(declare -f systemctl_user_o_avisa)
unset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
systemctl_user_o_avisa start bogus.service" 2>&1 1>/dev/null)
rc_new=$?
assert_eq "$rc_new" "1" "fixed: systemctl_user_o_avisa returns non-zero on a real systemctl failure"
assert_contains "$err_new" "systemctl --user start bogus.service" "fixed: failure message names the verb and unit"
assert_contains "$err_new" "Failed to connect to bus" "fixed: failure message carries the real systemctl error text"

# --- 3) root cause: XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS derived from /run/user/$(id -u) --
FAKE_UID=4294900037
FAKE_UID_DIR="/run/user/$FAKE_UID"
mkdir -p "$FAKE_UID_DIR"
python3 -c "import socket,sys
s=socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])" "$FAKE_UID_DIR/bus"

cat > "$BINDIR/id" <<EOF
#!/usr/bin/env bash
[ "\$1" = -u ] && { echo $FAKE_UID; exit 0; }
exec /usr/bin/id "\$@"
EOF
chmod +x "$BINDIR/id"

cat > "$BINDIR/systemctl" <<EOF
#!/usr/bin/env bash
echo "ENV_SEEN XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-} DBUS_SESSION_BUS_ADDRESS=\${DBUS_SESSION_BUS_ADDRESS:-}" >> "$WORK/env-seen.log"
exit 0
EOF
chmod +x "$BINDIR/systemctl"

PATH="$BINDIR:$PATH" bash -c "$(declare -f systemctl_user_o_avisa)
unset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
systemctl_user_o_avisa start real.service"
rc_derive=$?
seen=$(cat "$WORK/env-seen.log" 2>/dev/null)
assert_eq "$rc_derive" "0" "derivation: helper succeeds once env is derived and systemctl works"
assert_contains "$seen" "XDG_RUNTIME_DIR=$FAKE_UID_DIR" "derivation: XDG_RUNTIME_DIR derived from /run/user/\$(id -u)"
assert_contains "$seen" "DBUS_SESSION_BUS_ADDRESS=unix:path=$FAKE_UID_DIR/bus" "derivation: DBUS_SESSION_BUS_ADDRESS derived from the bus socket"

# --- 4) cmd_on/cmd_off actually call the helper instead of the old swallow-everything form ----
if grep -qF 'systemctl_user_o_avisa start "$u"' "$CLI"; then
  ok "cmd_on calls systemctl_user_o_avisa"
else
  bad "cmd_on does not call systemctl_user_o_avisa"
fi
if grep -qF 'systemctl_user_o_avisa stop "$u"' "$CLI"; then
  ok "cmd_off calls systemctl_user_o_avisa"
else
  bad "cmd_off does not call systemctl_user_o_avisa"
fi
if grep -qE 'systemctl --user (start|stop) "\$u" \|\| true' "$CLI"; then
  bad "the old '|| true' pattern is still present in $CLI"
else
  ok "the old '|| true' pattern is gone from cmd_on/cmd_off"
fi

if [ "$fail" = 0 ]; then echo "ALL OK"; else echo "SOME FAILED"; fi
exit "$fail"
