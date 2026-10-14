#!/usr/bin/env bash
# Starts PulseAudio with the meeting's sink and a silent source, then a virtual display, then the bot program. The bot
# reads the run's token on stdin, so nothing started before it reads from stdin.
set -euo pipefail
mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH" "$PULSE_STATE_PATH"
# -n: the bot's script alone, without the system's default script (hardware detection, session tracking, restore modules)
pulseaudio -n --daemonize=no --exit-idle-time=-1 --file=/etc/pulse/bot.pa --log-target=stderr --log-level=error </dev/null &
for i in $(seq 1 100); do pactl info >/dev/null 2>&1 </dev/null && break; sleep 0.1; done
pactl set-default-sink meeting </dev/null
pactl set-default-source silence.monitor </dev/null
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp </dev/null &
for i in $(seq 1 100); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
export DISPLAY=:99
exec node /app/dist/bot.js
