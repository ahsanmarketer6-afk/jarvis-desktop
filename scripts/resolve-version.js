#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

async function getRemoteTags(owner, repo, token) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/tags?per_page=100`,
      method: 'GET',
      headers: {
        'User-Agent': 'jarvis-release-builder',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
              return resolve(parsed.map(t => t.name));
            }
          }
        } catch (e) {}
        resolve([]);
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function parseSemver(str) {
  const clean = str.replace(/^v/, '').trim();
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: clean
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

async function main() {
  const pkgPath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let currentVer = pkg.version || '1.2.0';

  console.log(`[Resolve-Version] Local package.json version: ${currentVer}`);

  const existingTags = new Set();

  // 1. Check local / git tags if available
  try {
    const gitTagsOut = execSync('git tag -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    gitTagsOut.split('\n').map(t => t.trim()).filter(Boolean).forEach(t => existingTags.add(t));
  } catch (e) {}

  // 2. Query GitHub API for remote tags
  const repoEnv = process.env.GITHUB_REPOSITORY || 'ahsanmarketer6-afk/jarvis-desktop';
  const [owner, repo] = repoEnv.split('/');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

  if (owner && repo) {
    const remoteTags = await getRemoteTags(owner, repo, token);
    remoteTags.forEach(t => existingTags.add(t));
  }

  console.log(`[Resolve-Version] Discovered ${existingTags.size} existing tags:`, Array.from(existingTags).join(', ') || '(none)');

  // 3. Find highest existing version
  let highest = parseSemver(currentVer);
  existingTags.forEach(tag => {
    const parsed = parseSemver(tag);
    if (parsed) {
      if (!highest || compareSemver(parsed, highest) >= 0) {
        highest = parsed;
      }
    }
  });

  let targetVersion = currentVer;

  // Check if current version or tag already exists
  if (existingTags.has(`v${targetVersion}`) || existingTags.has(targetVersion)) {
    console.log(`[Resolve-Version] ⚠️ Tag v${targetVersion} already exists in repository!`);
    const nextPatch = (highest ? highest.patch : parseInt(targetVersion.split('.')[2] || '0', 10)) + 1;
    const major = highest ? highest.major : 1;
    const minor = highest ? highest.minor : 2;
    targetVersion = `${major}.${minor}.${nextPatch}`;
    console.log(`[Resolve-Version] 🚀 Auto-incremented to next available version: ${targetVersion}`);
  } else if (highest && compareSemver(parseSemver(targetVersion), highest) <= 0) {
    targetVersion = `${highest.major}.${highest.minor}.${highest.patch + 1}`;
    console.log(`[Resolve-Version] 🚀 Bumping to surpass existing tag v${highest.raw} -> new version: ${targetVersion}`);
  } else {
    console.log(`[Resolve-Version] ✓ Version ${targetVersion} (v${targetVersion}) is fresh and does not conflict.`);
  }

  // 4. Update package.json
  pkg.version = targetVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[Resolve-Version] Updated package.json version to: ${targetVersion}`);

  // 5. Output to GitHub Environment
  const tag = `v${targetVersion}`;
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `VERSION=${targetVersion}\nTAG=${tag}\n`);
    console.log(`[Resolve-Version] Exported VERSION=${targetVersion} and TAG=${tag} to GITHUB_ENV`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${targetVersion}\ntag=${tag}\n`);
  }

  console.log(`[Resolve-Version] Finished successfully. Target Release: ${tag}`);
}

main().catch(err => {
  console.error('[Resolve-Version] Error:', err);
  process.exit(1);
});
