import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import boxen from 'boxen';
import chalk from 'chalk';
import { paths } from '../config/paths.js';

const CACHE_FILE = paths.cache.updateCheck;
const CHECK_INTERVAL = 1000 * 60 * 60 * 24; // 24 hours
const LATEST_URL = 'https://api.github.com/repos/coderadius-ai/coderadius/releases/latest';

/**
 * Extracts the release tag from a GitHub `releases/latest` API response.
 * Returns null on malformed JSON or a tag that is not a semver.
 */
export function parseLatestReleaseTag(body: string): string | null {
    try {
        const tag: unknown = JSON.parse(body)?.tag_name;
        if (typeof tag === 'string' && /^v?[0-9]+\.[0-9]+\.[0-9]+/.test(tag)) {
            return tag;
        }
    } catch {
        // fall through
    }
    return null;
}

/**
 * Checks for updates asynchronously without blocking the CLI.
 * If an update was previously discovered, it displays a notification when the CLI exits.
 *
 * The daily version check is the CLI's only outbound network call besides the
 * user-configured LLM provider and graph database. Set CR_NO_UPDATE_CHECK=1
 * to disable it entirely.
 */
export function checkAndNotifyUpdate(currentVersion: string) {
    if (process.env.CR_NO_UPDATE_CHECK) return;
    let cache: any = {};
    try {
        if (fs.existsSync(CACHE_FILE)) {
            cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        }
    } catch {
        // Silently ignore cache read errors
    }

    const now = Date.now();

    // 1. If we know there's an update, register a process hook to notify the user
    if (cache.latestVersion && isNewerVersion(currentVersion, cache.latestVersion)) {
        displayUpdateMessage(currentVersion, cache.latestVersion);
    }

    // 2. Spawn a background fetch if cache is expired or missing
    if (!cache.lastChecked || (now - cache.lastChecked > CHECK_INTERVAL)) {
        try {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
            fs.writeFileSync(CACHE_FILE, JSON.stringify({
                ...cache,
                lastChecked: now
            }));
        } catch {}
        fetchLatestVersionAsync();
    }
}

function displayUpdateMessage(current: string, latest: string) {
    // Attach to the exit event so we don't interfere with command outputs (like JSON or CSV reports)
    process.on('exit', (code) => {
        // Only show if the command succeeded or exited cleanly
        if (code === 0) {
            const message =
                `Update available ${chalk.dim(current)} → ${chalk.green(latest)}\n` +
                `See ${chalk.cyan('https://github.com/coderadius-ai/coderadius/releases')}`;

            console.error('\n' + boxen(message, {
                padding: 1,
                margin: 1,
                align: 'center',
                borderColor: 'yellow',
                borderStyle: 'round'
            }));
        }
    });
}

function isNewerVersion(current: string, latest: string): boolean {
    const splitC = current.replace(/^v/, '').split('.').map(Number);
    const splitL = latest.replace(/^v/, '').split('.').map(Number);

    for (let i = 0; i < Math.max(splitC.length, splitL.length); i++) {
        const c = splitC[i] || 0;
        const l = splitL[i] || 0;
        if (l > c) return true;
        if (c > l) return false;
    }
    return false;
}


export function runBackgroundUpdater() {
    // GitHub's API rejects requests without a User-Agent.
    const options = {
        headers: {
            'User-Agent': 'coderadius-cli',
            'Accept': 'application/vnd.github+json',
        },
    };
    https.get(LATEST_URL, options, (res) => {
        if (res.statusCode === 200) {
            let data = '';
            res.on('data', c => { data += c });
            res.on('end', () => {
                const latestVersion = parseLatestReleaseTag(data);
                if (latestVersion) {
                    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
                    fs.writeFileSync(CACHE_FILE, JSON.stringify({
                        latestVersion,
                        lastChecked: Date.now()
                    }));
                }
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    }).on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
}

function fetchLatestVersionAsync() {
    try {
        const child = spawn(process.execPath, ['internal-update-fetch'], {
            detached: true,
            stdio: 'ignore'
        });
        
        // Unref the child so the parent can exit entirely independent of it
        child.unref();
    } catch {
        // Silently fail if we can't spawn
    }
}
