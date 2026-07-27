#!/usr/bin/env bash
set -euo pipefail

suite="${1:-full}"
origin="${2:-https://macmini.taile38920.ts.net:8443}"
if [[ "$suite" != "full" && "$suite" != "smoke" ]]; then
  echo "Usage: $0 [full|smoke] [origin]" >&2
  exit 2
fi

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact_root="${BENCHMARK_ARTIFACTS:-e2e/artifacts}"
mkdir -p "$artifact_root"
run_id="ios-simulator-${GITHUB_RUN_ID:-local}-$(date -u +%Y%m%dT%H%M%SZ)"
result_path="$artifact_root/${run_id}.json"
memory_path="$artifact_root/${run_id}-memory.csv"
environment_path="$artifact_root/${run_id}-environment.txt"
app_path="$repo_root/examples/showcase/ios/build/Build/Products/Release-iphonesimulator/LocalWebviewExample.app"

simulator_udid="${SIMULATOR_UDID:-$(
  xcrun simctl list devices available |
    awk -F '[()]' '/iPhone/ { print $2; exit }'
)}"
if [[ -z "$simulator_udid" ]]; then
  echo "No available iPhone simulator found." >&2
  exit 1
fi

simulator_was_booted=0
if xcrun simctl list devices booted | grep -q "$simulator_udid"; then
  simulator_was_booted=1
fi

cleanup() {
  if [[ -n "${sampler_pid:-}" ]]; then
    kill "$sampler_pid" >/dev/null 2>&1 || true
    wait "$sampler_pid" 2>/dev/null || true
  fi
  xcrun simctl terminate "$simulator_udid" localwebview.example >/dev/null 2>&1 || true
  if [[ "$simulator_was_booted" -eq 0 ]]; then
    xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

xcrun simctl boot "$simulator_udid" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$simulator_udid" -b
xcrun simctl install "$simulator_udid" "$app_path"
xcrun simctl terminate "$simulator_udid" localwebview.example >/dev/null 2>&1 || true

find_app_process() {
  ps -ax -o pid=,ppid=,command= |
    awk -v parent="$simulator_launchd_pid" \
      '$2 == parent && $0 ~ /\/LocalWebviewExample\.app\/LocalWebviewExample$/ && app == "" {
        app = $1
      }
      END { print app }'
}

simulator_launchd_pid="$(
  ps -ax -o pid=,command= |
    awk -v udid="$simulator_udid" \
      'index($0, "launchd_sim ") && index($0, "/Devices/" udid "/") && launchd == "" {
        launchd = $1
      }
      END { print launchd }'
)"
if [[ -z "$simulator_launchd_pid" ]]; then
  echo "Could not identify launchd_sim for $simulator_udid." >&2
  exit 1
fi
baseline_webkit_pids="$(
  ps -ax -o pid=,ppid=,command= |
    awk -v parent="$simulator_launchd_pid" \
      '$2 == parent && $0 ~ /com\.apple\.WebKit\.(WebContent|GPU|Networking)/ {
        printf "%s,", $1
      }'
)"

{
  echo "profile=ios-simulator"
  echo "simulator_udid=$simulator_udid"
  echo "simulator_launchd_pid=$simulator_launchd_pid"
  xcrun simctl list devices | grep "$simulator_udid" || true
  echo "simulator_runtime_version=$(xcrun simctl getenv "$simulator_udid" SIMULATOR_RUNTIME_VERSION)"
  system_profiler SPHardwareDataType
} >"$environment_path"

printf 'timestamp_ms,host_rss_kib,webkit_rss_kib,total_rss_kib\n' >"$memory_path"
(
  while true; do
    timestamp_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
    process_id="$(find_app_process)"
    memory="$(
      ps -ax -o pid=,ppid=,rss=,command= |
        awk \
          -v app="$process_id" \
          -v baseline=",$baseline_webkit_pids" \
          -v parent="$simulator_launchd_pid" \
          '{
            if (app != "" && $1 == app) host += $3
            if ($2 == parent && $0 ~ /com\.apple\.WebKit\.(WebContent|GPU|Networking)/ && index(baseline, "," $1 ",") == 0) {
              webkit += $3
            }
          }
          END { printf "%d,%d,%d", host, webkit, host + webkit }'
    )"
    printf '%s,%s\n' "$timestamp_ms" "$memory" >>"$memory_path"
    sleep 2
  done
) &
sampler_pid=$!

benchmark_url="$(
  node -e '
    const [origin, runId, suite] = process.argv.slice(1);
    const url = new URL("local-webview-benchmark://run");
    url.searchParams.set("origin", origin);
    url.searchParams.set("runId", runId);
    url.searchParams.set("platform", "ios");
    url.searchParams.set("profile", "simulator");
    url.searchParams.set("suite", suite);
    process.stdout.write(url.href);
  ' "$origin" "$run_id" "$suite"
)"

SIMCTL_CHILD_LOCAL_WEBVIEW_BENCHMARK_URL="$benchmark_url" \
  xcrun simctl launch "$simulator_udid" localwebview.example

record_app_failure() {
  local failure="$1"
  curl --fail --silent --show-error \
    -H 'Content-Type: application/json' \
    -X POST \
    --data "$(node -e 'process.stdout.write(JSON.stringify({runId: process.argv[1]}))' "$run_id")" \
    http://127.0.0.1:4173/__control/reset \
    >/dev/null
  curl --fail --silent --show-error \
    -H 'Content-Type: application/json' \
    -X POST \
    --data "$(
      node -e '
        const [error, platform, profile, runId, suite] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({
          error,
          kind: "complete",
          platform,
          profile,
          runId,
          suite,
        }));
      ' "$failure" ios simulator "$run_id" "$suite"
    )" \
    http://127.0.0.1:4173/__control/complete \
    >/dev/null
  response="$(curl --fail --silent --show-error http://127.0.0.1:4173/__control/results)"
  printf '%s\n' "$response" >"$result_path"
  completed=1
}

completed=0
app_seen=0
launch_polls=0
missing_process_polls=0
for _ in $(seq 1 10800); do
  response="$(curl --fail --silent --show-error http://127.0.0.1:4173/__control/results || true)"
  current_run="$(jq -r '.runId // ""' <<<"$response" 2>/dev/null || true)"
  current_complete="$(jq -r '.completed == true' <<<"$response" 2>/dev/null || echo false)"
  if [[ "$current_run" == "$run_id" && "$current_complete" == "true" ]]; then
    printf '%s\n' "$response" >"$result_path"
    completed=1
    break
  fi
  if [[ -n "$(find_app_process)" ]]; then
    app_seen=1
    missing_process_polls=0
  elif [[ "$app_seen" -eq 1 ]]; then
    missing_process_polls=$((missing_process_polls + 1))
    if [[ "$missing_process_polls" -ge 3 ]]; then
      record_app_failure "The iOS benchmark process exited before completing."
      break
    fi
  else
    launch_polls=$((launch_polls + 1))
    if [[ "$launch_polls" -ge 30 ]]; then
      record_app_failure "The iOS benchmark process did not launch."
      break
    fi
  fi
  sleep 2
done

kill "$sampler_pid" >/dev/null 2>&1 || true
wait "$sampler_pid" 2>/dev/null || true
sampler_pid=""

if [[ "$completed" -ne 1 ]]; then
  curl --silent http://127.0.0.1:4173/__control/results >"$result_path" || true
  echo "iOS simulator benchmark timed out: $run_id" >&2
  exit 1
fi

node scripts/e2e/summarize-benchmark.mjs \
  "$result_path" \
  "$memory_path" \
  "$artifact_root/${run_id}.md"
