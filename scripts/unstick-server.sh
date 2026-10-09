#!/bin/sh
# Copyright 2026 Michael Pilosov. All rights reserved.
# Recover a wedged `make serve`.
#
# Symptom: the browser spins on localhost and the server prints no request line.
# The Python process is still listening, but it has stopped accepting connections.
# A cancelled export can also leave ffmpeg blocked on an unfinished file.
#
# Usage:
#   scripts/unstick-server.sh            # report; if the port is stuck, clear it
#   scripts/unstick-server.sh --stop-encoders
#   scripts/unstick-server.sh 1313
set -u

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
port=1313
stop_encoders=0
for arg in "$@"; do
    case $arg in
        --stop-encoders) stop_encoders=1 ;;
        --help|-h)
            echo "Usage: scripts/unstick-server.sh [--stop-encoders] [port]"
            exit 0
            ;;
        ''|*[!0-9]*)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
        *) port=$arg ;;
    esac
done

pending_encoders() {
    # pid and the pending path, one encoder per line. Only this repo's unfinished videos.
    pgrep -lf ffmpeg 2>/dev/null | while read -r pid command; do
        case $command in
            *"$root/videos/"*.pending.mp4|*"$root/videos/"*.pending.mkv)
                path=${command##* }
                printf '%s %s\n' "$pid" "$path"
                ;;
        esac
    done
}

echo "Checking http://127.0.0.1:$port/ ..."
if curl -sf -m 2 -o /dev/null "http://127.0.0.1:$port/"; then
    echo "Server is answering."
    encoders=$(pending_encoders || true)
    if [ -n "$encoders" ]; then
        echo "An unfinished export still has ffmpeg running:"
        printf '%s\n' "$encoders" | while read -r pid path; do
            echo "  pid $pid  $path"
        done
        if [ "$stop_encoders" -eq 1 ]; then
            printf '%s\n' "$encoders" | while read -r pid path; do
                kill "$pid" 2>/dev/null || true
                sleep 0.2
                kill -9 "$pid" 2>/dev/null || true
                rm -f -- "$path"
                echo "Stopped encoder $pid and removed $path"
            done
        else
            echo "Stop those encoders with: scripts/unstick-server.sh --stop-encoders"
        fi
    fi
    exit 0
fi

echo "No response within 2s. Listeners and half-open connections:"
lsof -nP -iTCP:"$port" 2>/dev/null || echo "  nothing has port $port open"
echo "Connection states on port $port:"
netstat -an -p tcp 2>/dev/null | awk -v port=".$port " 'index($0, port) { count[$6]++ } END { found=0; for (state in count) { print "  " count[state], state; found=1 } if (!found) print "  none" }'

encoders=$(pending_encoders || true)
if [ -n "$encoders" ]; then
    printf '%s\n' "$encoders" | while read -r pid path; do
        kill "$pid" 2>/dev/null || true
        sleep 0.2
        kill -9 "$pid" 2>/dev/null || true
        rm -f -- "$path"
        echo "Stopped leftover encoder $pid and removed $path"
    done
fi

server_pids=$(pgrep -f "studio/server.py --port $port" || true)
if [ -z "$server_pids" ]; then
    echo "No studio server is running. Start one with: make serve"
    exit 1
fi

for pid in $server_pids; do
    kill "$pid" 2>/dev/null || true
done
sleep 0.3
for pid in $server_pids; do
    kill -9 "$pid" 2>/dev/null || true
done
echo "Stopped the stuck server (pid $server_pids)."
echo "Start it again with: make serve"
echo "If Safari still spins after that, quit Safari with Cmd-Q and reopen the page."
