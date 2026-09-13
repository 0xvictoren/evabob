#!/usr/bin/env bash
#
# Which plugins still apply the Kotlin Gradle Plugin.
#
# Flutter now warns on every Android build that plugins applying KGP will stop
# building in a future release. The warning names the plugins but not their
# versions, and says nothing about whether a fixed version exists, so it is not
# actionable as printed. This is.
#
# Run it after any dependency change, and before taking a Flutter upgrade:
#   bash tool/check_kgp.sh
#
# A plugin is "clean" when its own android/ directory no longer applies the
# Kotlin plugin — that is what Flutter calls Built-in Kotlin. Nothing here is
# fixable in this repo: the only lever is upgrading a plugin to a version whose
# author has migrated, or reporting it to them if none exists.

set -u

cd "$(dirname "$0")/.." || exit 1

if [ ! -f pubspec.lock ]; then
  echo "no pubspec.lock — run 'flutter pub get' first" >&2
  exit 1
fi

# Pub's cache lives in different places per platform, and on Windows the Git
# Bash view of it needs the drive letter spelled out.
CACHE="${PUB_CACHE:-}"
if [ -z "$CACHE" ]; then
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) CACHE="$LOCALAPPDATA/Pub/Cache" ;;
    *) CACHE="$HOME/.pub-cache" ;;
  esac
fi
HOSTED="$CACHE/hosted/pub.dev"

if [ ! -d "$HOSTED" ]; then
  echo "pub cache not found at $HOSTED" >&2
  exit 1
fi

dirty=0
checked=0

# Every hosted package in the lock file, with its resolved version.
while read -r name version; do
  dir="$HOSTED/$name-$version/android"
  [ -d "$dir" ] || continue
  checked=$((checked + 1))
  # Applying the plugin is the thing that matters, not naming it. Several
  # first-party plugins (url_launcher_android, shared_preferences_android)
  # still declare a kotlin-gradle-plugin classpath but never apply it — they
  # already rely on Built-in Kotlin, and matching on the classpath alone
  # reports them as broken when they are not.
  if grep -rqE "apply[[:space:]]+plugin:[[:space:]]*['\"](kotlin-android|org\.jetbrains\.kotlin\.android)['\"]|apply\(plugin[[:space:]]*=[[:space:]]*\"(kotlin-android|org\.jetbrains\.kotlin\.android)\"\)|id[[:space:]]*\(?[[:space:]]*['\"](kotlin-android|org\.jetbrains\.kotlin\.android)['\"]|kotlin\(\"android\"\)" "$dir" 2>/dev/null; then
    printf 'applies KGP  %-28s %s\n' "$name" "$version"
    dirty=$((dirty + 1))
  fi
done < <(
  awk '
    /^  [a-zA-Z0-9_]+:$/ { pkg = $1; sub(/:$/, "", pkg) }
    pkg && /^    version: / { v = $2; gsub(/"/, "", v); print pkg, v; pkg = "" }
  ' pubspec.lock
)

echo
echo "$dirty of $checked packages with an android/ directory still apply KGP."
if [ "$dirty" -gt 0 ]; then
  echo "See docs/KOTLIN_GRADLE_PLUGIN.md for what is upstream and what is ours."
fi
