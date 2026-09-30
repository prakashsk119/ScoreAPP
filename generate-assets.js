const sharp = require('sharp');
const fs = require('fs');

async function convert() {
  const svg = fs.readFileSync('app-icon.svg');
  await sharp(svg).resize(1024, 1024).png().toFile('assets/icon.png');
  await sharp(svg).resize(2732, 2732).png().toFile('assets/splash.png');
  console.log('Generated assets/icon.png and assets/splash.png');
}
convert().catch(console.error);
