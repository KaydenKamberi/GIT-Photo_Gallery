// Atomic JSON file storage.
//
// FROZEN FILE — see CONTRACTS.md. Do not edit while parallel work is in
// progress; ask the repo owner if you need a change here.

const fs = require('fs');

// Read a JSON file, returning `fallback` if it is missing or unparseable.
// A corrupt file is never fatal: callers get the fallback and carry on.
function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading ' + filePath + ':', error);
    return fallback;
  }
}

// Write JSON to a temp file, then rename it into place. Rename is atomic, so
// a crash mid-write can't leave behind truncated JSON that readJson would
// discard entirely.
function writeJson(filePath, data) {
  const tempFile = filePath + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, filePath);
    return true;
  } catch (error) {
    console.error('Error writing ' + filePath + ':', error);
    try {
      fs.unlinkSync(tempFile);
    } catch (cleanupError) {
      // Temp file may not exist; nothing to clean up.
    }
    return false;
  }
}

// Read-modify-write in one step.
//
// USE THIS instead of readJson + writeJson whenever you are updating a file
// based on its existing contents. A snapshot taken before a slow await (a
// Groq call, say) is stale by the time the response arrives, and writing it
// back would clobber anything saved meanwhile by a request that finished
// first. This re-reads immediately before writing, so concurrent requests
// can't lose each other's entries.
//
// `mutator` receives the fresh contents and returns the value to write.
function updateJson(filePath, fallback, mutator) {
  const fresh = readJson(filePath, fallback);
  const updated = mutator(fresh);
  return writeJson(filePath, updated);
}

module.exports = { readJson, writeJson, updateJson };
