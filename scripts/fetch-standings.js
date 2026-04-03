import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH     = join(__dirname, '..', 'data', 'standings.json');
const SCHEDULE_PATH = join(__dirname, '..', 'data', 'schedule.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FrisbeeWorld/1.0; +https://frisbee.world)',
  'Accept': 'text/html',
};

// ── Logo map ──────────────────────────────────────────────────
const LOGO_MAP = {
  "Discmania":     "/logo/discmania.png",
  "Discraft":      "/logo/discraft.png",
  "Innova":        "/logo/innova.jpg",
  "MVP":           "/logo/MVP.png",
  "Latitude 64":   "/logo/latitude64.png",
  "Dynamic Discs": "/logo/dynamicdiscs.png",
  "DGA":           "/logo/dga.jpeg",
  "Prodigy":       "/logo/prodigy.png",
  "Kastaplast":    "/logo/kastaplast.png",
  "Westside":      "/logo/westside.png",
  "Thought Space Athletics": "/logo/thoughtspace.png",
  "Axiom":         "/logo/axiom.png",
  "Streamline":    "/logo/streamline.png",
  "Mint Discs":    "/logo/mint.png",
  "RPM Discs":     "/logo/rpm.png",
};

// ── Sponsor name normalization ────────────────────────────────
const SPONSOR_NORMALIZE = {
  "DD":                        "Dynamic Discs",
  "Dynamic Disc":              "Dynamic Discs",
  "Latitude64":                "Latitude 64",
  "Latitude 64°":              "Latitude 64",
  "Lat 64":                    "Latitude 64",
  "Infinite Discs":            "Infinite",
  "Thought Space":             "Thought Space Athletics",
  "ThoughtSpace":              "Thought Space Athletics",
  "TSA":                       "Thought Space Athletics",
  "MVP Disc Sports":           "MVP",
  "Kastaplast Discs":          "Kastaplast",
  "Discmania Discs":           "Discmania",
  "Prodigy Disc":              "Prodigy",
  "Prodigy Discs":             "Prodigy",
  "Westside Discs":            "Westside",
  "DGA Disc Golf":             "DGA",
  "Discraft Discs":            "Discraft",
  "OTB":                       "OTB Disc Golf",
};

function normalizeSponsor(name) {
  if (!name) return name;
  return SPONSOR_NORMALIZE[name] || name;
}

// ── Fetch standings for one division ─────────────────────────
async function fetchDivision(div) {
  const url = `https://statmando.com/rankings/dgpt/${div.toLowerCase()}`;
  console.log(`\nFetching ${div} standings...`);
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
    const name       = $(cells[2]).text().trim().replace(/[*†‡]/g, '').trim();
    const points     = parseFloat($(cells[3]).text().trim().replace(',', ''));
    const pointsGain = parseFloat($(cells[4]).text().trim().replace(',', '')) || 0;
    const starts     = parseInt($(cells[5]).text().trim(), 10) || 0;
    const wins       = parseInt($(cells[6]).text().trim(), 10) || 0;
    const top10s     = parseInt($(cells[7]).text().trim(), 10) || 0;
    const qualified  = $(cells[2]).find('strong, b').length > 0;
    if (!rank || !name || isNaN(points)) return;
    players.push({ rank, name, points, pointsGain, wins, top10s, starts, qualified });
  });

  const top100 = players.slice(0, 100);
  console.log(`  → ${top100.length} players`);
  return { players: top100, week };
}

// ── Fetch sponsor from StatMando player profile ───────────────
async function fetchPlayerSponsor(slug) {
  const url = `https://statmando.com/player/${slug}/profile`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    let sponsor = null;
    $('img').each((_, el) => {
      const src = $(el).attr('src') || '';
      const match = src.match(/\/images\/team\/([^.]+)\.png/i);
      if (match) {
        sponsor = match[1].replace(/_/g, ' ').trim();
        return false;
      }
    });
    return sponsor;
  } catch(e) {
    return null;
  }
}

function nameToSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── Enrich players with sponsor data ─────────────────────────
async function enrichWithSponsors(players, existingPlayers) {
  const existing = {};
  (existingPlayers || []).forEach(p => {
    if (p.sponsor) existing[p.name] = { sponsor: p.sponsor, sponsorLogo: p.sponsorLogo };
  });

  const needLookup = players.filter(p => !existing[p.name]);
  console.log(`  → ${needLookup.length} players need sponsor lookup`);

  const BATCH = 3;
  for (let i = 0; i < needLookup.length; i += BATCH) {
    const batch = needLookup.slice(i, i + BATCH);
    await Promise.all(batch.map(async p => {
      const sponsor = await fetchPlayerSponsor(nameToSlug(p.name));
      if (sponsor) {
        const normalizedSponsor = normalizeSponsor(sponsor);
        existing[p.name] = { sponsor: normalizedSponsor, sponsorLogo: LOGO_MAP[normalizedSponsor] || '' };
        console.log(`    ${p.name} → ${normalizedSponsor}`);
      }
    }));
    if (i + BATCH < needLookup.length) await new Promise(r => setTimeout(r, 1500));
  }

  return players.map(p => ({
    ...p,
    sponsor: normalizeSponsor(existing[p.name]?.sponsor || ''),
    sponsorLogo: LOGO_MAP[normalizeSponsor(existing[p.name]?.sponsor || '')] || existing[p.name]?.sponsorLogo || '',
  }));
}

