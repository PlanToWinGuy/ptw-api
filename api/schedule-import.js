import { sql } from '../lib/db.js';
import { cors } from '../lib/cors.js';
import { getUserFromRequest } from '../lib/auth.js';
import mammoth from 'mammoth';

// pdf-parse's underlying pdfjs-dist references DOMMatrix/ImageData/Path2D at module-load
// time to wire up its (optional, canvas-only) rendering path -- even though we only ever
// need text extraction. Without a real browser or the optional @napi-rs/canvas native
// binary present (which isn't reliably installable for Vercel's Linux runtime from a
// Windows-generated lockfile), referencing those globals throws a bare ReferenceError
// and crashes the whole module import. Minimal stand-in classes are enough to satisfy
// the reference; nothing here ever actually calls into them since we never render.
if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = class DOMMatrix {};
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = class ImageData {};
if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const VALID_DAYS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

// Extracts real recurring blocks from an uploaded schedule document's raw text (a class
// schedule, work shift schedule, sports/practice schedule, etc). AI does the semantic
// parsing (reading "MWF 10-11am" style shorthand); everything after this is deterministic
// validation, matching this codebase's established "AI reads, code enforces" pattern.
const SYSTEM = `You extract a real recurring weekly schedule from an uploaded schedule document's raw text. Return ONLY JSON, an array of real recurring time blocks:
[{"name": "<short activity name, e.g. 'Chemistry 101' or 'Evening Shift'>", "days": ["Monday","Wednesday","Friday"], "startTime": "<HH:MM 24h>", "endTime": "<HH:MM 24h>"}]
Only include commitments that are actually present in the text -- never invent one. Expand day-of-week shorthand ("MWF", "TTh", "M-F") to full day names. Times must be real 24-hour HH:MM. If the document has no real recurring schedule in it, return an empty array.`;

async function extractText(buffer, mediaType) {
  if (mediaType.includes('pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (mediaType.includes('word') || mediaType.includes('docx') || mediaType.includes('officedocument')) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return null;
}

function sanitizeBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter(b => b?.name && b?.startTime && b?.endTime)
    .map(b => ({
      name: String(b.name).slice(0, 80),
      days: Array.isArray(b.days) ? b.days.filter(d => VALID_DAYS.has(d)) : [],
      startTime: /^\d{2}:\d{2}$/.test(b.startTime) ? b.startTime : null,
      endTime: /^\d{2}:\d{2}$/.test(b.endTime) ? b.endTime : null,
    }))
    .filter(b => b.startTime && b.endTime);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: 'Unauthenticated' });

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM fixed_commitments WHERE user_id = ${user.id} ORDER BY start_time ASC`;
    return res.status(200).json(rows);
  }

  if (req.method === 'DELETE') {
    const id = Number(req.query.id);
    if (!id) return res.status(422).json({ message: 'id is required' });
    await sql`DELETE FROM fixed_commitments WHERE id = ${id} AND user_id = ${user.id}`;
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const action = req.query.action;

  if (action === 'parse') {
    const { file_base64, media_type, filename } = req.body || {};
    if (!file_base64 || !media_type) return res.status(422).json({ message: 'file_base64 and media_type are required' });

    let text;
    try {
      const buffer = Buffer.from(file_base64, 'base64');
      text = await extractText(buffer, media_type);
    } catch (e) {
      console.error('schedule-import.parse: text extraction failed', String(e));
      return res.status(422).json({ message: "Couldn't read that file — try a PDF or Word (.docx) document." });
    }
    if (text === null) return res.status(422).json({ message: 'Only PDF and Word (.docx) documents are supported right now.' });
    if (!text.trim()) return res.status(422).json({ message: "That file doesn't seem to have any readable text in it." });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ message: 'ANTHROPIC_API_KEY not set on the server' });

    let blocks = [];
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          temperature: 0.2,
          system: SYSTEM,
          messages: [{ role: 'user', content: `Filename: ${filename || 'schedule'}\n\nDocument text:\n${text.slice(0, 8000)}` }],
        }),
      });
      const data = await r.json();
      const textOut = (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n');
      const parsed = JSON.parse(textOut.trim().replace(/^```json\n?/, '').replace(/```$/, ''));
      blocks = sanitizeBlocks(parsed);
    } catch (e) {
      console.error('schedule-import.parse: AI call failed', String(e));
      return res.status(500).json({ message: "Couldn't read that schedule — try again, or enter it manually." });
    }

    return res.status(200).json({ blocks });
  }

  if (action === 'confirm') {
    const { pillar_id, blocks, filename } = req.body || {};
    const clean = sanitizeBlocks(blocks);
    if (!clean.length) return res.status(422).json({ message: 'At least one valid schedule block is required' });

    const inserted = [];
    for (const b of clean) {
      const rows = await sql`
        INSERT INTO fixed_commitments (user_id, pillar_id, name, schedule_days, start_time, end_time, source_filename)
        VALUES (${user.id}, ${pillar_id || null}, ${b.name}, ${b.days}, ${b.startTime}::time, ${b.endTime}::time, ${filename || null})
        RETURNING *
      `;
      inserted.push(rows[0]);
    }
    return res.status(201).json({ message: `Added ${inserted.length} fixed commitment${inserted.length === 1 ? '' : 's'} to your schedule`, commitments: inserted });
  }

  res.status(404).json({ message: 'Unknown schedule-import action' });
}
