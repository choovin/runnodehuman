#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

function formatLocalBuildDate(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

function buildAppVersionFromArtifactDate(buildDate) {
  const [year, month, day] = buildDate.split('.');
  return `${Number(year)}.${Number(month)}.${Number(day)}`;
}

function resolveBuildDate() {
  const existing = process.env.WESIGHT_BUILD_DATE?.trim();
  if (!existing) return formatLocalBuildDate();
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(existing)) {
    throw new Error(`WESIGHT_BUILD_DATE must use YYYY.MM.DD format, received: ${existing}`);
  }
  return existing;
}

const buildDate = resolveBuildDate();
const appVersion = process.env.WESIGHT_APP_VERSION?.trim() || buildAppVersionFromArtifactDate(buildDate);
const electronBuilderCli = require.resolve('electron-builder/cli.js');
const args = [
  ...process.argv.slice(2),
  `-c.extraMetadata.version=${appVersion}`,
];

console.log(`[build] Using artifact date ${buildDate} and app version ${appVersion}.`);

const result = spawnSync(process.execPath, [electronBuilderCli, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    WESIGHT_BUILD_DATE: buildDate,
    WESIGHT_APP_VERSION: appVersion,
  },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
