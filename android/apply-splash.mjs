// Puts the real FieldCred logo on the TWA splash screen.
//
// WHY THIS EXISTS: Bubblewrap generates the splash images from `iconUrl` —
// the same source as the launcher icon (see TwaGenerator.js, SPLASH_IMAGES).
// There is no separate splash-image field, so the two cannot be given
// different artwork through twa-manifest.json alone.
//
// That matters because the launcher icon and the splash want different things.
// A launcher icon is 48dp and must stay a clean mark: the shield from
// js/components/logo.js, which is what assets/icon-512.png is. The splash has
// a whole screen, so it can carry the real logo — shield, wordmark and
// tagline (assets/logo.png).
//
// So: Bubblewrap generates shield splashes from the icon, and this script
// overwrites them with pre-rendered logo versions from android/splash/.
//
// RUN IT AFTER EVERY `bubblewrap update`. That command regenerates the whole
// res/ tree and will silently put the shield back. The build won't fail —
// you'd just ship the wrong splash and not notice until it's installed.
//
//   cd android
//   bubblewrap update
//   node apply-splash.mjs      <-- this
//   bubblewrap build
//
// The images in android/splash/ are pre-rendered and committed rather than
// generated here on demand, so this script needs no image library and stays
// consistent with the project's no-build, no-dependency rule. To regenerate
// them (new logo, different sizing), see the recipe at the bottom of this file.

import { copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Densities and pixel sizes are Bubblewrap's, not ours — they must match
// SPLASH_IMAGES in @bubblewrap/core's TwaGenerator.js or Android will scale
// the asset and the splash will look soft.
const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

let copied = 0;
let missingTargets = 0;

for (const density of DENSITIES) {
  const src = join(here, 'splash', `splash-${density}.png`);
  const destDir = join(here, 'app', 'src', 'main', 'res', `drawable-${density}`);
  const dest = join(destDir, 'splash.png');

  if (!existsSync(src)) {
    console.error(`  MISSING SOURCE  ${src}`);
    process.exitCode = 1;
    continue;
  }

  // No generated project yet — `bubblewrap update` hasn't run. Say so plainly
  // rather than creating the directory: a splash.png sitting in a res/ tree
  // that no build consumes is worse than an error, because it looks done.
  if (!existsSync(destDir)) {
    console.error(`  NO TARGET       ${destDir}  (run \`bubblewrap update\` first)`);
    missingTargets++;
    process.exitCode = 1;
    continue;
  }

  copyFileSync(src, dest);
  console.log(`  ${density.padEnd(8)} -> drawable-${density}/splash.png  (${statSync(dest).size.toLocaleString()} bytes)`);
  copied++;
}

if (missingTargets) {
  console.error(`\nNothing applied. Run \`bubblewrap update\` to generate the Android project first.`);
} else {
  console.log(`\nApplied the FieldCred logo splash to ${copied} densities.`);
  console.log(`Remember: \`bubblewrap update\` reverts this — re-run before \`bubblewrap build\`.`);
}

// ---------------------------------------------------------------------------
// Regenerating android/splash/*.png (needs Python + Pillow, hence not inline):
//
//   from PIL import Image
//   SIZES = {'mdpi':300,'hdpi':450,'xhdpi':600,'xxhdpi':900,'xxxhdpi':1200}
//   src = Image.open('assets/logo.png').convert('RGBA')
//   for density, size in SIZES.items():
//       c = Image.new('RGBA', (size,size), (255,255,255,255))
//       inner = int(size*0.80); off = (size-inner)//2
//       c.alpha_composite(src.resize((inner,inner), Image.LANCZOS), (off,off))
//       c.convert('RGB').save(f'android/splash/splash-{density}.png', optimize=True)
//
// Notes on those constants:
//   * Flattened onto opaque white, matching what Bubblewrap itself produces,
//     so the replacement is a drop-in with no edge seam against the splash
//     background.
//   * 0.80 rather than filling the frame: the logo carries a wordmark and
//     tagline, so it wants more breathing room than the bare shield does. It
//     also roughly halves the file size, since the detailed area shrinks with
//     the square of the scale.
//   * RGB, not RGBA — the canvas is opaque anyway, and dropping the alpha
//     channel costs nothing visually.
// ---------------------------------------------------------------------------