// ── Scrape winner from PDGA event results page ───────────────
async function fetchPdgaWinner(pdgaId, div) {
  const url = `https://www.pdga.com/apps/tournament/live-api/live-results-access-public.php?TournID=${pdgaId}&Division=${div}&Round=0&Type=results`;
  try {
    const res = await fetch(url, { headers: { ...HEADERS, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    // PDGA Live API returns players sorted by place
    const data = json?.data || [];
    const winner = data.find(p => parseInt(p.Place) === 1);
    if (winner) return `${winner.FirstName} ${winner.LastName}`.trim();
    return null;
  } catch(e) {
    // Fall back to HTML scrape
    try {
      const pageUrl = `https://www.pdga.com/tour/event/${pdgaId}`;
      const res = await fetch(pageUrl, { headers: HEADERS });
      if (!res.ok) return null;
      const html = await res.text();
      const $ = cheerio.load(html);
      // Find results section for this division
      let winner = null;
      $(`#${div.toLowerCase()}-results tbody tr, .${div.toLowerCase()}-results tbody tr`).first().find('td').each((i, el) => {
        const text = $(el).text().trim();
        if (i === 1 && text.length > 2) { winner = text; return false; }
      });
      return winner;
    } catch(e2) {
      return null;
    }
  }
}

// ── Auto-update schedule statuses and winners ─────────────────
async function updateSchedule(existingSchedule) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const season = existingSchedule.season;
  const events = existingSchedule.events;

  function parseEndDate(dates, month, day) {
    try {
      const parts = dates.split('–');
      const endPart = parts[parts.length - 1].trim();
      const endHasMonth = /[a-zA-Z]/.test(endPart);
      const endStr = endHasMonth ? `${endPart} ${season}` : `${month} ${endPart} ${season}`;
      const d = new Date(endStr);
      d.setHours(23, 59, 59, 0);
      return isNaN(d.getTime()) ? null : d;
    } catch(e) { return null; }
  }

  function parseStartDate(month, day) {
    try {
      const d = new Date(`${month} ${day} ${season}`);
      d.setHours(0, 0, 0, 0);
      return isNaN(d.getTime()) ? null : d;
    } catch(e) { return null; }
  }

  // Update statuses based on dates
  let nextSet = false;
  for (const e of events) {
    const start = parseStartDate(e.month, e.day);
    const end = parseEndDate(e.dates, e.month, e.day);
    if (!start || !end) continue;
    if (end < today) {
      e.status = 'done';
    } else if (!nextSet && start >= today) {
      e.status = 'next';
      nextSet = true;
    } else {
      e.status = 'upcoming';
    }
  }

  // Scrape winners from PDGA for completed events
  console.log('\nFetching winners from PDGA...');
  for (const e of events) {
    if (e.status !== 'done') continue;
    if (e.winner_mpo && e.winner_fpo) continue;
    if (!e.pdga_id) continue;

    console.log(`  Fetching results for ${e.name} (PDGA ${e.pdga_id})...`);

    if (!e.winner_mpo) {
      const mpoWinner = await fetchPdgaWinner(e.pdga_id, 'MPO');
      if (mpoWinner) {
        e.winner_mpo = mpoWinner;
        console.log(`    MPO: ${mpoWinner}`);
      }
      await new Promise(r => setTimeout(r, 800));
    }

    if (!e.winner_fpo) {
      const fpoWinner = await fetchPdgaWinner(e.pdga_id, 'FPO');
      if (fpoWinner) {
        e.winner_fpo = fpoWinner;
        console.log(`    FPO: ${fpoWinner}`);
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }

  return { ...existingSchedule, events, updated: new Date().toISOString().split('T')[0] };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];

  let existing = { MPO: [], FPO: [] };
  try {
    existing = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    console.log('Loaded existing standings.json');
  } catch(e) {
    console.log('No existing standings.json — creating fresh');
  }

  let existingSchedule = { season: 2026, events: [] };
  try {
    existingSchedule = JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'));
    console.log('Loaded existing schedule.json');
  } catch(e) {
    console.log('No existing schedule.json');
  }

  // Fetch standings
  const mpo = await fetchDivision('MPO');
  await new Promise(r => setTimeout(r, 2000));
  const fpo = await fetchDivision('FPO');

  if (mpo.players.length < 5 || fpo.players.length < 5) {
    throw new Error(`Too few players — aborting to protect existing data`);
  }

  // Enrich with sponsors
  console.log('\nEnriching MPO with sponsors...');
  const mpoEnriched = await enrichWithSponsors(mpo.players, existing.MPO);
  await new Promise(r => setTimeout(r, 1000));
  console.log('\nEnriching FPO with sponsors...');
  const fpoEnriched = await enrichWithSponsors(fpo.players, existing.FPO);

  // Update schedule
  console.log('\nUpdating schedule...');
  const updatedSchedule = await updateSchedule(existingSchedule);

  // Write standings
  const standingsOut = {
    updated: today,
    week: mpo.week || existing.week || '',
    note: existing.note || 'Auto-updated',
    MPO: mpoEnriched,
    FPO: fpoEnriched,
  };
  writeFileSync(DATA_PATH, JSON.stringify(standingsOut, null, 2));
  console.log(`\nWrote standings.json — MPO: ${mpoEnriched.length}, FPO: ${fpoEnriched.length}`);

  // Write schedule
  writeFileSync(SCHEDULE_PATH, JSON.stringify(updatedSchedule, null, 2));
  console.log(`Wrote schedule.json — ${updatedSchedule.events.length} events`);

  // Report done events and their statuses
  console.log('\nSchedule status:');
  updatedSchedule.events.forEach(e => console.log(`  [${e.status}] ${e.name} — MPO: ${e.winner_mpo || '?'} / FPO: ${e.winner_fpo || '?'}`));
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
