const { packager } = require('@electron/packager');

// Usage:
//   node build-portable.js            -> build pour la plateforme courante
//   node build-portable.js win32 x64  -> build Windows 64 bits
//   node build-portable.js darwin arm64 -> build macOS Apple Silicon (M1/M2/M3)
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || (process.arch === 'arm64' ? 'arm64' : 'x64');

packager({
  dir: '.',
  name: 'IPTV Live',
  platform,
  arch,
  out: 'portable',
  overwrite: true,
  asar: { unpack: '**/ffmpeg-static/**' },
  ignore: /(^\/portable)|(^\/dist)|(\.log$)|(build-portable\.js)/
}).then((paths) => {
  console.log('DONE:', paths.join(', '));
}).catch((e) => {
  console.error('ERR:', e);
  process.exit(1);
});
