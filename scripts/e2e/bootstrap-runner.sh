#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The production benchmark runner must be macOS." >&2
  exit 1
fi

GITHUB_ENV="${GITHUB_ENV:-/dev/null}"
GITHUB_PATH="${GITHUB_PATH:-/dev/null}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required on the self-hosted benchmark runner." >&2
  exit 1
fi
if ! command -v mise >/dev/null 2>&1; then
  brew install mise
fi

mise trust --yes
mise install java node ruby
mise reshim

node_binary="$(mise which node)"
corepack_binary="$(mise which corepack)"
ruby_binary="$(mise which ruby)"
mise_shims="$(mise where mise 2>/dev/null || true)"
java_home_value="$(mise where java)"

"$corepack_binary" enable
"$corepack_binary" prepare yarn@4.11.0 --activate

if ! mise which bundle >/dev/null 2>&1; then
  mise exec ruby -- gem install bundler --no-document
  mise reshim ruby
fi
if ! mise which pod >/dev/null 2>&1; then
  mise exec ruby -- gem install cocoapods --no-document
  mise reshim ruby
fi

android_home_value="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
if [[ ! -x "$android_home_value/cmdline-tools/latest/bin/sdkmanager" ]]; then
  brew install --cask android-commandlinetools
fi

{
  dirname "$node_binary"
  dirname "$ruby_binary"
  dirname "$(mise which bundle)"
  dirname "$(mise which pod)"
  echo "$android_home_value/emulator"
  echo "$android_home_value/platform-tools"
  echo "$android_home_value/cmdline-tools/latest/bin"
  echo "$java_home_value/bin"
  if [[ -n "$mise_shims" ]]; then echo "$mise_shims"; fi
} >> "$GITHUB_PATH"

{
  echo "ANDROID_HOME=$android_home_value"
  echo "ANDROID_SDK_ROOT=$android_home_value"
  echo "DEVELOPER_DIR=$DEVELOPER_DIR"
  echo "JAVA_HOME=$java_home_value"
} >> "$GITHUB_ENV"

export ANDROID_HOME="$android_home_value"
export ANDROID_SDK_ROOT="$android_home_value"
export JAVA_HOME="$java_home_value"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$JAVA_HOME/bin:$PATH"

set +o pipefail
yes | sdkmanager --licenses >/dev/null
license_status=$?
set -o pipefail
if [[ "$license_status" -ne 0 && "$license_status" -ne 141 ]]; then
  echo "Failed to accept Android SDK licenses." >&2
  exit "$license_status"
fi

sdkmanager \
  "platform-tools" \
  "emulator" \
  "platforms;android-34" \
  "platforms;android-36" \
  "build-tools;34.0.0" \
  "build-tools;36.0.0" \
  "system-images;android-34;google_apis;arm64-v8a" \
  "system-images;android-36;google_apis;arm64-v8a"

create_avd() {
  local name="$1"
  local image="$2"
  local device="$3"
  if avdmanager list avd | grep -q "^    Name: ${name}$"; then
    return
  fi
  echo no | avdmanager create avd \
    -n "$name" \
    -k "$image" \
    -d "$device" \
    --force
}

create_avd \
  "local-webview-low-api34" \
  "system-images;android-34;google_apis;arm64-v8a" \
  "small_phone"
create_avd \
  "local-webview-latest-api36" \
  "system-images;android-36;google_apis;arm64-v8a" \
  "pixel_9"

"$node_binary" --version
"$java_home_value/bin/java" -version
xcodebuild -version
adb version
emulator -version
avdmanager list avd
