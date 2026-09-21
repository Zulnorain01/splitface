// Screenshot SplitFace mockups via playwright-core + system Chromium
const { chromium } = require('/home/hatch/.npm/_npx/705bc6b22212b352/node_modules/playwright-core');

const SHOTS = [
  ['01-upload-desktop',   '01-upload.html',          1440, 1000],
  ['02-editor-desktop',   '02-editor.html',          1440, 1100],
  ['03-export-desktop',   '03-export.html',          1440, 1000],
  ['05-errors-desktop',   '05-errors.html',          1440, 1000],
  ['06-unlocked-desktop', '06-export-unlocked.html', 1440, 1000],
  ['04-mobile-390',       '04-mobile.html',          390,  844],
];

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/meta-chromium/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const outDir = '/home/hatch/workspace/trend-builds/splitface/design/screenshots';
  for (const [name, file, w, h] of SHOTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await page.goto('file:///home/hatch/workspace/trend-builds/splitface/design/mockups/' + file, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/${name}.png` });
    console.log('saved', name);
    await page.close();
  }
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
