// Netlify serverless function — proxies football-data.org API
// Keeps the API key off the client and handles CORS

const API_KEY = 'bb8bb5c40fe0476eafb5f6dbf6abf838';
const BASE    = 'https://api.football-data.org/v4/competitions/WC';

// Our 3-letter codes → football-data.org team names (and vice versa)
// football-data uses full country names; we map them here
const NAME_TO_CODE = {
  'Mexico': 'MEX', 'South Africa': 'RSA', 'Korea Republic': 'KOR', 'Czechia': 'CZE',
  'Czech Republic': 'CZE', 'Canada': 'CAN', 'Bosnia and Herzegovina': 'BIH',
  'Qatar': 'QAT', 'Switzerland': 'SUI', 'Brazil': 'BRA', 'Morocco': 'MAR',
  'Haiti': 'HAI', 'Scotland': 'SCO', 'United States': 'USA', 'USA': 'USA',
  'Paraguay': 'PAR', 'Australia': 'AUS', 'Türkiye': 'TUR', 'Turkey': 'TUR',
  'Germany': 'GER', 'Curaçao': 'CUW', "Côte d'Ivoire": 'CIV', 'Ivory Coast': 'CIV',
  'Ecuador': 'ECU', 'Netherlands': 'NED', 'Japan': 'JPN', 'Sweden': 'SWE',
  'Tunisia': 'TUN', 'Belgium': 'BEL', 'Egypt': 'EGY', 'Iran': 'IRN',
  'New Zealand': 'NZL', 'Spain': 'ESP', 'Cape Verde': 'CPV', 'Cabo Verde': 'CPV',
  'Saudi Arabia': 'KSA', 'Uruguay': 'URU', 'France': 'FRA', 'Senegal': 'SEN',
  'Iraq': 'IRQ', 'Norway': 'NOR', 'Argentina': 'ARG', 'Algeria': 'ALG',
  'Austria': 'AUT', 'Jordan': 'JOR', 'Portugal': 'POR',
  'DR Congo': 'COD', 'Congo DR': 'COD', 'Democratic Republic of Congo': 'COD',
  'Uzbekistan': 'UZB', 'Colombia': 'COL', 'England': 'ENG', 'Croatia': 'CRO',
  'Ghana': 'GHA', 'Panama': 'PAN',
};

function toCode(name) {
  return NAME_TO_CODE[name] || name;
}

// Map football-data group letter to our group letter
// football-data uses "Group A", "Group B" etc — same as ours
function groupLetter(stage, groupStr) {
  // groupStr looks like "GROUP_A" or "Group A"
  if (!groupStr) return null;
  const m = groupStr.match(/[A-L]/);
  return m ? m[0] : null;
}

// Map football-data stage to our round key
function stageToRound(stage) {
  if (!stage) return null;
  const s = stage.toUpperCase();
  if (s.includes('GROUP')) return 'group';
  if (s.includes('ROUND_OF_32') || s.includes('LAST_32')) return 'r32';
  if (s.includes('ROUND_OF_16') || s.includes('LAST_16')) return 'r16';
  if (s.includes('QUARTER')) return 'qf';
  if (s.includes('SEMI')) return 'sf';
  if (s.includes('FINAL') && !s.includes('SEMI') && !s.includes('QUARTER')) return 'final';
  return null;
}

