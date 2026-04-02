import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'standings.json');

// ── Fetch and parse one division from StatMando ───────────────
async function fetchDivision(div) {
  const url = `https://statmando.com/rankings/dgpt/${div.toLowerCase()}`;
  console.log(`Fetching ${div} from ${url}...`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DGPulse/1.0; +https://dgpulse.vercel.app)',
      'Accept': 'text/html',
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${div}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  // Grab the week/update metadata from the page
  let week = '';
  $('strong').each((_, el) => {
    const text = $(el).text().trim();
    if (text.startsWith('Week:')) week = text.replace('Week:', '').trim();
  });

  const players = [];

  // Parse the standings table rows
  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 8) return;

    const rank       = parseInt($(cells[0]).text().trim(), 10);
    const name       = $(cells[2]).text().trim();
    const points     = parseFloat($(cells[3]).text().trim().replace(',', ''));
    const pointsGain = parseFloat($(cells[4]).text().trim().replace(',', '')) || 0;
    const starts     = parseInt($(cells[5]).text().trim(), 10) || 0;
    const wins       = parseInt($(cells[6]).text().trim(), 10) || 0;
    const top10s     = parseInt($(cells[7]).text().trim(), 10) || 0;

    // "Qualified" means the player name is bold in the standings
    const qualified  = $(cells[2]).find('strong, b').length > 0 || $(cells[2]).is('strong');

    if (!rank || !name || isNaN(points)) return;

    players.push({ rank, name, points, pointsGain, wins, top10s, starts, qualified });
  });

  console.log(`  → Parsed ${players.length} players for ${div}`);
  return { players, week };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];

  // Read existing file so we can preserve the note and schedule data
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch(e) {
    console.log('No existing standings.json, creating fresh.');
  }

  const mpo = await fetchDivision('MPO');
  // Pause briefly between requests to be polite
  await new Promise(r => setTimeout(r, 2000));
  const fpo = await fetchDivision('FPO');

  if (mpo.players.length < 5 || fpo.players.length < 5) {
    throw new Error(`Too few players parsed — MPO: ${mpo.players.length}, FPO: ${fpo.players.length}. Aborting to avoid overwriting good data.`);
  }

  const output = {
    updated: today,
    week: mpo.week || existing.week || '',
    note: existing.note || 'Auto-updated',
    MPO: mpo.players,
    FPO: fpo.players,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote standings.json — MPO: ${mpo.players.length} players, FPO: ${fpo.players.length} players`);
  console.log(`Updated: ${today} | Week: ${output.week}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1); // Non-zero exit makes the Action show as failed in GitHub
});
