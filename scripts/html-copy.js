import fs from 'node:fs';
import path from 'node:path';

const files = ['index', 'access']

for (const file of files) {
  const html = fs.readFileSync(path.resolve(`./src/${file}.html`), 'utf-8');
  const ts = "export const "+file+"HTML = `"+html.replace(/\\/g, '\\\\')+"`";
  fs.mkdirSync(path.resolve(`./dist`), { recursive: true });
  fs.writeFileSync(path.resolve(`./dist/${file}.html.ts`), ts);
}