// Map football-data match ID to our match ID (M73, M74, etc.)
// We do this by matching home/away team codes to our R32 definitions
// For now we use a position-based approach keyed on the stage + matchday
// In practice, once the tournament starts we can refine this
const R32_ORDER = [
  'M73','M74','M75','M77','M76','M78','M79','M80',
  'M83','M84','M81','M82','M86','M88','M85','M87',
];
const R16_ORDER = ['R16-1','R16-2','R16-3','R16-4','R16-5','R16-6','R16-7','R16-8'];
const QF_ORDER  = ['QF1','QF2','QF3','QF4'];
const SF_ORDER  = ['SF1','SF2'];

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  };

  try {
    // Fetch standings (group stage results)
    const [standingsRes, matchesRes] = await Promise.all([
      fetch(`${BASE}/standings`, {
        headers: { 'X-Auth-Token': API_KEY }
      }),
      fetch(`${BASE}/matches?season=2026`, {
        headers: { 'X-Auth-Token': API_KEY }
      }),
    ]);

    const standingsData = await standingsRes.json();
    const matchesData   = await matchesRes.json();

    // ── BUILD groups ──
    // { A: ['MEX','KOR','RSA','CZE'], B: [...], ... }
    const groups = {};
    const qualifyingThirds = [];

    if (standingsData.standings) {
      standingsData.standings.forEach(standing => {
        const letter = groupLetter('GROUP', standing.group || standing.stage);
        if (!letter) return;

        // Sort by position
        const sorted = [...standing.table].sort((a, b) => a.position - b.position);
        groups[letter] = sorted.map(row => toCode(row.team.name));
      });

      // Determine qualifying thirds — top 8 third-place teams by points/gd/gf
      const thirds = [];
      Object.entries(groups).forEach(([g, teams]) => {
        if (teams.length >= 3) {
          // We need actual stats to rank thirds — get from standings table
          const standing = standingsData.standings.find(s =>
            groupLetter('GROUP', s.group || s.stage) === g
          );
          if (standing && standing.table[2]) {
            const row = standing.table[2];
            thirds.push({
              group: g,
              team: teams[2],
              points: row.points || 0,
              goalDiff: row.goalDifference || 0,
              goalsFor: row.goalsFor || 0,
            });
          }
        }
      });

      // Sort thirds by points, then GD, then GF
      thirds.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
        return b.goalsFor - a.goalsFor;
      });

      thirds.slice(0, 8).forEach(t => qualifyingThirds.push(t.group));
    }

    // ── BUILD ko results ──
    // { r32: { M73: 'MEX', ... }, r16: {...}, qf:{}, sf:{}, final:{} }
    const ko = { r32: {}, r16: {}, qf: {}, sf: {}, final: {} };
    let currentStage = 'groups';
    const r32Count = { idx: 0 };
    const r16Count = { idx: 0 };
    const qfCount  = { idx: 0 };
    const sfCount  = { idx: 0 };

    if (matchesData.matches) {
      // Group stage: track what stage we're at
      const statuses = matchesData.matches.map(m => m.status);
      const allFinished = statuses.every(s => s === 'FINISHED');
      const anyStarted  = statuses.some(s => s !== 'SCHEDULED' && s !== 'TIMED');

      if (anyStarted) currentStage = 'groups';

      matchesData.matches.forEach(match => {
        const round = stageToRound(match.stage);
        if (!round || round === 'group') return;
        if (match.status !== 'FINISHED') return;

        // Determine winner
        let winner = null;
        const score = match.score;
        if (score) {
          const home = score.fullTime?.home ?? score.regularTime?.home;
          const away = score.fullTime?.away ?? score.regularTime?.away;
          if (home !== null && away !== null) {
            if (home > away) winner = toCode(match.homeTeam.name);
            else if (away > home) winner = toCode(match.awayTeam.name);
            else if (score.penalties) {
              // Penalty shootout
              const ph = score.penalties.home;
              const pa = score.penalties.away;
              winner = ph > pa ? toCode(match.homeTeam.name) : toCode(match.awayTeam.name);
            }
          }
        }

        if (!winner) return;

        if (round === 'r32' && r32Count.idx < R32_ORDER.length) {
          ko.r32[R32_ORDER[r32Count.idx++]] = winner;
          currentStage = 'r32';
        } else if (round === 'r16' && r16Count.idx < R16_ORDER.length) {
          ko.r16[R16_ORDER[r16Count.idx++]] = winner;
          currentStage = 'r16';
        } else if (round === 'qf' && qfCount.idx < QF_ORDER.length) {
          ko.qf[QF_ORDER[qfCount.idx++]] = winner;
          currentStage = 'qf';
        } else if (round === 'sf' && sfCount.idx < SF_ORDER.length) {
          ko.sf[SF_ORDER[sfCount.idx++]] = winner;
          currentStage = 'sf';
        } else if (round === 'final') {
          ko.final['FINAL'] = winner;
          currentStage = 'final';
        }
      });
    }

    // Determine if all group matches are done
    const groupMatchesFinished = matchesData.matches
      ? matchesData.matches
          .filter(m => stageToRound(m.stage) === 'group')
          .every(m => m.status === 'FINISHED')
      : false;

    if (groupMatchesFinished && Object.keys(ko.r32).length > 0) {
      currentStage = 'r32';
    }

    const payload = {
      groups: Object.keys(groups).length > 0 ? groups : null,
      qualifyingThirds: qualifyingThirds.length > 0 ? qualifyingThirds : null,
      ko,
      currentStage,
      lastUpdated: new Date().toISOString(),
      source: 'football-data.org',
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
