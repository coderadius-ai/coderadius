import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';

console.log('Starting Node SEA build process...');

// Step 1: Run tsup build to make sure we have the latest dist/cli.cjs
console.log('Running tsup build...');
execSync('npx tsup', { stdio: 'inherit' });

// Ensure dist output exists
const distFile = join(process.cwd(), 'dist', 'cli.cjs');
if (!existsSync(distFile)) {
    console.error(`Error: ${distFile} not found. Build failed.`);
    process.exit(1);
}

// Step 2: Create release directory
const releaseDir = join(process.cwd(), 'release', 'sea');
if (!existsSync(releaseDir)) {
    mkdirSync(releaseDir, { recursive: true });
} else {
    readdirSync(releaseDir).forEach(file => {
        rmSync(join(releaseDir, file), { recursive: true, force: true });
    });
}

// Step 3: Create patched CLI file and SEA config
console.log('Patching CLI file for SEA module resolution...');
const polyfill = `
// SEA Polyfill to intercept the local \`require\` injected by Node's embedder loader
var require = (function(origRequire) {
    const _Module = origRequire('node:module');
    let _fallbackRequire;
    try {
        _fallbackRequire = _Module.createRequire(process.execPath);
    } catch (err) {
        _fallbackRequire = origRequire;
    }

    const newRequire = function(id) {
        try {
            return origRequire(id);
        } catch (e) {
            if (e.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || e.code === 'MODULE_NOT_FOUND') {
                try {
                    return _fallbackRequire(id);
                } catch (e2) {
                    throw e;
                }
            }
            throw e;
        }
    };
    Object.assign(newRequire, origRequire);
    return newRequire;
})(require);
`;
const distContent = readFileSync(distFile, 'utf8');
// Strip shebang if present
const cleanContent = distContent.startsWith('#!') 
    ? distContent.substring(distContent.indexOf('\n') + 1) 
    : distContent;

const patchedFile = join(process.cwd(), 'dist', 'cli-sea-patched.cjs');
writeFileSync(patchedFile, polyfill + cleanContent);

console.log('Creating SEA config...');
const seaConfigPath = join(process.cwd(), 'sea-config.json');
const seaConfig = {
    main: "dist/cli-sea-patched.cjs",
    output: "sea-prep.blob",
    disableExperimentalSEAWarning: true
};
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

// Step 4: Generate the blob
console.log('Generating SEA blob...');
execSync(`node --experimental-sea-config ${seaConfigPath}`);

// Step 5: Copy Node executable
console.log('Copying Node executable...');
const executableName = process.platform === 'win32' ? 'radius.exe' : 'radius';
const executablePath = join(releaseDir, executableName);
// process.execPath gets the currently running node binary
copyFileSync(process.execPath, executablePath);

// Make the copy executable on Unix
if (process.platform !== 'win32') {
    execSync(`chmod +x ${executablePath}`);
}

// Step 6: Inject the blob using postject
console.log('Injecting blob with postject...');
const blobPath = join(process.cwd(), 'sea-prep.blob');
// The sentinel fuse is a fixed constant required by Node.js
const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
let postjectCmd = `npx postject ${executablePath} NODE_SEA_BLOB ${blobPath} --sentinel-fuse ${sentinelFuse}`;

if (process.platform === 'darwin') {
    postjectCmd += ' --macho-segment-name NODE_SEA';
}

execSync(postjectCmd, { stdio: 'inherit' });

if (process.platform === 'darwin') {
    console.log('Ad-hoc signing the binary for macOS Gatekeeper...');
    execSync(`codesign --sign - ${executablePath}`, { stdio: 'inherit' });
}

// Cleanup temp files
console.log('Cleaning up temporary SEA files...');
rmSync(seaConfigPath, { force: true });
rmSync(blobPath, { force: true });

// Step 7: Bundle all production dependencies alongside the binary
// Using ALL dependencies (not a curated subset) avoids missing peer/transitive deps.
// tsup already treeshakes pure-JS modules into the bundle; what's installed here
// are the ones that MUST be resolved at runtime (native addons, ESM-only packages, etc.)
console.log('Setting up runtime dependencies in release folder...');
const rootPkgJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

// Use every production dependency declared in package.json
const releaseDeps = rootPkgJson.dependencies || {};

const releasePkgJson = {
    name: rootPkgJson.name,
    version: rootPkgJson.version,
    description: rootPkgJson.description,
    repository: rootPkgJson.repository,
    dependencies: releaseDeps,
    overrides: rootPkgJson.overrides,
    bin: {
        radius: './radius'
    },
    publishConfig: {
        registry: "https://npm.pkg.github.com/"
    }
};

writeFileSync(join(releaseDir, 'package.json'), JSON.stringify(releasePkgJson, null, 2));

// Install only production dependencies locally so native modules are resolved next to the binary
console.log('Installing external dependencies in release directory...');
execSync('npm install --omit=dev --no-package-lock', { cwd: releaseDir, stdio: 'inherit' });

// Step 8: Copy config files
console.log('Copying configuration files...');
const filesToCopy = ['docker-compose.yml', '.env.example'];

for (const file of filesToCopy) {
    const src = join(process.cwd(), file);
    const dest = join(releaseDir, file);
    if (existsSync(src)) {
        copyFileSync(src, dest);
    }
}

// Step 9: Package into a distribution tarball (radius_OS_ARCH.tar.gz)
// The tarball contains the SEA binary + node_modules so native deps are resolved
// at runtime via the SEA polyfill's createRequire(process.execPath).
console.log('Packaging distribution tarball...');
const OS_KEY = platform() === 'darwin' ? 'darwin' : 'linux';
const ARCH_MAP = { 'x64': 'amd64', 'arm64': 'arm64' };
const ARCH_KEY = ARCH_MAP[arch()] ?? arch();
const tarballName = `coderadius_${OS_KEY}_${ARCH_KEY}.tar.gz`;
const tarballPath = join(process.cwd(), 'release', tarballName);

// Build the tarball from release/sea/ — include binary and node_modules
execSync(`tar czf "${tarballPath}" -C "${releaseDir}" radius node_modules`, { stdio: 'inherit' });

console.log(`\nSEA build complete.`);
console.log(`  Binary:  ./release/sea/${executableName}`);
console.log(`  Tarball: ./release/${tarballName}`);
console.log(`  Install: make publish`);
