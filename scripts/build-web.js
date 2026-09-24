const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('📦 Building web production bundle for Capacitor...');

// Minify JS and CSS
try {
  execSync('npx esbuild app.js --minify --outfile=app.min.js', { stdio: 'inherit' });
  execSync('npx esbuild style.css --minify --outfile=style.min.css', { stdio: 'inherit' });
} catch (e) {
  console.error('Minification warning:', e.message);
}

const wwwDir = path.join(__dirname, '..', 'www');
if (!fs.existsSync(wwwDir)) {
  fs.mkdirSync(wwwDir, { recursive: true });
}

const filesToCopy = [
  'index.html',
  'style.css',
  'style.min.css',
  'app.js',
  'app.min.js',
  'manifest.json',
  'sw.js',
  'dummy.jpg',
  'cricket_bg.png'
];

filesToCopy.forEach(file => {
  const src = path.join(__dirname, '..', file);
  const dest = path.join(wwwDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ Copied ${file} -> www/`);
  }
});

console.log('✅ Web bundle built successfully in www/');
