import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'standings.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; DGPulse/1.0; +https://dgpulse.vercel.app)',
  'Accept': 'text/html',
};

// ── Logo map — add new sponsors here when they appear ─────────
const LOGO_MAP = {
  "Discmania":     "https://cdn.brandfetch.io/discmania.net/w/400/h/400/logo",
  "Discraft":      "https://cdn.brandfetch.io/discraft.com/w/400/h/400/logo",
  "Innova":        "https://cdn.brandfetch.io/innovadiscs.com/w/400/h/400/logo",
  "MVP":           "https://cdn.brandfetch.io/mvpdiscsports.com/w/400/h/400/logo",
  "Latitude 64":   "https://cdn.brandfetch.io/latitude64.se/w/400/h/400/logo",
  "Dynamic Discs": "https://cdn.brandfetch.io/dynamicdiscs.com/w/400/h/400/logo",
  "DGA":           "https://cdn.brandfetch.io/discgolfassoc.com/w/400/h/400/logo",
  "Prodigy":       "https://cdn.brandfetch.io/prodigydisc.com/w/400/h/400/logo",
  "Kastaplast":    "https://cdn.brandfetch.io/kastaplast.com/w/400/h/400/logo",
  "Westside":      "https://cdn.brandfetch.io/westsidediscs.com/w/400/h/400/logo",
  "Thought Space Athletics": "https://cdn.brandfetch.io/thoughtspaceathletics.com/w/400/h/400/logo",
  "Axiom":         "https://cdn.brandfetch.io/axiomdiscs.com/w/400/h/400/logo",
  "Streamline":    "https://cdn.brandfetch.io/streamlinediscs.com/w/400/h/400/logo",
  "Mint Discs":    "https://cdn.brandfetch.io/mintdiscs.com/w/400/h/400/logo",
  "RPM Discs":     "https://cdn.brandfetch.io/rpmdiscs.com/w/400/h/400/logo",
};

// ── Fetch sponsor from StatMando player profile ───────────────
async function fetchPlayerSponsor(slug) {
  const url = `https://statmando.com/player/${slug}/profile`;
  try {
    const res = await fetch(url, { headers: HEADERS, timeout: 8000 });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // StatMando shows sponsor logo with alt text = sponsor name
    // Look for img with class or in sponsor section
    let sponsor = null;

    // Method 1: sponsor logo img alt text
    $('img').each((_, el) => {
      const alt = $(el).attr('alt') || '';
      const src = $(el).attr('src') || '';
      if (src.includes('/images/team/') && alt) {
        sponsor = alt.trim();
        return false; // break
      }
    });

    // Method 2: look for text near sponsor labels
    if (!sponsor) {
      $('*').each((_, el) => {
        const text = $(el).text().trim();
        if (text.match(/^(Discmania|Discraft|Innova|MVP|Latitude 64|Dynamic Discs|DGA|Prodigy|Kastaplast|Westside|Thought Space|Axiom|Streamline|Mint|RPM)$/i)) {
          sponsor = text.trim();
          return false;
        }
      });
    }

    return sponsor;
  } catch(e) {
    console.log(`  Could not fetch sponsor for ${slug}: ${e.message}`);
    return null;
  }
}

// Convert player name to StatMando slug
function nameToSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── Fetch and parse one division's standings ──────────────────
async function fetchDivision(div) {
  const url = `https://statmando.com/rankings/dgpt/${div.toLowerCase()}`;
  console.log(`\nFetching ${div} standings from ${url}...`);

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${div}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  let week = '';
  $('strong').each((_, el) => {
    const text = $(el).text().trim();
    if (text.startsWith('Week:')) week = text.replace('Week:', '').trim();
  });

  const players = [];
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
    const qualified  = $(cells[2]).find('strong, b').length > 0;

    if (!rank || !name || isNaN(points)) return;
    players.push({ rank, name, points, pointsGain, wins, top10s, starts, qualified });
  });

  console.log(`  → Parsed ${players.length} players`);
  return { players, week };
}

// ── Fetch sponsors for all players in parallel batches ────────
async function enrichWithSponsors(players, existingPlayers) {
  // Build a map of existing sponsor data so we don't re-fetch
  const existing = {};
  (existingPlayers || []).forEach(p => {
    if (p.sponsor) existing[p.name] = { sponsor: p.sponsor, sponsorLogo: p.sponsorLogo };
  });

  // Find players who need a sponsor lookup
  const needLookup = players.filter(p => !existing[p.name]);
  console.log(`  → ${needLookup.length} players need sponsor lookup, ${players.length - needLookup.length} already cached`);

  // Fetch sponsors in batches of 3 to be polite
  const BATCH = 3;
  for (let i = 0; i < needLookup.length; i += BATCH) {
    const batch = needLookup.slice(i, i + BATCH);
    await Promise.all(batch.map(async p => {
      const slug = nameToSlug(p.name);
      console.log(`  Fetching sponsor for ${p.name} (${slug})...`);
      const sponsor = await fetchPlayerSponsor(slug);
      if (sponsor) {
        existing[p.name] = {
          sponsor,
          sponsorLogo: LOGO_MAP[sponsor] || ''
        };
        console.log(`    → ${sponsor}`);
      } else {
        console.log(`    → sponsor not found, keeping previous or empty`);
      }
    }));
    // Small pause between batches
    if (i + BATCH < needLookup.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Apply sponsor data to players
  return players.map(p => ({
    ...p,
    sponsor: existing[p.name]?.sponsor || '',
    sponsorLogo: existing[p.name]?.sponsorLogo || '',
  }));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];

  // Read existing data so we can preserve sponsors for unchanged players
  let existing = { MPO: [], FPO: [] };
  try {
    existing = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    console.log('Loaded existing standings.json');
  } catch(e) {
    console.log('No existing standings.json found — creating fresh');
  }

  // Fetch fresh standings
  const mpo = await fetchDivision('MPO');
  await new Promise(r => setTimeout(r, 2000));
  const fpo = await fetchDivision('FPO');

  if (mpo.players.length < 5 || fpo.players.length < 5) {
    throw new Error(`Too few players parsed — MPO: ${mpo.players.length}, FPO: ${fpo.players.length}. Aborting.`);
  }

  // Enrich with sponsor data
  console.log('\nEnriching MPO with sponsor data...');
  const mpoEnriched = await enrichWithSponsors(mpo.players, existing.MPO);
  await new Promise(r => setTimeout(r, 1000));
  console.log('\nEnriching FPO with sponsor data...');
  const fpoEnriched = await enrichWithSponsors(fpo.players, existing.FPO);

  const output = {
    updated: today,
    week: mpo.week || existing.week || '',
    note: existing.note || 'Auto-updated',
    MPO: mpoEnriched,
    FPO: fpoEnriched,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));
  console.log(`\nDone — wrote standings.json`);
  console.log(`MPO: ${mpoEnriched.length} players | FPO: ${fpoEnriched.length} players`);
  console.log(`Updated: ${today} | Week: ${output.week}`);

  // Report any players missing sponsor data
  const missingMPO = mpoEnriched.filter(p => !p.sponsor).map(p => p.name);
  const missingFPO = fpoEnriched.filter(p => !p.sponsor).map(p => p.name);
  if (missingMPO.length) console.log(`\nMPO missing sponsors: ${missingMPO.join(', ')}`);
  if (missingFPO.length) console.log(`FPO missing sponsors: ${missingFPO.join(', ')}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
