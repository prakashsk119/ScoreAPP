const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Building web production bundle for Capacitor...');

try {
  execSync('npx esbuild app.js --minify --outfile=app.min.js', { stdio: 'inherit' });
  execSync('npx esbuild features.js --minify --outfile=features.min.js', { stdio: 'inherit' });
  execSync('npx esbuild style.css --minify --outfile=style.min.css', { stdio: 'inherit' });
} catch (e) {
  console.error('Minification warning:', e.message);
}

const wwwDir = path.join(__dirname, '..', 'www');
if (fs.existsSync(wwwDir)) {
  fs.rmSync(wwwDir, { recursive: true, force: true });
}
fs.mkdirSync(wwwDir, { recursive: true });

const filesToCopy = [
  'index.html',
  'style.css',
  'style.min.css',
  'app.js',
  'app.min.js',
  'features.js',
  'features.min.js',
  'manifest.json',
  'sw.js',
  'dummy.jpg',
  'app-icon.svg'
];

async function build() {
  for (const file of filesToCopy) {
    const src = path.join(__dirname, '..', file);
    const dest = path.join(wwwDir, file);
    if (fs.existsSync(src)) {
      if (file === 'index.html') {
        const { minify } = require('html-minifier-terser');
        const htmlContent = fs.readFileSync(src, 'utf8');
        const minifiedHtml = await minify(htmlContent, {
          collapseWhitespace: true,
          removeComments: true,
          minifyCSS: true,
          minifyJS: true
        });
        fs.writeFileSync(dest, minifiedHtml);
        console.log(`  Copied and minified ${file} -> www/`);
      } else {
        fs.copyFileSync(src, dest);
        console.log(`  Copied ${file} -> www/`);
      }
    }
  }
  console.log('Web bundle built successfully in www/');
}

build();

