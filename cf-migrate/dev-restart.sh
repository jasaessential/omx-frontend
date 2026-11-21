#!/bin/sh
# Restart the local omx-api dev server on :8799 (only the one this script started)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'wrangler.*dev --port 8799' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" 
cd /d/SwiftMind/JASA-V2/JASA-V2/cf
export XDG_CONFIG_HOME="D:/SwiftMind/.wrangler-jasa"
nohup npx wrangler dev --port 8799 --test-scheduled > /tmp/omx-dev.log 2>&1 &
for i in $(seq 1 40); do sleep 1; grep -q "Ready on\|ERROR" /tmp/omx-dev.log && break; done
grep -v "Environment Variable" /tmp/omx-dev.log | tail -${1:-8}
