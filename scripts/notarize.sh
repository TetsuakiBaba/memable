#!/usr/bin/env bash
# Notarizes and staples build/memable.app using an App Store Connect API key
# (run after a Developer ID signed build).
#
# Credentials, in order of precedence:
#   1. Environment variables (handy for CI):
#        ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
#        ASC_KEY_ID=XXXXXXXXXX
#        ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   2. A keychain profile created once with (default name: memable-notary):
#        xcrun notarytool store-credentials memable-notary \
#            --key ~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 \
#            --key-id XXXXXXXXXX --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#
#   CODESIGN_IDENTITY="Developer ID Application: …" scripts/build-app.sh
#   scripts/notarize.sh
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(tr -d '[:space:]' < VERSION)"
APP="build/memable.app"
ZIP="build/memable-$VERSION-macos.zip"

[[ -d "$APP" && -f "$ZIP" ]] || { echo "Run scripts/build-app.sh first" >&2; exit 1; }

if [[ -n "${ASC_KEY_PATH:-}" || -n "${ASC_KEY_ID:-}" || -n "${ASC_ISSUER_ID:-}" ]]; then
    : "${ASC_KEY_PATH:?ASC_KEY_PATH is required}" "${ASC_KEY_ID:?ASC_KEY_ID is required}" "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required}"
    [[ -f "$ASC_KEY_PATH" ]] || { echo "API key not found: $ASC_KEY_PATH" >&2; exit 1; }
    AUTH=(--key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")
    echo "==> Using App Store Connect API key $ASC_KEY_ID"
else
    PROFILE="${NOTARY_PROFILE:-memable-notary}"
    AUTH=(--keychain-profile "$PROFILE")
    echo "==> Using keychain profile $PROFILE"
fi

echo "==> Submitting $ZIP"
RESULT="$(xcrun notarytool submit "$ZIP" "${AUTH[@]}" --wait --output-format json)"
SUBMISSION_ID="$(plutil -extract id raw -o - - <<< "$RESULT")"
STATUS="$(plutil -extract status raw -o - - <<< "$RESULT")"
echo "    submission $SUBMISSION_ID: $STATUS"
if [[ "$STATUS" != "Accepted" ]]; then
    echo "Notarization failed. Log:" >&2
    xcrun notarytool log "$SUBMISSION_ID" "${AUTH[@]}" >&2 || true
    exit 1
fi

xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# Re-zip so the distributed archive contains the stapled ticket.
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
spctl --assess --type execute --verbose "$APP"
echo "==> Notarized: $ZIP"
