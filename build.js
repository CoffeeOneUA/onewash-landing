const fs = require('fs');
const path = require('path');

const dir = __dirname;
let html = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');

const tempDir = 'C:/Users/Artem/AppData/Local/Temp';
const oswald = fs.readFileSync(path.join(tempDir, 'fonts2/oswald.b64'), 'utf8').trim();
const golos = fs.readFileSync(path.join(tempDir, 'fonts2/golos.b64'), 'utf8').trim();
const logo = fs.readFileSync(path.join(tempDir, 'logo_transparent.b64'), 'utf8').trim();
const car1 = fs.readFileSync(path.join(tempDir, 'cars/car1.b64'), 'utf8').trim();
const car2 = fs.readFileSync(path.join(tempDir, 'cars/car2.b64'), 'utf8').trim();
const car3 = fs.readFileSync(path.join(tempDir, 'cars/car3.b64'), 'utf8').trim();
const favicon64 = fs.readFileSync(path.join(tempDir, 'favicon64.b64'), 'utf8').trim();
const favicon180 = fs.readFileSync(path.join(tempDir, 'favicon180.b64'), 'utf8').trim();

html = html.split('__OSWALD_B64__').join(oswald);
html = html.split('__GOLOS_B64__').join(golos);
html = html.split('__LOGO_B64__').join(logo);
html = html.split('__CAR1_B64__').join(car1);
html = html.split('__CAR2_B64__').join(car2);
html = html.split('__CAR3_B64__').join(car3);
html = html.split('__FAVICON64_B64__').join(favicon64);
html = html.split('__FAVICON180_B64__').join(favicon180);

fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log('done, size:', fs.statSync(path.join(dir, 'index.html')).size);
