// Creates a new draft post from docs/post-template.md.
//   node new-post.mjs "How DNS works"
// The file is content/posts/<slug>.md, marked draft: true so it is never published by accident.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const title = process.argv.slice(2).join(' ').trim();

if (!title) {
  console.error('Usage: node new-post.mjs "Your post title"');
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

if (!slug) {
  console.error('The title needs at least one letter or digit.');
  process.exit(1);
}

const file = join(ROOT, 'content', 'posts', `${slug}.md`);
if (existsSync(file)) {
  console.error(`content/posts/${slug}.md already exists. Pick a different title or edit that file.`);
  process.exit(1);
}

const date = new Date().toLocaleDateString('en-CA');
const body = readFileSync(join(ROOT, 'docs', 'post-template.md'), 'utf8')
  .replaceAll('{{title}}', title)
  .replaceAll('{{date}}', date);

writeFileSync(file, body);
console.log(`Created content/posts/${slug}.md (draft)`);
console.log('Preview it with:  node build.mjs --serve');
