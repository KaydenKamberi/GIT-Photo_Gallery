// The flower manifest: the single source of truth for what is in the gallery.
//
// FROZEN FILE — see CONTRACTS.md. Do not edit while parallel work is in
// progress; ask the repo owner if you need a change here.

const path = require('path');
const { readJson } = require('./cache');

const MANIFEST_FILE = path.join(__dirname, '..', 'flowers.json');
const EMPTY = { imageDir: 'Images', colors: [] };

// Read on every call rather than caching in memory, so editing flowers.json
// takes effect without restarting the server. The file is small.
function loadManifest() {
  return readJson(MANIFEST_FILE, EMPTY);
}

// Every flower as a flat array, each with its color id and label attached:
//   { file, name, alt, color, colorLabel }
function listFlowers() {
  const manifest = loadManifest();
  const flowers = [];
  for (const color of manifest.colors || []) {
    for (const flower of color.flowers || []) {
      flowers.push({
        file: flower.file,
        name: flower.name,
        alt: flower.alt || flower.name,
        color: color.id,
        colorLabel: color.label,
      });
    }
  }
  return flowers;
}

// Look up one flower by filename. Returns null if it is not in the manifest.
function findFlower(file) {
  if (typeof file !== 'string' || !file) {
    return null;
  }
  return listFlowers().find(flower => flower.file === file) || null;
}

// Is this filename in the manifest?
//
// This is the allowlist the whole app leans on. Any filename arriving from a
// request body, a query string, or a model response must pass through here
// before it is used to read a file or build a URL. It rejects path traversal
// and model-invented filenames alike, because a name is valid only if it is
// literally listed in flowers.json.
function isValidFile(file) {
  return findFlower(file) !== null;
}

// Absolute path to a flower image on disk. Throws for anything not in the
// manifest, so an unchecked caller fails loudly rather than reading an
// arbitrary file.
function imagePath(file) {
  const flower = findFlower(file);
  if (!flower) {
    throw new Error('Not a gallery image: ' + file);
  }
  const manifest = loadManifest();
  const imageDir = manifest.imageDir || 'Images';
  return path.join(__dirname, '..', imageDir, flower.file);
}

// MIME type for a flower image, from its extension. The Groq API needs this
// to build the data URI; hardcoding image/jpeg breaks the moment a .png is
// added to the gallery.
function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

module.exports = {
  MANIFEST_FILE,
  loadManifest,
  listFlowers,
  findFlower,
  isValidFile,
  imagePath,
  mimeType,
};
