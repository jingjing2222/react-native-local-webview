#!/usr/bin/env bash
set -euo pipefail

profile="${1:-}"
suite="${2:-full}"
origin="${3:-https://macmini.taile38920.ts.net:8443}"
if [[ "$profile" != "low" && "$profile" != "latest" ]]; then
  echo "Usage: $0 low|latest [full|smoke] [origin]" >&2
  exit 2
fi
if [[ "$suite" != "full" && "$suite" != "smoke" ]]; then
  echo "suite must be full or smoke" >&2
  exit 2
fi

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

artifact_root="${BENCHMARK_ARTIFACTS:-e2e/artifacts}"
mkdir -p "$artifact_root"
run_id="android-${profile}-${GITHUB_RUN_ID:-local}-$(date -u +%Y%m%dT%H%M%SZ)"
result_path="$artifact_root/${run_id}.json"
memory_path="$artifact_root/${run_id}-memory.csv"
environment_path="$artifact_root/${run_id}-environment.txt"
emulator_log="$artifact_root/${run_id}-emulator.log"
apk="examples/showcase/android/app/build/outputs/apk/release/app-release.apk"

if [[ "$profile" == "low" ]]; then
  avd="local-webview-low-api34"
  memory_mib="2048"
  cores="2"
  emulator_port="${ANDROID_EMULATOR_PORT:-5580}"
else
  avd="local-webview-latest-api36"
  memory_mib="4096"
  cores="4"
  emulator_port="${ANDROID_EMULATOR_PORT:-5582}"
fi
emulator_serial="emulator-${emulator_port}"
adb_target=(adb -s "$emulator_serial")

emulator_serial_present() {
  adb devices | awk -v serial="$emulator_serial" '$1 == serial { found = 1 } END { exit !found }'
}

emulator_port_in_use() {
  lsof -nP -iTCP:"$emulator_port" -sTCP:LISTEN >/dev/null 2>&1
}

"${adb_target[@]}" emu kill >/dev/null 2>&1 || true
previous_emulator_stopped=0
for _ in $(seq 1 30); do
  if ! emulator_serial_present && ! emulator_port_in_use; then
    previous_emulator_stopped=1
    break
  fi
  sleep 1
done
if [[ "$previous_emulator_stopped" -ne 1 ]]; then
  echo "Android emulator serial or port did not become available: $emulator_serial" >&2
  exit 1
fi

emulator \
  -avd "$avd" \
  -port "$emulator_port" \
  -cores "$cores" \
  -memory "$memory_mib" \
  -no-window \
  -gpu swiftshader_indirect \
  -no-snapshot \
  -noaudio \
  -no-boot-anim \
  -camera-back none \
  >"$emulator_log" 2>&1 &
emulator_pid=$!

cleanup() {
  if [[ -n "${sampler_pid:-}" ]]; then
    kill "$sampler_pid" >/dev/null 2>&1 || true
    wait "$sampler_pid" 2>/dev/null || true
  fi
  "${adb_target[@]}" emu kill >/dev/null 2>&1 || true
  kill "$emulator_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

booted=0
for _ in $(seq 1 180); do
  if ! kill -0 "$emulator_pid" >/dev/null 2>&1; then
    echo "Android emulator exited before becoming ready. See $emulator_log." >&2
    exit 1
  fi
  if [[ "$("${adb_target[@]}" get-state 2>/dev/null || true)" == "device" ]] &&
    [[ "$("${adb_target[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
    booted=1
    break
  fi
  sleep 2
done
if [[ "$booted" -ne 1 ]]; then
  echo "Android emulator did not finish booting." >&2
  exit 1
fi

"${adb_target[@]}" shell settings put global window_animation_scale 0
"${adb_target[@]}" shell settings put global transition_animation_scale 0
"${adb_target[@]}" shell settings put global animator_duration_scale 0
"${adb_target[@]}" install -r "$apk"

{
  echo "profile=$profile"
  echo "avd=$avd"
  echo "configured_memory_mib=$memory_mib"
  echo "configured_cores=$cores"
  echo "serial=$emulator_serial"
  echo "sdk=$("${adb_target[@]}" shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "release=$("${adb_target[@]}" shell getprop ro.build.version.release | tr -d '\r')"
  echo "model=$("${adb_target[@]}" shell getprop ro.product.model | tr -d '\r')"
  echo
  "${adb_target[@]}" shell dumpsys webviewupdate
} >"$environment_path"

printf 'timestamp_ms,total_pss_kib,total_rss_kib\n' >"$memory_path"
(
  while true; do
    timestamp_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
    totals="$(
      "${adb_target[@]}" shell dumpsys meminfo localwebview.example 2>/dev/null |
        awk '/TOTAL PSS:/ {
          for (i = 1; i <= NF; i += 1) {
            if ($i == "PSS:" && $(i - 1) == "TOTAL") pss = $(i + 1)
            if ($i == "RSS:") rss = $(i + 1)
          }
        } END { printf "%s,%s", pss + 0, rss + 0 }'
    )"
    printf '%s,%s\n' "$timestamp_ms" "$totals" >>"$memory_path"
    sleep 2
  done
) &
sampler_pid=$!

benchmark_url="$(
  node -e '
    const [origin, runId, profile, suite] = process.argv.slice(1);
    const url = new URL("local-webview-benchmark://run");
    url.searchParams.set("origin", origin);
    url.searchParams.set("runId", runId);
    url.searchParams.set("platform", "android");
    url.searchParams.set("profile", profile);
    url.searchParams.set("suite", suite);
    process.stdout.write(url.href);
  ' "$origin" "$run_id" "$profile" "$suite"
)"

"${adb_target[@]}" logcat -c
"${adb_target[@]}" shell am force-stop localwebview.example
"${adb_target[@]}" shell am start \
  -W \
  -a android.intent.action.VIEW \
  -d "'$benchmark_url'" \
  -p localwebview.example

completed=0
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
  if "${adb_target[@]}" shell pidof localwebview.example >/dev/null 2>&1; then
    missing_process_polls=0
  else
    missing_process_polls=$((missing_process_polls + 1))
    if [[ "$missing_process_polls" -ge 3 ]]; then
      failure="Android benchmark process exited before completing."
      if "${adb_target[@]}" logcat -d | grep -q "Kill 'localwebview.example'"; then
        failure="Android low-memory killer terminated the benchmark process."
      fi
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
            process.stdout.write(JSON.stringify({ error, kind: "complete", platform, profile, runId, suite }));
          ' "$failure" android "$profile" "$run_id" "$suite"
        )" \
        http://127.0.0.1:4173/__control/complete \
        >/dev/null
      response="$(curl --fail --silent --show-error http://127.0.0.1:4173/__control/results)"
      printf '%s\n' "$response" >"$result_path"
      completed=1
      break
    fi
  fi
  sleep 2
done

kill "$sampler_pid" >/dev/null 2>&1 || true
wait "$sampler_pid" 2>/dev/null || true
sampler_pid=""
"${adb_target[@]}" logcat -d >"$artifact_root/${run_id}-logcat.txt"

if [[ "$completed" -ne 1 ]]; then
  curl --silent http://127.0.0.1:4173/__control/results >"$result_path" || true
  echo "Android benchmark timed out: $run_id" >&2
  exit 1
fi

node scripts/e2e/summarize-benchmark.mjs \
  "$result_path" \
  "$memory_path" \
  "$artifact_root/${run_id}.md"
