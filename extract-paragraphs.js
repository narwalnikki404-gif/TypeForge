/**
 * TypeForge — Paragraph Extractor
 * ────────────────────────────────
 * Reads all PDFs in the /para directory, extracts clean paragraphs,
 * and pushes them to the TypeForge backend.
 *
 * Usage:
 *   node scripts/extract-paragraphs.js
 *
 * Environment variables needed (or set in .env):
 *   API_URL       — e.g. https://your-app.railway.app
 *   ADMIN_TOKEN   — matches server ADMIN_TOKEN env var
 *   EXAM_ID       — which exam these paragraphs are for (default: 'general')
 *
 * The script assigns paragraphs to future dates automatically:
 *   - Today + 1 gets the first batch (5-10 paragraphs)
 *   - Today + 2 gets the next batch, etc.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pdf  = require('pdf-parse');

const PARA_DIR    = path.join(__dirname, '..', 'para');
const API_URL     = process.env.API_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token';
const EXAM_ID     = process.env.EXAM_ID    || 'general';
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE || '7', 10); // paragraphs per day

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Add `days` days to a Date and return YYYY-MM-DD string */
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** Clean raw PDF text into coherent paragraphs */
function extractParagraphs(rawText) {
  // Normalize line endings
  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Remove PDF artifacts: page numbers, headers (lines < 4 words)
  const lines = text.split('\n');
  const cleaned = lines
    .map(l => l.trim())
    .filter(l => l.length > 0)
    // Remove standalone numbers (page numbers)
    .filter(l => !/^\d+$/.test(l))
    // Remove very short lines that are likely headers/footers
    .filter(l => l.split(/\s+/).length >= 4)
    .join('\n');

  // Split on double-newline or paragraph-like breaks
  const rawParas = cleaned.split(/\n{2,}/);

  // Filter + clean each paragraph
  const paras = rawParas
    .map(p => p.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    // Minimum 50 words to be useful for typing practice
    .filter(p => p.split(/\s+/).length >= 50)
    // Maximum 250 words (exam passages are 200-300 words)
    .map(p => {
      const words = p.split(/\s+/);
      if (words.length > 280) {
        // Split long paragraphs at a sentence boundary around 200 words
        const cutoff = words.slice(0, 220).join(' ');
        const cutAt = Math.max(cutoff.lastIndexOf('. '), cutoff.lastIndexOf('! '), cutoff.lastIndexOf('? '));
        if (cutAt > 100) {
          return cutoff.slice(0, cutAt + 1).trim();
        }
        return words.slice(0, 220).join(' ');
      }
      return p;
    })
    // De-duplicate
    .filter((p, i, arr) => arr.indexOf(p) === i);

  return paras;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  // Find all PDFs in /para directory
  let pdfFiles;
  try {
    pdfFiles = fs.readdirSync(PARA_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  } catch (e) {
    console.error(`❌ Cannot read para/ directory: ${e.message}`);
    console.error('   Create a para/ folder and add PDF files to it.');
    process.exit(1);
  }

  if (pdfFiles.length === 0) {
    console.log('📂 No PDF files found in para/ directory. Add PDFs and re-run.');
    return;
  }

  console.log(`📚 Found ${pdfFiles.length} PDF(s): ${pdfFiles.join(', ')}\n`);

  // Extract all paragraphs from all PDFs
  let allParagraphs = [];
  for (const file of pdfFiles) {
    const filePath = path.join(PARA_DIR, file);
    try {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData    = await pdf(dataBuffer);
      const paras      = extractParagraphs(pdfData.text);
      console.log(`✅ ${file}: extracted ${paras.length} usable paragraphs`);
      allParagraphs.push(...paras.map(text => ({ text, source: file })));
    } catch (err) {
      console.error(`⚠️  ${file}: failed to parse (${err.message})`);
    }
  }

  if (allParagraphs.length === 0) {
    console.log('\n⚠️  No usable paragraphs extracted. Try adding more text-heavy PDFs.');
    return;
  }

  // Shuffle for variety
  allParagraphs.sort(() => Math.random() - 0.5);

  console.log(`\n📝 Total usable paragraphs: ${allParagraphs.length}`);
  console.log(`   Batch size: ${BATCH_SIZE} per day`);
  console.log(`   Days covered: ${Math.ceil(allParagraphs.length / BATCH_SIZE)}\n`);

  // Assign paragraphs to future dates
  const toInsert = [];
  for (let i = 0; i < allParagraphs.length; i++) {
    const dayOffset = Math.floor(i / BATCH_SIZE) + 1; // Start from tomorrow
    toInsert.push({
      examId:       EXAM_ID,
      text:         allParagraphs[i].text,
      source:       allParagraphs[i].source,
      dateAssigned: dateOffset(dayOffset),
    });
  }

  // Push to API in chunks
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    try {
      const res  = await fetch(`${API_URL}/api/admin/paragraphs`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': ADMIN_TOKEN,
        },
        body: JSON.stringify({ paragraphs: chunk }),
      });
      const data = await res.json();
      if (res.ok) {
        inserted += data.inserted;
        process.stdout.write(`   Uploaded ${Math.min(i + CHUNK, toInsert.length)}/${toInsert.length}\r`);
      } else {
        console.error(`\n❌ API error: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      console.error(`\n❌ Network error: ${err.message}`);
      console.error('   Make sure the server is running and API_URL is correct.');
      process.exit(1);
    }
  }

  console.log(`\n✅ Done! Inserted ${inserted} paragraphs into the database.`);
  console.log(`   Paragraphs are scheduled from tomorrow for ${Math.ceil(allParagraphs.length / BATCH_SIZE)} days.`);
  console.log(`   Exam ID: ${EXAM_ID}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
