#!/usr/bin/env bash
set -euo pipefail

comment_id="${1:-}"
state="${2:-}"
detail="${3:-}"

if [[ -z "$comment_id" || "$comment_id" == "null" ]]; then
  exit 0
fi
if [[ -z "$state" ]]; then
  echo "Usage: $0 comment-id state [detail]" >&2
  exit 2
fi

requester="${REQUESTED_BY:-jingjing2222}"
revision="${TESTED_REPOSITORY:-${GITHUB_REPOSITORY}}@${TESTED_SHA:-${GITHUB_SHA}}"
run_link="${RUN_URL:-https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}}"
updated_at="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

body="$(printf '@%s Production E2E: %s\n\n- Suite: %s\n- Detail: %s\n- Revision: %s\n- Run: %s\n- Updated: %s\n' \
  "$requester" \
  "$state" \
  "${E2E_SUITE:-full}" \
  "${detail:-No detail}" \
  "$revision" \
  "$run_link" \
  "$updated_at")"

if ! gh api -X PATCH \
  "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
  -f body="$body" \
  >/dev/null; then
  echo "Warning: failed to update E2E progress comment ${comment_id}" >&2
fi
