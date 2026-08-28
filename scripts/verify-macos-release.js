const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const packageJson = require('../package.json');
const expectedBundleId = packageJson.forge?.packagerConfig?.appBundleId;
const archivePath = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (process.platform !== 'darwin') {
    throw new Error('macOS release verification must run on macOS.');
}
if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error('Usage: npm run verify:release:macos -- /path/to/release.zip');
}
if (!expectedBundleId) {
    throw new Error('forge.packagerConfig.appBundleId must be explicitly configured.');
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memable-release-verify-'));

function findAppBundles(directory) {
    const bundles = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (!entry.isDirectory()) continue;
        if (entry.name.endsWith('.app')) {
            bundles.push(entryPath);
        } else {
            bundles.push(...findAppBundles(entryPath));
        }
    }
    return bundles;
}

try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archivePath, tempDirectory]);
    const appBundles = findAppBundles(tempDirectory);
    if (appBundles.length !== 1) {
        throw new Error(`Expected exactly one app bundle, found ${appBundles.length}.`);
    }

    const appPath = appBundles[0];
    const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
    const bundleId = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', infoPlist], { encoding: 'utf8' }).trim();
    const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', infoPlist], { encoding: 'utf8' }).trim();
    const executableName = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', infoPlist], { encoding: 'utf8' }).trim();
    const executablePath = path.join(appPath, 'Contents', 'MacOS', executableName);
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', executablePath], { encoding: 'utf8' }).trim().split(/\s+/);

    if (bundleId !== expectedBundleId) {
        throw new Error(`Bundle ID mismatch: expected ${expectedBundleId}, got ${bundleId}.`);
    }
    if (version !== packageJson.version) {
        throw new Error(`Version mismatch: expected ${packageJson.version}, got ${version}.`);
    }
    if (!architectures.includes('arm64')) {
        throw new Error(`Expected arm64 executable, got ${architectures.join(', ')}.`);
    }

    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log(`Verified ${path.basename(archivePath)}: version=${version}, bundleId=${bundleId}, arch=${architectures.join(',')}, signature=valid`);
} finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}
