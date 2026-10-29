'use strict';

// Images for a vision-model task (2026-10-15, Grimmethy: describe a sprite with qwen3-vl through
// Agent Manager). A task source puts absolute file paths in `promptContext.imagePaths`; the
// draft context reads them and hands base64 strings to Ollama's /api/generate `images` field, so a
// task can show its model a picture without the picture living in the task JSON.
//
// An unreadable image THROWS: a vision call that silently loses its picture answers from the
// text alone and invents a description, which is worse than a blocked task.

const fs = require('fs');
const path = require('path');

const MAX_IMAGES = 4;
const MAX_BYTES = 10 * 1024 * 1024;
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function loadTaskImages(promptContext) {
  const paths = promptContext && promptContext.imagePaths;
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new Error('promptContext.imagePaths must be an array of absolute file paths');
  if (paths.length > MAX_IMAGES) throw new Error(`promptContext.imagePaths holds ${paths.length} images; the limit is ${MAX_IMAGES}`);
  return paths.map((p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`task image path must be absolute: ${JSON.stringify(p)}`);
    if (!EXTS.has(path.extname(p).toLowerCase())) throw new Error(`task image must be png/jpg/webp: ${p}`);
    let st;
    try { st = fs.statSync(p); } catch (e) { throw new Error(`task image unreadable: ${p} (${e.code || e.message})`); }
    if (!st.isFile()) throw new Error(`task image is not a file: ${p}`);
    if (st.size > MAX_BYTES) throw new Error(`task image too large (${st.size} bytes, limit ${MAX_BYTES}): ${p}`);
    return fs.readFileSync(p).toString('base64');
  });
}

module.exports = { loadTaskImages, MAX_IMAGES, MAX_BYTES };
