#!/usr/bin/env node

/**
 * Version bump utility.
 * Usage: node scripts/version.js [major|minor|patch]
 * Bumps version in package.json, creates a git commit and tag.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

const type = process.argv[2] || 'patch';
if (!['major', 'minor', 'patch'].includes(type)) {
  console.error('Usage: node scripts/version.js [major|minor|patch]');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const newVersion = type === 'major' ? `${major + 1}.0.0`
  : type === 'minor' ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Version bumped: ${pkg.version.replace(newVersion, '')}${major}.${minor}.${patch} → ${newVersion}`);

try {
  execSync('git add package.json', { stdio: 'inherit' });
  execSync(`git commit -m "chore: release v${newVersion}"`, { stdio: 'inherit' });
  execSync(`git tag v${newVersion}`, { stdio: 'inherit' });
  console.log(`\nCreated tag v${newVersion}`);
  console.log(`Run 'git push && git push --tags' to trigger the build.`);
} catch {
  console.log(`\npackage.json updated to ${newVersion}, but git operations skipped.`);
  console.log(`Manually commit and tag with: git tag v${newVersion}`);
}
