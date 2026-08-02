#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
suite="${2:-full}"
origin="${3:-https://macmini.taile38920.ts.net:8443}"

if [[ "$target" != "ios" && "$target" != "android-low" && "$target" != "android-latest" ]]; then
  echo "Usage: $0 ios|android-low|android-latest [full|smoke] [origin]" >&2
  exit 2
fi
if [[ "$suite" != "full" && "$suite" != "smoke" ]]; then
  echo "suite must be full or smoke" >&2
  exit 2
fi

artifact_root="${BENCHMARK_ARTIFACTS:-e2e/artifacts}"
mkdir -p "$artifact_root"
group="${target}-comparison-${GITHUB_RUN_ID:-local}-$(date -u +%Y%m%dT%H%M%SZ)"
remote_id="${group}-remote"
local_id="${group}-local"

if [[ "$target" == "ios" ]]; then
  BENCHMARK_RUN_ID="$remote_id" scripts/e2e/run-ios-benchmark.sh "$suite" "$origin" remote
  BENCHMARK_RUN_ID="$local_id" scripts/e2e/run-ios-benchmark.sh "$suite" "$origin" local
else
  profile="${target#android-}"
  BENCHMARK_RUN_ID="$remote_id" \
    scripts/e2e/run-android-benchmark.sh "$profile" "$suite" "$origin" remote
  BENCHMARK_RUN_ID="$local_id" \
    scripts/e2e/run-android-benchmark.sh "$profile" "$suite" "$origin" local
fi

node scripts/e2e/compare-benchmark.mjs \
  "$artifact_root/${remote_id}.json" \
  "$artifact_root/${remote_id}-memory.csv" \
  "$artifact_root/${local_id}.json" \
  "$artifact_root/${local_id}-memory.csv" \
  "$artifact_root/${group}.md"
