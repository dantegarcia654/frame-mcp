// Audio packs: soundtracks and sound effects saved inside Frame, so a sound you used once is one call away next time.
// A pack is a folder in FRAME_HOME/packs/<id>/ with a pack.json manifest and the audio files themselves.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, round, mkdirp } from './util.js';
import * as media from './media.js';

const root = () => mkdirp(path.join(HOME, 'packs'));
const slug = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const manifest = (id) => path.join(root(), id, 'pack.json');

export function getPack(id) {
  const f = manifest(slug(id)); if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
export function listPacks() {
  return fs.readdirSync(root()).map((id) => { try { return getPack(id); } catch { return null; } }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function packFile(pack, itemId) {
  const it = pack.items.find((i) => i.id === itemId); if (!it) throw new Error(`Pack "${pack.id}" has no item "${itemId}". Items: ${pack.items.map((i) => i.id).join(', ')}`);
  return path.join(root(), pack.id, it.file);
}

/** items: [{path, name?, kind?: "music"|"sfx", desc?, source?}] — files are copied into the pack, so it keeps working if the originals move. */
export async function savePack({ name, description, items }) {
  if (!name) throw new Error('A pack needs a name.');
  if (!Array.isArray(items) || !items.length) throw new Error('frame_pack save needs items: [{path, name?, kind?, desc?, source?}].');
  const id = slug(name), dir = mkdirp(path.join(root(), id));
  const pack = getPack(id) || { id, name, description: '', createdAt: Date.now(), items: [] };
  if (description) pack.description = description;
  const saved = [];
  for (const it of items) {
    if (!it.path || !fs.existsSync(it.path)) throw new Error(`File not found: ${it.path}`);
    const info = await media.probe(it.path);
    if (!info.hasAudio && info.kind !== 'audio') throw new Error(`${it.path} has no audio.`);
    const iid = slug(it.name || path.basename(it.path)), ext = path.extname(it.path) || '.wav', file = `${iid}${ext}`;
    fs.copyFileSync(it.path, path.join(dir, file));
    const rec = { id: iid, name: it.name || iid, file, kind: it.kind || (info.duration > 20 ? 'music' : 'sfx'), duration: round(info.duration, 2), desc: it.desc || '', source: it.source || path.basename(it.path), addedAt: Date.now() };
    const at = pack.items.findIndex((i) => i.id === iid); if (at >= 0) pack.items[at] = rec; else pack.items.push(rec);
    saved.push(rec);
  }
  pack.updatedAt = Date.now();
  fs.writeFileSync(manifest(id), JSON.stringify(pack, null, 2));
  return { pack, saved };
}
export const describePack = (p) => `${p.id} · "${p.name}"${p.description ? ` — ${p.description}` : ''} · ${p.items.length} item${p.items.length === 1 ? '' : 's'}\n` + p.items.map((i) => `    ${i.id} · ${i.kind} · ${i.duration}s${i.desc ? ` · ${i.desc}` : ''}`).join('\n');
