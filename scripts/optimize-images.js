const sharp = require('sharp');
const fs = require('fs');

async function optimize() {
  if (fs.existsSync('cricket_bg.png')) {
    await sharp('cricket_bg.png')
      .webp({ quality: 80 })
      .toFile('cricket_bg.webp');
    console.log('cricket_bg.png -> cricket_bg.webp');
  }
  
  if (fs.existsSync('dummy.jpg')) {
    await sharp('dummy.jpg')
      .webp({ quality: 80 })
      .toFile('dummy.webp');
    console.log('dummy.jpg -> dummy.webp');
  }
}

optimize().catch(console.error);
