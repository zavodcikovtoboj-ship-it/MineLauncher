'use strict';

// Dry-run of the launcher core: manifest -> version -> libraries -> args.
// Downloads nothing; only resolves metadata.

const path = require('path');
const os = require('os');

const { Mojang } = require('../electron/core/mojang');
const { collectLibraries } = require('../electron/core/libraries');
const { flattenArgs, substitute } = require('../electron/core/launcher');

(async () => {
  const cache = path.join(os.tmpdir(), 'mclauncher-test-cache');
  const mojang = new Mojang(cache);

  console.log('fetching manifest...');
  const manifest = await mojang.getManifest({ force: true });
  console.log('latest:', manifest.latest, 'versions:', manifest.versions.length);

  const latest = manifest.versions.find((v) => v.id === manifest.latest.release);
  const version = await mojang.getVersionJson(latest.url);
  console.log('version:', version.id, 'type:', version.type, 'main:', version.mainClass);
  console.log('java:', JSON.stringify(version.javaVersion));
  console.log('assets:', JSON.stringify(version.assetIndex));

  const libDir = path.join(os.tmpdir(), 'mclauncher-test-libs');
  const { classpath, downloads, natives } = collectLibraries(version, libDir);
  console.log('classpath entries:', classpath.length);
  console.log('downloads:', downloads.length, 'natives:', natives.length);
  console.log('sample classpath:', classpath.slice(0, 2));
  console.log('sample native:', natives.slice(0, 2));

  const nativesDir = path.join(os.tmpdir(), 'mclauncher-test-natives');
  const vars = {
    auth_player_name: 'Player',
    version_name: version.id,
    game_directory: path.join(os.tmpdir(), 'mcgame'),
    assets_root: path.join(os.tmpdir(), 'mcassets'),
    game_assets: path.join(os.tmpdir(), 'mcassets', 'virtual', 'legacy'),
    assets_index_name: version.assetIndex?.id || 'legacy',
    auth_uuid: '00000000000000000000000000000000',
    auth_access_token: '0',
    auth_session: '0',
    auth_xuid: '',
    clientid: '',
    user_type: 'legacy',
    version_type: version.type,
    natives_directory: nativesDir,
    launcher_name: 'MineLauncher',
    launcher_version: '1.0.0',
    classpath: [...classpath, path.join(os.tmpdir(), 'client.jar')].join(';'),
    user_properties: '{}',
    resolution_width: '1280',
    resolution_height: '720',
  };

  const jvm = flattenArgs(version.arguments?.jvm, vars, {});
  const game = flattenArgs(version.arguments?.game, vars, {});
  console.log('jvm args:', jvm.length, jvm.slice(0, 6));
  console.log('has classpath flag:', jvm.includes('-cp') || jvm.includes('-classpath'));
  console.log('game args:', game.length, game.slice(0, 10));
  console.log('unresolved vars jvm:', jvm.filter((a) => a.includes('${')));
  console.log('unresolved vars game:', game.filter((a) => a.includes('${')));

  const old = manifest.versions.find((v) => v.id === '1.5.2');
  if (old) {
    const oldVersion = await mojang.getVersionJson(old.url);
    const oldLibs = collectLibraries(oldVersion, libDir);
    console.log('1.5.2 classpath:', oldLibs.classpath.length, 'natives:', oldLibs.natives.length);
    console.log('1.5.2 native sample:', oldLibs.natives.slice(0, 2));
    const legacyArgs = (oldVersion.minecraftArguments || '').split(/\s+/).map((a) => substitute(a, vars));
    console.log('1.5.2 args:', legacyArgs.slice(0, 12));
    console.log('1.5.2 unresolved:', legacyArgs.filter((a) => a.includes('${')));
  }
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
