#!/usr/bin/env bash
# Builds, signs (Developer ID), notarizes and uploads a *draft* GitHub release
# for the version in VERSION. Review the draft on GitHub and press "Publish".
#
#   scripts/release.sh
#
# Prerequisites (one-time): see "Releasing" in README.md.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="v$VERSION"
ZIP="build/memable-$VERSION-macos.zip"

if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
    CODESIGN_IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
fi
[[ -n "$CODESIGN_IDENTITY" ]] || { echo "No 'Developer ID Application' certificate found" >&2; exit 1; }
export CODESIGN_IDENTITY

[[ -z "$(git status --porcelain)" ]] || { echo "Working tree is not clean. Commit first." >&2; exit 1; }
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || { echo "Release from main." >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || gh release view "$TAG" >/dev/null 2>&1; then
    echo "$TAG already exists. Bump VERSION first." >&2
    exit 1
fi

echo "==> Releasing memable $VERSION with: $CODESIGN_IDENTITY"
swift test
UNIVERSAL=1 scripts/build-app.sh
scripts/notarize.sh

git tag -a "$TAG" -m "memable $VERSION"
git push origin main "$TAG"
gh release create "$TAG" "$ZIP" --draft --title "memable $VERSION" --generate-notes
echo "==> Draft release created: $(gh release view "$TAG" --json url -q .url)"
