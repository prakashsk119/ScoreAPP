/* ============================================================
   CricScore – Ball-by-Ball Cricket Scoring Application
   ============================================================ */

// ===== STATE =====
let match = {
  team1: { name: '', players: [] },
  team2: { name: '', players: [] },
  totalOvers: 20,
  playersPerTeam: 11,
  battingFirst: 1,
  currentInnings: 1,
  innings: [null, null],
  result: null,
  settings: { wideRuns: 1, noBallRuns: 1, freeHit: true },
  phase: 'setup'   // setup | innings-select | scoring | bowler-select | result
};

// ===== REAL-TIME SYNC =====
let _socket = null;
let _roomCode = null;
let _isViewer = false;


function createInnings(battingTeamIdx, bowlingTeamIdx) {
  const batting = battingTeamIdx === 1 ? match.team1 : match.team2;
  const bowling = bowlingTeamIdx === 1 ? match.team1 : match.team2;
  return {
    battingTeamIdx,
    bowlingTeamIdx,
    battingTeamName: batting.name,
    bowlingTeamName: bowling.name,
    runs: 0,
    wickets: 0,
    balls: 0,             // legal deliveries
    extras: { wide: 0, noBall: 0, bye: 0, legBye: 0 },
    totalExtras: 0,
    ballLog: [],           // array of ball objects
    overBalls: [],         // balls in current over (for display)
    overRuns: 0,
    batters: {},           // keyed by name
    bowlers: {},           // keyed by name
    strikerName: '',
    nonStrikerName: '',
    currentBowlerName: '',
    previousBowlerName: '',
    battedList: [],        // names of all who have batted
    fow: [],              // fall of wickets [{runs, wickets, overs, batter}]
    currentPartnership: { runs: 0, balls: 0, names: [] },
    isComplete: false
  };
}

function createBatterStats(name) {
  return { name, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: '', sr: 0 };
}

function createBowlerStats(name) {
  return { name, overs: 0, balls: 0, maidens: 0, runs: 0, wickets: 0, eco: 0, wides: 0, noBalls: 0 };
}

// ===== UTILITIES =====
function $(id) { return document.getElementById(id); }
function isLoggedIn() {
  try {
    const userData = localStorage.getItem('cricscore_user');
    if (!userData) return false;
    const user = JSON.parse(userData);
    return user && user.loggedIn;
  } catch (e) {
    return false;
  }
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $(id);
  if (target) target.classList.add('active');
  
  closeSidebar(); // Auto-close sidebar on navigation

  // Manage Bottom Nav visibility
  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) {
    const dashboardScreens = ['screen-home', 'screen-leaderboard', 'screen-history', 'screen-profile'];
    if (dashboardScreens.includes(id)) {
      bottomNav.style.display = 'flex';
    } else {
      bottomNav.style.display = 'none';
    }
  }
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function oversString(balls) {
  return Math.floor(balls / 6) + '.' + (balls % 6);
}

function currentRunRate(innings) {
  if (innings.balls === 0) return '0.00';
  return (innings.runs / (innings.balls / 6)).toFixed(2);
}

function requiredRunRate(target, runsScored, ballsRemaining) {
  if (ballsRemaining <= 0) return '—';
  const overs = ballsRemaining / 6;
  return ((target - runsScored) / overs).toFixed(2);
}

// ===== SETUP SCREEN =====
function renderPlayerInputs() {
  const count = parseInt($('players-per-team').value) || 11;
  const t1 = $('team1-players');
  const t2 = $('team2-players');

  // Preserve existing values
  const prev1 = [...document.querySelectorAll('.team1-player')].map(el => el.value);
  const prev2 = [...document.querySelectorAll('.team2-player')].map(el => el.value);

  // Get profile name for auto-fill
  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  const loginName = userData.phone || "";
  const profile = userData.profile || {};
  const matchName = profile.matchName || loginName;

  t1.innerHTML = '';
  t2.innerHTML = '';

  for (let i = 1; i <= count; i++) {
    // Auto-fill first player with profile name if empty
    let val1 = prev1[i - 1] !== undefined && prev1[i - 1] !== '' ? prev1[i - 1] : `Player ${i}`;
    if (i === 1 && (prev1[i - 1] === undefined || prev1[i - 1] === '' || prev1[i - 1] === 'Player 1') && matchName) {
      val1 = matchName;
    }
    
    const val2 = prev2[i - 1] !== undefined && prev2[i - 1] !== '' ? prev2[i - 1] : `Player ${i}`;
    
    t1.innerHTML += `<div class="form-group player-input-wrap"><label>Player ${i}</label><input type="text" class="form-input team1-player" placeholder="Player ${i}" maxlength="20" value="${val1}"></div>`;
    t2.innerHTML += `<div class="form-group player-input-wrap"><label>Player ${i}</label><input type="text" class="form-input team2-player" placeholder="Player ${i}" maxlength="20" value="${val2}"></div>`;
  }
}

// Run on page load
async function updateDashboardStats() {
  await fetchGlobalHistory();
  const matchesEl = $('dash-total-matches');
  if (!matchesEl) return;

  const history = loadHistory();
  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  const loginName = userData.phone || "";
  const profile = userData.profile || {};
  const searchName = (profile.matchName || loginName).trim().toLowerCase();

  let totalMatches = 0;
  let totalRuns = 0;
  let totalWkts = 0;

  if (searchName) {
    // PERSONAL STATS for home dashboard
    const allStats = aggregateCareerStats();
    const myStats = allStats.find(p => p.name.toLowerCase() === searchName);
    
    if (myStats) {
      totalMatches = myStats.matches;
      totalRuns = myStats.bat.runs;
      totalWkts = myStats.bowl.wickets;
    }
  } else {
    // Global totals if not logged in or no name set
    totalMatches = history.length;
    history.forEach(m => {
      m.innings.forEach(inn => {
        if (inn) {
          totalRuns += inn.runs;
          totalWkts += inn.wickets;
        }
      });
    });
  }

  $('dash-total-matches').innerText = totalMatches;
  $('dash-total-runs').innerText = totalRuns;
  $('dash-total-wkts').innerText = totalWkts;
}

function initAuth() {
  console.log("Checking for persistent login...");
  try {
    const userData = localStorage.getItem('cricscore_user');
    if (userData) {
      const user = JSON.parse(userData);
      if (user && user.loggedIn) {
        console.log("Persistent login found for:", user.phone);
        
        // Check for active match
        const activeMatchData = localStorage.getItem('cricscore_active_match');
        if (activeMatchData) {
          try {
            const savedMatch = JSON.parse(activeMatchData);
            if (savedMatch && (savedMatch.phase === 'scoring' || savedMatch.phase === 'setup')) {
              console.log("Restoring active match...");
              match = savedMatch;
              
              if (match.phase === 'scoring') {
                $('header-match-title').textContent = `${match.team1.name} vs ${match.team2.name}`;
                showScreen('screen-scoring');
                renderScoring();
                return true;
              } else if (match.phase === 'setup') {
                showScreen('screen-setup');
                return true;
              }
            }
          } catch (e) {
            console.error("Error restoring match:", e);
            localStorage.removeItem('cricscore_active_match');
          }
        }

        showScreen('screen-home');
        updateDashboardStats();
        renderLeaderboard();
        // Update sidebar name if needed
        const profileName = document.querySelector('.sidebar-profile-name');
        if (profileName) {
            const name = user.phone;
            profileName.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        }
        return true; // Login found
      }
    }
  } catch (err) {
    console.error("Auth persistence error:", err);
    localStorage.removeItem('cricscore_user');
  }
}

(async function initSetup() {
  await fetchGlobalHistory();
  renderPlayerInputs();
  
  const setupContainer = document.querySelector('#screen-setup .setup-container');
  if (setupContainer) {
    setupContainer.style.maxHeight = '95vh';
    setupContainer.style.overflowY = 'auto';
  }
})();

// Track toss elected choice ('bat' | 'bowl')
let tossChoice = 'bat';

// Live-sync team names → toss dropdown + section divider labels
function syncTeamNames() {
  const t1 = $('team1-name').value.trim();
  const t2 = $('team2-name').value.trim();

  // Update toss-winner options
  const opt1 = $('opt-team1');
  const opt2 = $('opt-team2');
  if (opt1) opt1.textContent = t1 || 'Team 1';
  if (opt2) opt2.textContent = t2 || 'Team 2';

  // Update section dividers above player inputs
  const dividers = document.querySelectorAll('.section-divider span');
  if (dividers[0]) dividers[0].textContent = (t1 || 'Team 1') + ' Players';
  if (dividers[1]) dividers[1].textContent = (t2 || 'Team 2') + ' Players';

  // Refresh toss summary sentence
  syncTossUI();
}

// Toggle Bat / Bowl buttons
function selectTossChoice(choice) {
  tossChoice = choice;
  $('toss-bat-btn').classList.toggle('active', choice === 'bat');
  $('toss-bowl-btn').classList.toggle('active', choice === 'bowl');
  syncTossUI();
}

// Update the live summary sentence under the toss row
function syncTossUI() {
  const tossWinnerVal = $('toss-winner') ? parseInt($('toss-winner').value) : 1;
  const t1 = $('team1-name').value.trim() || 'Team 1';
  const t2 = $('team2-name').value.trim() || 'Team 2';
  const winnerName = tossWinnerVal === 1 ? t1 : t2;
  const elected = tossChoice === 'bat' ? 'Bat' : 'Bowl';
  const summary = $('toss-summary');
  if (summary) summary.textContent = `${winnerName} won the toss and elected to ${elected} first`;
}

function startMatch() {
  const t1Name = $('team1-name').value.trim() || 'Team A';
  const t2Name = $('team2-name').value.trim() || 'Team B';

  const t1Players = [...document.querySelectorAll('.team1-player')].map((el, i) => el.value.trim() || `T1 Player ${i + 1}`);
  const t2Players = [...document.querySelectorAll('.team2-player')].map((el, i) => el.value.trim() || `T2 Player ${i + 1}`);

  const dedupe = (arr) => {
    const seen = {};
    return arr.map(n => {
      if (seen[n]) { seen[n]++; return n + ' (' + seen[n] + ')'; }
      seen[n] = 1; return n;
    });
  };

  const tossWinner = parseInt($('toss-winner').value);
  let battingFirst;
  if (tossChoice === 'bat') {
    battingFirst = tossWinner;
  } else {
    battingFirst = tossWinner === 1 ? 2 : 1;
  }

  match.team1 = { name: t1Name, players: dedupe(t1Players) };
  match.team2 = { name: t2Name, players: dedupe(t2Players) };
  match.totalOvers = parseInt($('total-overs').value);
  match.playersPerTeam = parseInt($('players-per-team').value) || 11;
  match.settings = {
    wideRuns: parseInt($('setting-wide-runs').value) || 1,
    noBallRuns: parseInt($('setting-nb-runs').value) || 1,
    freeHit: $('setting-free-hit').checked
  };
  match.battingFirst = battingFirst;
  match.currentInnings = 1;
  match.result = null;
  match.phase = 'innings-select';

  // Host a room when match starts
  hostMatch();

  setupInningsSelection(1);
}


function setupInningsSelection(inningsNum) {
  match.currentInnings = inningsNum;

  const battingTeamIdx = inningsNum === 1 ? match.battingFirst : (match.battingFirst === 1 ? 2 : 1);
  const bowlingTeamIdx = battingTeamIdx === 1 ? 2 : 1;
  const battingTeam = battingTeamIdx === 1 ? match.team1 : match.team2;
  const bowlingTeam = bowlingTeamIdx === 1 ? match.team1 : match.team2;

  $('innings-setup-title').textContent = `Choose Opening Batters & Bowler`;
  $('innings-setup-subtitle').textContent = `${inningsNum === 1 ? '1st' : '2nd'} Innings — ${battingTeam.name} batting`;

  const strikerSel = $('select-striker');
  const nonStrikerSel = $('select-non-striker');
  const bowlerSel = $('select-bowler');

  strikerSel.innerHTML = battingTeam.players.map(p => `<option value="${p}">${p}</option>`).join('');
  nonStrikerSel.innerHTML = battingTeam.players.map((p, i) => `<option value="${p}" ${i === 1 ? 'selected' : ''}>${p}</option>`).join('');
  bowlerSel.innerHTML = bowlingTeam.players.map(p => `<option value="${p}">${p}</option>`).join('');

  showScreen('screen-innings-setup');
}

function beginInnings() {
  const strikerName = $('select-striker').value;
  const nonStrikerName = $('select-non-striker').value;
  const bowlerName = $('select-bowler').value;

  if (strikerName === nonStrikerName) {
    toast('Striker and Non-Striker must be different!');
    return;
  }

  const inningsNum = match.currentInnings;
  const battingTeamIdx = inningsNum === 1 ? match.battingFirst : (match.battingFirst === 1 ? 2 : 1);
  const bowlingTeamIdx = battingTeamIdx === 1 ? 2 : 1;

  const inn = createInnings(battingTeamIdx, bowlingTeamIdx);
  inn.strikerName = strikerName;
  inn.nonStrikerName = nonStrikerName;
  inn.currentBowlerName = bowlerName;

  inn.batters[strikerName] = createBatterStats(strikerName);
  inn.batters[nonStrikerName] = createBatterStats(nonStrikerName);
  inn.battedList.push(strikerName, nonStrikerName);
  inn.bowlers[bowlerName] = createBowlerStats(bowlerName);

  match.innings[inningsNum - 1] = inn;
  match.phase = 'scoring';

  $('header-match-title').textContent = `${match.team1.name} vs ${match.team2.name}`;

  showScreen('screen-scoring');
  renderScoring();
  syncState();
}


// ===== SCORING LOGIC =====
function getInnings() {
  return match.innings[match.currentInnings - 1];
}

function getBattingTeamPlayers() {
  const inn = getInnings();
  return inn.battingTeamIdx === 1 ? match.team1.players : match.team2.players;
}

function getBowlingTeamPlayers() {
  const inn = getInnings();
  return inn.bowlingTeamIdx === 1 ? match.team1.players : match.team2.players;
}

function addBall(runs) {
  const inn = getInnings();
  if (inn.isComplete) return;

  const ball = {
    type: 'normal',
    runs,
    extras: 0,
    extraType: null,
    isWicket: false,
    bowler: inn.currentBowlerName,
    striker: inn.strikerName,
    nonStriker: inn.nonStrikerName,
    isLegal: true,
    overNumber: Math.floor(inn.balls / 6) + 1
  };

  // Update stats
  inn.runs += runs;
  inn.balls += 1;

  inn.batters[inn.strikerName].runs += runs;
  inn.batters[inn.strikerName].balls += 1;
  if (runs === 4) {
    inn.batters[inn.strikerName].fours += 1;
    playVoiceCommentary('4');
  }
  if (runs === 6) {
    inn.batters[inn.strikerName].sixes += 1;
    playVoiceCommentary('6');
  }

  inn.bowlers[inn.currentBowlerName].runs += runs;
  inn.bowlers[inn.currentBowlerName].balls += 1;

  inn.ballLog.push(ball);
  inn.overBalls.push(formatBallDisplay(ball));
  inn.overRuns += runs;
  // Partnership
  inn.currentPartnership.runs += runs;
  inn.currentPartnership.balls += 1;

  // Rotate strike on odd runs
  if (runs % 2 !== 0) swapStrike(inn);

  // Show last ball indicator
  showLastBall(ball);

  checkOverComplete(inn);
  checkInningsEnd(inn);
  renderScoring();
  syncState();
}

function addExtra(type) {
  const inn = getInnings();
  if (inn.isComplete) return;

  let extraRuns = type === 'wide' ? (match.settings?.wideRuns || 1) : 
                   type === 'noBall' ? (match.settings?.noBallRuns || 1) : 1;
  const ball = {
    type: 'extra',
    runs: 0,
    extras: extraRuns,
    extraType: type,
    isWicket: false,
    bowler: inn.currentBowlerName,
    striker: inn.strikerName,
    nonStriker: inn.nonStrikerName,
    isLegal: false,
    overNumber: Math.floor(inn.balls / 6) + 1
  };

  if (type === 'wide') {
    inn.runs += extraRuns;
    inn.extras.wide += extraRuns;
    inn.totalExtras += extraRuns;
    inn.bowlers[inn.currentBowlerName].runs += extraRuns;
    inn.bowlers[inn.currentBowlerName].wides += 1;
    inn.currentPartnership.runs += extraRuns;
    ball.isLegal = false;
  } else if (type === 'noBall') {
    inn.runs += extraRuns;
    inn.extras.noBall += extraRuns;
    inn.totalExtras += extraRuns;
    inn.bowlers[inn.currentBowlerName].runs += extraRuns;
    inn.bowlers[inn.currentBowlerName].noBalls += 1;
    inn.currentPartnership.runs += extraRuns;
    ball.isLegal = false;
  } else if (type === 'bye') {
    inn.runs += 1;
    inn.extras.bye += 1;
    inn.totalExtras += 1;
    inn.balls += 1;
    inn.bowlers[inn.currentBowlerName].balls += 1;
    inn.batters[inn.strikerName].balls += 1;
    ball.isLegal = true;
    // Rotate strike for bye (1 run)
    swapStrike(inn);
  } else if (type === 'legBye') {
    inn.runs += 1;
    inn.extras.legBye += 1;
    inn.totalExtras += 1;
    inn.balls += 1;
    inn.bowlers[inn.currentBowlerName].balls += 1;
    inn.batters[inn.strikerName].balls += 1;
    ball.isLegal = true;
    swapStrike(inn);
  }

  inn.ballLog.push(ball);
  inn.overBalls.push(formatBallDisplay(ball));
  inn.overRuns += ball.extras + ball.runs;

  showLastBall(ball);

  if (ball.isLegal) {
    checkOverComplete(inn);
  }
  checkInningsEnd(inn);
  renderScoring();
  syncState();
}

// ===== WICKETS =====
let pendingWicketType = '';
let pendingWicketRuns = 0;

function showWicketModal(type) {
  const inn = getInnings();
  if (inn.isComplete) return;

  pendingWicketType = type;
  pendingWicketRuns = 0;

  $('modal-wicket-title').textContent = `Wicket — ${type}`;

  // Out batsman options (striker or non-striker for run out)
  const outSel = $('modal-out-batsman');
  if (type === 'Run Out') {
    outSel.innerHTML = `<option value="${inn.strikerName}">${inn.strikerName} (Striker)</option><option value="${inn.nonStrikerName}">${inn.nonStrikerName} (Non-Striker)</option>`;
  } else {
    outSel.innerHTML = `<option value="${inn.strikerName}">${inn.strikerName} (Striker)</option>`;
  }

  // Fielder options
  const fielderGroup = $('fielder-group');
  const fielderLabel = $('fielder-label');
  const fielderSel = $('modal-fielder');
  const bowlingPlayers = getBowlingTeamPlayers();
  
  if (type === 'Caught' || type === 'Run Out' || type === 'Stumped') {
    fielderGroup.style.display = 'block';
    fielderLabel.textContent = type === 'Caught' ? 'Caught by' : type === 'Stumped' ? 'Stumped by' : 'Fielder';
    fielderSel.innerHTML = bowlingPlayers.map(p => `<option value="${p}">${p}</option>`).join('');
  } else {
    fielderGroup.style.display = 'none';
  }

  // Reset runs buttons
  document.querySelectorAll('.mini-run-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.mini-run-btn[data-runs="0"]').classList.add('active');

  $('modal-wicket').style.display = 'flex';
}

function setWicketRuns(r) {
  pendingWicketRuns = r;
  document.querySelectorAll('.mini-run-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.mini-run-btn[data-runs="${r}"]`).classList.add('active');
}

function closeWicketModal() {
  $('modal-wicket').style.display = 'none';
}

function confirmWicket() {
  const inn = getInnings();
  const outBatsman = $('modal-out-batsman').value;
  const fielder = $('modal-fielder').value || '';
  const wType = pendingWicketType;
  const runs = pendingWicketRuns;

  closeWicketModal();
  
  playVoiceCommentary('W');

  // Build dismissal string
  let dismissal = '';
  if (wType === 'Bowled') dismissal = `b ${inn.currentBowlerName}`;
  else if (wType === 'Caught') dismissal = `c ${fielder} b ${inn.currentBowlerName}`;
  else if (wType === 'LBW') dismissal = `lbw b ${inn.currentBowlerName}`;
  else if (wType === 'Run Out') dismissal = `run out (${fielder})`;
  else if (wType === 'Stumped') dismissal = `st ${fielder} b ${inn.currentBowlerName}`;
  else if (wType === 'Hit Wicket') dismissal = `hit wicket b ${inn.currentBowlerName}`;
  else if (wType === 'Retired Hurt') dismissal = `retired hurt`;

  const ball = {
    type: 'wicket',
    runs,
    extras: 0,
    extraType: null,
    isWicket: true,
    wicketType: wType,
    outBatsman,
    dismissal,
    fielder,
    bowler: inn.currentBowlerName,
    striker: inn.strikerName,
    nonStriker: inn.nonStrikerName,
    isLegal: true,
    overNumber: Math.floor(inn.balls / 6) + 1
  };

  // Update runs
  inn.runs += runs;
  inn.balls += 1;
  
  if (wType !== 'Retired Hurt') {
    inn.wickets += 1;
  }

  // Batter stats
  inn.batters[inn.strikerName].balls += 1;
  if (runs > 0) {
    inn.batters[inn.strikerName].runs += runs;
    if (runs === 4) inn.batters[inn.strikerName].fours += 1;
    if (runs === 6) inn.batters[inn.strikerName].sixes += 1;
  }

  // Bowler stats
  inn.bowlers[inn.currentBowlerName].balls += 1;
  inn.bowlers[inn.currentBowlerName].runs += runs;
  if (wType !== 'Run Out' && wType !== 'Retired Hurt') {
    inn.bowlers[inn.currentBowlerName].wickets += 1;
  }

  // Partnership Update (reset on wicket)
  inn.currentPartnership.runs += runs;
  inn.currentPartnership.balls += 1;
  // Note: reset happens after FOW

  // Mark batter out
  inn.batters[outBatsman].isOut = true;
  inn.batters[outBatsman].dismissal = dismissal;

  // FOW
  if (wType !== 'Retired Hurt') {
    inn.fow.push({
      runs: inn.runs,
      wickets: inn.wickets,
      overs: oversString(inn.balls),
      batter: outBatsman
    });
  }

  // Reset Partnership for the next pair
  inn.currentPartnership = { runs: 0, balls: 0, names: [inn.strikerName, inn.nonStrikerName] };

  inn.ballLog.push(ball);
  inn.overBalls.push(formatBallDisplay(ball));
  inn.overRuns += runs;

  // Rotate strike if odd runs
  if (runs % 2 !== 0) swapStrike(inn);

  showLastBall(ball);

  // Check if innings over (all out)
  const maxWkts = match.playersPerTeam - 1;
  if (inn.wickets >= maxWkts || inn.balls >= match.totalOvers * 6) {
    finishInnings(inn);
    renderScoring();
    return;
  }

  // Check if 2nd innings target chased
  if (match.currentInnings === 2) {
    const target = match.innings[0].runs + 1;
    if (inn.runs >= target) {
      finishInnings(inn);
      renderScoring();
      return;
    }
  }

  // Need new batter — show modal
  checkOverComplete(inn);
  renderScoring();
  promptNewBatter(outBatsman);
  syncState();
}

function promptNewBatter(outBatsman) {
  const inn = getInnings();
  const battingPlayers = getBattingTeamPlayers();
  const available = battingPlayers.filter(p => !inn.battedList.includes(p));

  if (available.length === 0) return; // all out handled elsewhere

  const sel = $('select-new-batter');
  sel.innerHTML = available.map(p => `<option value="${p}">${p}</option>`).join('');

  $('modal-new-batter').style.display = 'flex';
}

function confirmNewBatter() {
  const inn = getInnings();
  const newBatter = $('select-new-batter').value;

  inn.batters[newBatter] = createBatterStats(newBatter);
  inn.battedList.push(newBatter);

  // Replace the out batter — figure out who was out
  if (inn.batters[inn.strikerName] && inn.batters[inn.strikerName].isOut) {
    inn.strikerName = newBatter;
  } else if (inn.batters[inn.nonStrikerName] && inn.batters[inn.nonStrikerName].isOut) {
    inn.nonStrikerName = newBatter;
  } else {
    // Default: replace striker
    inn.strikerName = newBatter;
  }

  $('modal-new-batter').style.display = 'none';
  renderScoring();
  syncState();
}

// ===== OVER MANAGEMENT =====
function checkOverComplete(inn) {
  if (inn.balls > 0 && inn.balls % 6 === 0 && !inn.isComplete) {
    // Check for maiden
    const lastOverBowlerRuns = getLastOverBowlerRuns(inn);
    if (lastOverBowlerRuns === 0) {
      inn.bowlers[inn.currentBowlerName].maidens += 1;
    }

    // Update bowler overs display
    updateBowlerOvers(inn);

    // Swap strike at end of over
    swapStrike(inn);

    // Check if innings complete
    if (inn.balls >= match.totalOvers * 6) {
      finishInnings(inn);
      return;
    }

    // Check 2nd innings win
    if (match.currentInnings === 2) {
      const target = match.innings[0].runs + 1;
      if (inn.runs >= target) {
        finishInnings(inn);
        return;
      }
    }

    // Reset over display
    inn.overBalls = [];
    inn.overRuns = 0;
    inn.previousBowlerName = inn.currentBowlerName;
    match.phase = 'bowler-select';

    // Show new bowler selection
    showNewBowlerScreen(inn);
    syncState();
  }
}

function getLastOverBowlerRuns(inn) {
  // Count runs conceded by the bowler in the last 6 legal deliveries
  let count = 0;
  let runs = 0;
  for (let i = inn.ballLog.length - 1; i >= 0 && count < 6; i--) {
    const b = inn.ballLog[i];
    if (b.isLegal) {
      count++;
      runs += b.runs + b.extras;
    } else {
      runs += b.extras;
    }
  }
  return runs;
}

function updateBowlerOvers(inn) {
  Object.keys(inn.bowlers).forEach(name => {
    const bw = inn.bowlers[name];
    bw.overs = Math.floor(bw.balls / 6) + (bw.balls % 6) / 10;
    bw.eco = bw.balls > 0 ? (bw.runs / (bw.balls / 6)).toFixed(2) : '0.00';
  });
}

function showNewBowlerScreen(inn) {
  const bowlingPlayers = getBowlingTeamPlayers();
  // Cannot bowl the same bowler who just bowled
  const available = bowlingPlayers.filter(p => p !== inn.previousBowlerName);

  const sel = $('select-new-bowler');
  sel.innerHTML = available.map(p => {
    const stats = inn.bowlers[p];
    const label = stats ? `${p} (${oversString(stats.balls)}-${stats.runs}-${stats.wickets})` : p;
    return `<option value="${p}">${label}</option>`;
  }).join('');

  const oversCompleted = Math.floor(inn.balls / 6);
  $('over-complete-subtitle').textContent = `Over ${oversCompleted} complete — ${inn.runs}/${inn.wickets}`;

  showScreen('screen-new-bowler');
}

function setNewBowler() {
  const inn = getInnings();
  const bowlerName = $('select-new-bowler').value;

  inn.currentBowlerName = bowlerName;
  if (!inn.bowlers[bowlerName]) {
    inn.bowlers[bowlerName] = createBowlerStats(bowlerName);
  }
  match.phase = 'scoring';

  showScreen('screen-scoring');
  renderScoring();
  syncState();
}

function swapStrike(inn) {
  const temp = inn.strikerName;
  inn.strikerName = inn.nonStrikerName;
  inn.nonStrikerName = temp;
}

// ===== INNINGS END / MATCH RESULT =====
function finishInnings(inn) {
  inn.isComplete = true;
  updateBowlerOvers(inn);

  // Update batter SRs
  Object.values(inn.batters).forEach(b => {
    b.sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
  });

  if (match.currentInnings === 1) {
    toast(`${inn.battingTeamName} scored ${inn.runs}/${inn.wickets} in ${oversString(inn.balls)} overs`);
    match.phase = 'innings-select';
    syncState();
    setTimeout(() => setupInningsSelection(2), 1500);
  } else {
    decideResult();
  }
}

function checkInningsEnd(inn) {
  if (inn.isComplete) return;

  // All out
  if (inn.wickets >= match.playersPerTeam - 1) {
    finishInnings(inn);
    return;
  }

  // Overs complete
  if (inn.balls >= match.totalOvers * 6) {
    finishInnings(inn);
    return;
  }

  // 2nd innings target achieved
  if (match.currentInnings === 2) {
    const target = match.dlsTarget || (match.innings[0].runs + 1);
    if (inn.runs >= target) {
      finishInnings(inn);
      return;
    }
  }
}

function calculateAwards() {
  const allBatters = [];
  const allBowlers = [];
  const fielders = {};

  console.log('Match innings:', match.innings);

  match.innings.forEach((inn, idx) => {
    if (!inn) {
      console.log(`Innings ${idx} is null`);
      return;
    }

    console.log(`Processing innings ${idx}:`, inn);

    // Batters
    Object.values(inn.batters).forEach(b => {
      allBatters.push(b);
    });

    // Bowlers
    Object.values(inn.bowlers).forEach(b => {
      allBowlers.push(b);
    });

    // Fielders (from wickets)
    inn.ballLog.forEach(ball => {
      if (ball.isWicket && ball.fielder) {
        fielders[ball.fielder] = (fielders[ball.fielder] || 0) + 1;
      }
    });
  });

  console.log('All batters:', allBatters);
  console.log('All bowlers:', allBowlers);
  console.log('All fielders:', fielders);

  // 🏏 Best Batsman (highest runs)
  const bestBatsman = allBatters.length > 0 ? allBatters.sort((a, b) => b.runs - a.runs)[0] : null;

  // 🎯 Best Bowler (most wickets)
  const bestBowler = allBowlers.length > 0 ? allBowlers
    .filter(b => b.balls > 0)
    .sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0] : null;

  // 🧤 Best Fielder (most dismissals)
  const bestFielder = Object.entries(fielders).length > 0 ? Object.entries(fielders)
    .sort((a, b) => b[1] - a[1])[0] : null;

  // 🏆 MVP (Most Valuable Player) - Better formula
  let mvp = null;
  let mvpScore = -1;

  allBatters.forEach(b => {
    // Batting score: runs weighted heavily
    const battingScore = b.runs * 1.5;
    
    // Bowling score: wickets weighted high, runs given weighted negative
    const bowler = allBowlers.find(x => x.name === b.name);
    const bowlingScore = bowler ? (bowler.wickets * 50 - bowler.runs * 0.5) : 0;
    
    // Fielding score
    const fieldingScore = (fielders[b.name] || 0) * 30;
    
    const totalScore = battingScore + bowlingScore + fieldingScore;

    if (totalScore > mvpScore) {
      mvpScore = totalScore;
      mvp = b.name;
    }
  });

  console.log('Final awards:', { mvp, bestBatsman, bestBowler, bestFielder });

  return {
    mvp,
    bestBatsman,
    bestBowler,
    bestFielder
  };
}

function displayAwards() {
  const awardsEl = $('result-awards');
  if (!awardsEl) return;

  const awards = calculateAwards();

  // Build the stats line for best batsman
  const bbRuns   = awards.bestBatsman?.runs  ?? 0;
  const bbBalls  = awards.bestBatsman?.balls ?? 0;
  const bbFours  = awards.bestBatsman?.fours ?? 0;
  const bbSixes  = awards.bestBatsman?.sixes ?? 0;
  const bbSR     = bbBalls > 0 ? ((bbRuns / bbBalls) * 100).toFixed(1) : '0.0';

  // Build the stats line for best bowler
  const bwWkts  = awards.bestBowler?.wickets ?? 0;
  const bwRuns  = awards.bestBowler?.runs    ?? 0;
  const bwOvers = awards.bestBowler ? oversString(awards.bestBowler.balls) : '0.0';
  const bwEco   = awards.bestBowler?.balls > 0
    ? (awards.bestBowler.runs / (awards.bestBowler.balls / 6)).toFixed(1)
    : '0.0';

  awardsEl.innerHTML = `
    <div class="awards-header">
      <span class="awards-header-icon">🏅</span>
      Match Awards
    </div>
    <div class="awards-grid">

      <!-- Player of the Match -->
      <div class="award-card award-mvp">
        <div class="award-icon">🏆</div>
        <div class="award-body">
          <div class="award-label">Player of the Match</div>
          <div class="award-name">${awards.mvp || '—'}</div>
          <div class="award-sub">Most Valuable Player</div>
        </div>
      </div>

      <!-- Best Batsman -->
      <div class="award-card award-bat">
        <div class="award-icon">🏏</div>
        <div class="award-body">
          <div class="award-label">Best Batsman</div>
          <div class="award-name">${awards.bestBatsman?.name || '—'}</div>
          <div class="award-stats">
            <span class="award-stat-pill">${bbRuns} runs</span>
            <span class="award-stat-pill">${bbBalls} balls</span>
            <span class="award-stat-pill">SR ${bbSR}</span>
            ${bbFours > 0 ? `<span class="award-stat-pill award-four">${bbFours}×4</span>` : ''}
            ${bbSixes > 0 ? `<span class="award-stat-pill award-six">${bbSixes}×6</span>` : ''}
          </div>
        </div>
      </div>

      <!-- Best Bowler -->
      <div class="award-card award-bowl">
        <div class="award-icon">🎯</div>
        <div class="award-body">
          <div class="award-label">Best Bowler</div>
          <div class="award-name">${awards.bestBowler?.name || '—'}</div>
          <div class="award-stats">
            <span class="award-stat-pill">${bwWkts}/${bwRuns}</span>
            <span class="award-stat-pill">${bwOvers} ov</span>
            <span class="award-stat-pill">Eco ${bwEco}</span>
          </div>
        </div>
      </div>

      <!-- Best Fielder -->
      <div class="award-card award-field">
        <div class="award-icon">🧤</div>
        <div class="award-body">
          <div class="award-label">Best Fielder</div>
          <div class="award-name">${awards.bestFielder ? awards.bestFielder[0] : '—'}</div>
          <div class="award-stats">
            <span class="award-stat-pill">${awards.bestFielder ? awards.bestFielder[1] : 0} dismissal${(awards.bestFielder?.[1] ?? 0) !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>

    </div>`;

  awardsEl.style.display = 'block';
}

function decideResult() {
  const inn1 = match.innings[0];
  renderMatchGraphs();
  const inn2 = match.innings[1];

  let resultText = '';
  let isTie = false;

  if (inn2.runs > inn1.runs) {
    const wicketsLeft = (match.playersPerTeam - 1) - inn2.wickets;
    resultText = `${inn2.battingTeamName} won by ${wicketsLeft} wicket${wicketsLeft !== 1 ? 's' : ''}!`;
  } else if (inn1.runs > inn2.runs) {
    const diff = inn1.runs - inn2.runs;
    resultText = `${inn1.battingTeamName} won by ${diff} run${diff !== 1 ? 's' : ''}!`;
  } else {
    resultText = 'Match Tied!';
    isTie = true;
  }

  match.result = resultText;
  match.phase = 'result';

  // Trophy emoji — tie gets handshake
  $('result-trophy-emoji').textContent = isTie ? '🤝' : '🏆';

  // Winner text
  $('result-winner').textContent = resultText;

  $('result-scorecard-wrap').innerHTML = buildResultMiniScorecard(inn1, inn2);

  // Score summary cards (highlight winner)
  const inn1won = inn1.runs > inn2.runs;
  const inn2won = inn2.runs > inn1.runs;
  $('result-cards').innerHTML = `
    <div class="result-summary-card ${inn1won ? 'result-card-winner' : ''}">
      <div class="result-team-name">${inn1.battingTeamName}</div>
      <div class="result-team-score">${inn1.runs}/${inn1.wickets} <small>(${oversString(inn1.balls)} ov)</small></div>
    </div>
    <div class="result-vs-sep">vs</div>
    <div class="result-summary-card ${inn2won ? 'result-card-winner' : ''}">
      <div class="result-team-name">${inn2.battingTeamName}</div>
      <div class="result-team-score">${inn2.runs}/${inn2.wickets} <small>(${oversString(inn2.balls)} ov)</small></div>
    </div>`;

  // ── Inline mini scorecard (batting highlights for both innings) ──
  $('result-scorecard-wrap').innerHTML = buildResultMiniScorecard(inn1, inn2);

  // ── Save to history ──
  saveMatchToHistory();

  showScreen('screen-result');

  // ── Display Awards (after screen is shown) ──
  setTimeout(() => {
    displayAwards();
  }, 50);
}

// Build a compact batting + bowling summary for the result screen
function buildResultMiniScorecard(inn1, inn2) {
  let html = '';
  [inn1, inn2].forEach(inn => {
    // Top 3 scorers
    const scorers = inn.battedList
      .map(n => inn.batters[n]).filter(Boolean)
      .sort((a, b) => b.runs - a.runs).slice(0, 3);

    // Best bowler
    const bestBowler = Object.values(inn.bowlers)
      .filter(b => b.balls > 0)
      .sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];

    html += `<div class="rsc-block">
      <div class="rsc-inn-label">${inn.battingTeamName} — ${inn.runs}/${inn.wickets} (${oversString(inn.balls)})</div>
      <div class="rsc-rows">`;

    scorers.forEach(b => {
      const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(0) : 0;
      html += `<div class="rsc-row">
        <span class="rsc-name">${b.name}</span>
        <span class="rsc-stat">${b.runs}${!b.isOut ? '*' : ''} <em>(${b.balls}b, SR ${sr})</em></span>
      </div>`;
    });

    if (bestBowler) {
      const eco = bestBowler.balls > 0 ? (bestBowler.runs / (bestBowler.balls / 6)).toFixed(1) : '—';
      html += `<div class="rsc-row rsc-bowler-row">
        <span class="rsc-name">⚡ ${bestBowler.name}</span>
        <span class="rsc-stat">${bestBowler.wickets}/${bestBowler.runs} <em>(${oversString(bestBowler.balls)} ov, Eco ${eco})</em></span>
      </div>`;
    }

    html += `</div></div>`;
  });
  return html;
}

// Navigate from result screen → full scorecard
function showResultScorecard() {
  showScorecard('screen-result');
}

// Navigate from result screen → history (records this match)
function showHistoryFromResult() {
  renderHistoryScreen();
  showScreen('screen-history');
}

function newMatch() {
  if (match && match.phase === 'scoring') {
    if (!confirm("Start new match? Current match progress will be lost.")) return;
  }
  clearMatchState();
  match = {
    team1: { name: '', players: [] },
    team2: { name: '', players: [] },
    totalOvers: 20,
    playersPerTeam: 11,
    battingFirst: 1,
    currentInnings: 1,
    innings: [null, null],
    result: null
  };
  showScreen('screen-setup');
}

function confirmEndMatch() {
  const modal = $('modal-end-match');
  if (modal) modal.style.display = 'flex';
}

function openDLSFromMatch() {
  // Auto-populate DLS fields if in a match
  if (match && match.phase === 'scoring') {
    const inn1 = match.innings[0];
    const inn2 = match.innings[1];
    
    if (inn1) {
      $('dls-team1-score').value = inn1.runs;
      $('dls-total-overs').value = match.totalOvers;
    }
    
    if (match.currentInnings === 2 && inn2) {
      $('dls-interrupted-overs').value = (inn2.balls / 6).toFixed(1);
      $('dls-interrupted-wickets').value = inn2.wickets;
    } else {
      // Clear 2nd innings fields if not started
      $('dls-interrupted-overs').value = '';
      $('dls-interrupted-wickets').value = '0';
    }
  }
  showScreen('screen-dls');
  // Trigger calculation AFTER showing screen to ensure elements are ready
  setTimeout(() => runDLS(), 100);
}

function hideEndMatchModal() {
  const modal = $('modal-end-match');
  if (modal) modal.style.display = 'none';
}

function executeEndMatch() {
  hideEndMatchModal();
  clearMatchState();
  // Reset match object to initial state
  match = {
    team1: { name: '', players: [] },
    team2: { name: '', players: [] },
    totalOvers: 20,
    playersPerTeam: 11,
    battingFirst: 1,
    currentInnings: 1,
    innings: [null, null],
    result: null
  };
  toast("Match ended and data cleared");
  showHome();
}

// ===== UNDO =====
function undoLastBall() {
  const inn = getInnings();
  if (inn.ballLog.length === 0) {
    toast('Nothing to undo');
    return;
  }

  const ball = inn.ballLog.pop();
  inn.overBalls.pop();
  inn.overRuns -= (ball.runs + ball.extras);

  // Reverse runs
  inn.runs -= (ball.runs + ball.extras);

  // Reverse batter stats
  if (ball.isLegal || ball.extraType === 'bye' || ball.extraType === 'legBye') {
    inn.batters[ball.striker].balls -= 1;
  }

  if (ball.type === 'normal') {
    inn.batters[ball.striker].runs -= ball.runs;
    if (ball.runs === 4) inn.batters[ball.striker].fours -= 1;
    if (ball.runs === 6) inn.batters[ball.striker].sixes -= 1;
  }

  // Reverse bowler stats
  if (ball.isLegal) {
    inn.bowlers[ball.bowler].balls -= 1;
    inn.balls -= 1;
  }
  inn.bowlers[ball.bowler].runs -= (ball.runs + ball.extras);

  if (ball.extraType === 'wide') {
    inn.extras.wide -= 1;
    inn.totalExtras -= 1;
    inn.bowlers[ball.bowler].wides -= 1;
  } else if (ball.extraType === 'noBall') {
    inn.extras.noBall -= 1;
    inn.totalExtras -= 1;
    inn.bowlers[ball.bowler].noBalls -= 1;
  } else if (ball.extraType === 'bye') {
    inn.extras.bye -= 1;
    inn.totalExtras -= 1;
  } else if (ball.extraType === 'legBye') {
    inn.extras.legBye -= 1;
    inn.totalExtras -= 1;
  }

  // Reverse wicket
  if (ball.isWicket) {
    inn.wickets -= 1;
    inn.batters[ball.outBatsman].isOut = false;
    inn.batters[ball.outBatsman].dismissal = '';
    inn.fow.pop();

    if (ball.wicketType !== 'Run Out') {
      inn.bowlers[ball.bowler].wickets -= 1;
    }

    // Remove the newly added batter if one was added
    const lastBatted = inn.battedList[inn.battedList.length - 1];
    if (lastBatted !== ball.striker && lastBatted !== ball.nonStriker) {
      delete inn.batters[lastBatted];
      inn.battedList.pop();
    }
  }

  // Restore striker/non-striker
  inn.strikerName = ball.striker;
  inn.nonStrikerName = ball.nonStriker;

  // Reverse strike rotation
  // We don't need to reverse — we restored from the ball data

  toast('Last ball undone');
  renderScoring();
  syncState();
}

// ===== DISPLAY HELPERS =====
function formatBallDisplay(ball) {
  if (ball.isWicket) return ball.wicketType === 'Retired Hurt' ? 'RH' : 'W';
  if (ball.extraType === 'wide') return 'Wd';
  if (ball.extraType === 'noBall') return 'NB';
  if (ball.extraType === 'bye') return 'B';
  if (ball.extraType === 'legBye') return 'LB';
  if (ball.runs === 4) return '4';
  if (ball.runs === 6) return '6';
  return String(ball.runs);
}

function ballClass(display) {
  if (display === 'W') return 'ball-wicket';
  if (display === 'RH') return 'ball-extra';
  if (display === '4') return 'ball-four';
  if (display === '6') return 'ball-six';
  if (display === 'Wd' || display === 'NB' || display === 'B' || display === 'LB') return 'ball-extra';
  if (display === '0') return 'ball-dot';
  return 'ball-run';
}

function showLastBall(ball) {
  const el = $('last-ball-indicator');
  const display = formatBallDisplay(ball);
  el.style.display = 'block';
  el.className = `last-ball-indicator ${ballClass(display)}`;
  el.textContent = display === '0' ? '• Dot Ball' : display === 'W' ? '🔴 WICKET!' : display === 'RH' ? '🩹 RETIRED HURT' : display;
  setTimeout(() => { el.style.display = 'none'; }, 1800);
}

// ===== RENDER SCORING SCREEN =====
function renderScoring() {
  const inn = getInnings();
  renderCommentary();
  if (!inn) return;

  // Innings label
  $('innings-label').textContent = match.currentInnings === 1 ? '1st Innings' : '2nd Innings';

  // Team name and score
  $('batting-team-name').textContent = inn.battingTeamName;
  $('score-runs').textContent = inn.runs;
  $('score-wickets').textContent = inn.wickets;
$('score-overs').textContent =
  `${oversString(inn.balls)} / ${match.totalOvers} Overs`;  $('run-rate').textContent = `CRR: ${currentRunRate(inn)}`;

  // Target info (2nd innings)
  if (match.currentInnings === 2 && match.innings[0]) {
    const target = match.dlsTarget || (match.innings[0].runs + 1);
    const remaining = target - inn.runs;
    const ballsLeft = Math.max(0, (match.totalOvers * 6) - inn.balls);
    $('target-block').classList.remove('hidden');
    $('target-info').textContent = `Target: ${target} ${match.dlsTarget ? '(DLS)' : ''} | Need ${remaining} from ${ballsLeft} balls`;
    $('required-rr').textContent = `RRR: ${requiredRunRate(target, inn.runs, ballsLeft)}`;
  } else {
    $('target-block').classList.add('hidden');
  }

  // Batsmen at crease
  const striker = inn.batters[inn.strikerName];
  const nonStriker = inn.batters[inn.nonStrikerName];

  if (striker) {
    $('batter-striker').innerHTML = `
      <div class="batter-name">${striker.name}</div>
      <div class="batter-stats">${striker.runs} (${striker.balls}) | ${striker.fours}×4 ${striker.sixes}×6</div>
      <div class="batter-badge striker-badge">*</div>`;
  }
  if (nonStriker) {
    $('batter-non-striker').innerHTML = `
      <div class="batter-name">${nonStriker.name}</div>
      <div class="batter-stats">${nonStriker.runs} (${nonStriker.balls}) | ${nonStriker.fours}×4 ${nonStriker.sixes}×6</div>`;
  }

  // Current Partnership Display
  if ($('current-partnership')) {
    const cp = inn.currentPartnership;
    $('current-partnership').innerHTML = `
      <div class="partnership-label">Current Partnership</div>
      <div class="partnership-value">${cp.runs} runs from ${cp.balls} balls</div>
    `;
  }

  // Current bowler
  const bowler = inn.bowlers[inn.currentBowlerName];
  if (bowler) {
    const oStr = oversString(bowler.balls);
    $('bowler-current').innerHTML = `
      <div class="bowler-name">${bowler.name}</div>
      <div class="bowler-stats">${oStr}-${bowler.maidens}-${bowler.runs}-${bowler.wickets}</div>`;
  }

  // This over balls
  const overBallsEl = $('over-balls');
  overBallsEl.innerHTML = inn.overBalls.map(b => `<span class="ball-chip ${ballClass(b)}">${b}</span>`).join('');
  $('over-runs-display').textContent = `${inn.overRuns} run${inn.overRuns !== 1 ? 's' : ''} this over`;

  // Match situation
  const sitEl = $('match-situation');
  if (match.currentInnings === 1) {
    sitEl.textContent = '';
  } else if (match.innings[0]) {
    const target = match.innings[0].runs + 1;
    const remaining = target - inn.runs;
    sitEl.textContent = remaining > 0 ? `Need ${remaining} more runs` : '';
  }
}

// Tracks which screen opened the scorecard, so back button goes to the right place
let scorecardCalledFrom = 'screen-scoring';

// ===== SCORECARD =====
function showScorecard(from) {
  scorecardCalledFrom = from || 'screen-scoring';
  const body = $('scorecard-body');
  let html = '';

  for (let idx = 0; idx < 2; idx++) {
    const inn = match.innings[idx];
    if (!inn) continue;

    html += `<div class="scorecard-innings">`;
    html += `<div class="scorecard-innings-header">
      <span class="sc-team-name">${inn.battingTeamName}</span>
      <span class="sc-team-score">${inn.runs}/${inn.wickets} (${oversString(inn.balls)} ov)</span>
    </div>`;

    // Batting table
    html += `<table class="sc-table sc-table-bat"><thead><tr>
      <th>Batter</th><th>Dismissal</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th>
    </tr></thead><tbody>`;

    inn.battedList.forEach(name => {
      const b = inn.batters[name];
      if (!b) return;
      const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
      const dis = b.isOut ? b.dismissal : (inn.isComplete ? 'not out' : 'batting');
      html += `<tr class="${!b.isOut ? 'not-out' : ''}">
        <td>${b.name}</td><td class="dismissal-cell">${dis}</td>
        <td>${b.runs}</td><td>${b.balls}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${sr}</td>
      </tr>`;
    });

    html += `</tbody></table>`;

    // Extras
    html += `<div class="sc-extras">Extras: ${inn.totalExtras} (Wd ${inn.extras.wide}, NB ${inn.extras.noBall}, B ${inn.extras.bye}, LB ${inn.extras.legBye})</div>`;

    // Bowling table
    html += `<div class="sc-section-title">Bowling</div>`;
    html += `<table class="sc-table sc-table-bowl"><thead><tr>
      <th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Eco</th>
    </tr></thead><tbody>`;

    Object.values(inn.bowlers).forEach(bw => {
      const eco = bw.balls > 0 ? (bw.runs / (bw.balls / 6)).toFixed(2) : '0.00';
      html += `<tr>
        <td>${bw.name}</td><td>${oversString(bw.balls)}</td><td>${bw.maidens}</td>
        <td>${bw.runs}</td><td>${bw.wickets}</td><td>${eco}</td>
      </tr>`;
    });

    html += `</tbody></table>`;

    // FOW
    if (inn.fow.length > 0) {
      html += `<div class="sc-section-title">Fall of Wickets</div><div class="sc-fow">`;
      inn.fow.forEach(f => {
        html += `<span class="fow-chip">${f.runs}/${f.wickets} (${f.overs} ov, ${f.batter})</span>`;
      });
      html += `</div>`;
    }

    html += `</div>`;
  }

  body.innerHTML = profileHeaderHtml + html;
  showScreen('screen-scorecard');
}

function hideScorecard() {
  showScreen(scorecardCalledFrom);
}

// ===================================================
// ============  PLAYER STATS SCREEN  ================
// ===================================================

let psCurrentTab = 'batting';   // 'batting' | 'bowling'
let psCurrentTeam = 'all';      // 'all' | team name

function showPlayerStats() {
  psCurrentTab = 'batting';
  psCurrentTeam = 'all';
  renderPlayerStats();
  showScreen('screen-player-stats');
}

function hidePlayerStats() {
  showScreen('screen-scoring');
}

function switchStatsTab(tab) {
  psCurrentTab = tab;
  document.querySelectorAll('.ps-tab').forEach(t => t.classList.remove('active'));
  $(`tab-${tab}`).classList.add('active');
  renderPlayerStatsBody();
}

// Build team filter pills
function renderTeamFilter() {
  const teamNames = [match.team1.name, match.team2.name].filter(Boolean);
  const filterEl = $('ps-team-filter');
  let html = `<button class="ps-pill ${psCurrentTeam === 'all' ? 'active' : ''}" onclick="filterStatsTeam('all')">All Players</button>`;
  teamNames.forEach(name => {
    html += `<button class="ps-pill ${psCurrentTeam === name ? 'active' : ''}" onclick="filterStatsTeam('${name}')">${name}</button>`;
  });
  filterEl.innerHTML = html;
}

function filterStatsTeam(team) {
  psCurrentTeam = team;
  renderTeamFilter();
  renderPlayerStatsBody();
}

// Aggregate stats for ALL players across both innings
function aggregateAllStats() {
  const batting = {};  // playerName -> { name, team, runs, balls, fours, sixes, dismissals, hs, innings[] }
  const bowling = {};  // playerName -> { name, team, balls, runs, wickets, maidens, wides, noBalls }

  const allTeams = [
    { team: match.team1, teamName: match.team1.name },
    { team: match.team2, teamName: match.team2.name }
  ];

  // Seed all players so even those who didn't bat/bowl appear
  allTeams.forEach(({ team, teamName }) => {
    team.players.forEach(p => {
      batting[p] = batting[p] || {
        name: p, team: teamName,
        runs: 0, balls: 0, fours: 0, sixes: 0,
        dismissals: 0, inningsPlayed: 0,
        scores: [], notOuts: 0, hs: 0, hsNotOut: false
      };
      bowling[p] = bowling[p] || {
        name: p, team: teamName,
        balls: 0, runs: 0, wickets: 0, maidens: 0,
        wides: 0, noBalls: 0, inningsBowled: 0,
        bestWickets: 0, bestRuns: 999
      };
    });
  });

  match.innings.forEach(inn => {
    if (!inn) return;
    const battingTeamName = inn.battingTeamName;
    const bowlingTeamName = inn.bowlingTeamName;

    // Batting
    Object.values(inn.batters).forEach(b => {
      const agg = batting[b.name];
      if (!agg) return;
      agg.runs += b.runs;
      agg.balls += b.balls;
      agg.fours += b.fours;
      agg.sixes += b.sixes;
      agg.inningsPlayed += 1;
      agg.scores.push({ runs: b.runs, notOut: !b.isOut });
      if (b.runs > agg.hs) {
        agg.hs = b.runs;
        agg.hsNotOut = !b.isOut;
      }
      if (b.isOut) { agg.dismissals += 1; }
      else { agg.notOuts += 1; }
    });

    // Bowling
    Object.values(inn.bowlers).forEach(bw => {
      const agg = bowling[bw.name];
      if (!agg) return;
      agg.balls += bw.balls;
      agg.runs += bw.runs;
      agg.wickets += bw.wickets;
      agg.maidens += bw.maidens;
      agg.wides += bw.wides;
      agg.noBalls += bw.noBalls;
      agg.inningsBowled += 1;
      // Best figures
      if (bw.wickets > agg.bestWickets ||
         (bw.wickets === agg.bestWickets && bw.runs < agg.bestRuns)) {
        agg.bestWickets = bw.wickets;
        agg.bestRuns = bw.runs;
      }
    });
  });

  // Compute derived stats
  Object.values(batting).forEach(b => {
    b.avg = b.dismissals > 0 ? (b.runs / b.dismissals).toFixed(1) : (b.runs > 0 ? '—' : '0.0');
    b.sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
    b.fifties = b.scores.filter(s => s.runs >= 50 && s.runs < 100).length;
    b.hundreds = b.scores.filter(s => s.runs >= 100).length;
    b.ducks = b.scores.filter(s => s.runs === 0 && !s.notOut).length;
  });

  Object.values(bowling).forEach(bw => {
    bw.overs = oversString(bw.balls);
    bw.eco = bw.balls > 0 ? (bw.runs / (bw.balls / 6)).toFixed(2) : '0.00';
    bw.avg = bw.wickets > 0 ? (bw.runs / bw.wickets).toFixed(1) : '—';
    bw.sr  = bw.wickets > 0 ? (bw.balls / bw.wickets).toFixed(1) : '—';
    bw.best = bw.inningsBowled > 0 ? `${bw.bestWickets}/${bw.bestRuns === 999 ? 0 : bw.bestRuns}` : '—';
  });

  return { batting, bowling };
}

function renderPlayerStats() {
  renderTeamFilter();
  renderPlayerStatsBody();
}

function renderPlayerStatsBody() {
  const { batting, bowling } = aggregateAllStats();
  const bodyEl = $('ps-body');

  if (psCurrentTab === 'batting') {
    // Filter by team
    let batters = Object.values(batting);
    if (psCurrentTeam !== 'all') batters = batters.filter(b => b.team === psCurrentTeam);
    // Sort by runs desc
    batters.sort((a, b) => b.runs - a.runs || b.balls - a.balls);

    if (batters.length === 0) { bodyEl.innerHTML = '<div class="ps-empty">No batting data yet</div>'; return; }

    let html = '<div class="ps-cards-grid">';
    batters.forEach(b => {
      const srClass = parseFloat(b.sr) >= 150 ? 'stat-hot' : parseFloat(b.sr) >= 100 ? 'stat-good' : '';
      const avgClass = parseFloat(b.avg) >= 50 ? 'stat-hot' : parseFloat(b.avg) >= 30 ? 'stat-good' : '';
      html += `
      <div class="ps-card">
        <div class="ps-card-header">
          <div class="ps-avatar">${b.name.charAt(0).toUpperCase()}</div>
          <div class="ps-card-info">
            <div class="ps-player-name">${b.name}</div>
            <div class="ps-player-team">${b.team}</div>
          </div>
          <div class="ps-card-hs">
            <div class="ps-hs-runs">${b.hs}${b.hsNotOut ? '*' : ''}</div>
            <div class="ps-hs-label">Best</div>
          </div>
        </div>
        <div class="ps-stats-row">
          <div class="ps-stat-item">
            <div class="ps-stat-val">${b.runs}</div>
            <div class="ps-stat-lbl">Runs</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${b.balls}</div>
            <div class="ps-stat-lbl">Balls</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val ${srClass}">${b.sr}</div>
            <div class="ps-stat-lbl">SR</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val ${avgClass}">${b.avg}</div>
            <div class="ps-stat-lbl">Avg</div>
          </div>
        </div>
        <div class="ps-stats-row ps-stats-row-sm">
          <div class="ps-stat-item">
            <div class="ps-stat-val ps-four">${b.fours}</div>
            <div class="ps-stat-lbl">4s</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val ps-six">${b.sixes}</div>
            <div class="ps-stat-lbl">6s</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${b.inningsPlayed}</div>
            <div class="ps-stat-lbl">Inn</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${b.fifties > 0 || b.hundreds > 0 ? b.fifties + '/' + b.hundreds : '—'}</div>
            <div class="ps-stat-lbl">50/100</div>
          </div>
        </div>
        ${b.inningsPlayed > 0 ? `<div class="ps-innings-bar">${b.scores.map(s => `<span class="ps-score-chip ${s.notOut ? 'ps-not-out' : s.runs === 0 ? 'ps-duck' : ''}">${s.runs}${s.notOut ? '*' : ''}</span>`).join('')}</div>` : ''}
      </div>`;
    });
    html += '</div>';
    bodyEl.innerHTML = html;

  } else {
    // Bowling tab
    let bowlers = Object.values(bowling);
    if (psCurrentTeam !== 'all') bowlers = bowlers.filter(b => b.team === psCurrentTeam);
    // Only show those who have bowled
    bowlers = bowlers.filter(b => b.balls > 0);
    // Sort by wickets desc, then eco asc
    bowlers.sort((a, b) => b.wickets - a.wickets || parseFloat(a.eco) - parseFloat(b.eco));

    if (bowlers.length === 0) { bodyEl.innerHTML = '<div class="ps-empty">No bowling data yet</div>'; return; }

    let html = '<div class="ps-cards-grid">';
    bowlers.forEach(bw => {
      const ecoClass = parseFloat(bw.eco) <= 6 ? 'stat-hot' : parseFloat(bw.eco) <= 9 ? 'stat-good' : '';
      const wktClass = bw.wickets >= 4 ? 'stat-hot' : bw.wickets >= 2 ? 'stat-good' : '';
      html += `
      <div class="ps-card">
        <div class="ps-card-header">
          <div class="ps-avatar ps-avatar-bowl">${bw.name.charAt(0).toUpperCase()}</div>
          <div class="ps-card-info">
            <div class="ps-player-name">${bw.name}</div>
            <div class="ps-player-team">${bw.team}</div>
          </div>
          <div class="ps-card-hs">
            <div class="ps-hs-runs ${wktClass}">${bw.wickets}</div>
            <div class="ps-hs-label">Wkts</div>
          </div>
        </div>
        <div class="ps-stats-row">
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.overs}</div>
            <div class="ps-stat-lbl">Overs</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.runs}</div>
            <div class="ps-stat-lbl">Runs</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val ${ecoClass}">${bw.eco}</div>
            <div class="ps-stat-lbl">Eco</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.avg}</div>
            <div class="ps-stat-lbl">Avg</div>
          </div>
        </div>
        <div class="ps-stats-row ps-stats-row-sm">
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.maidens}</div>
            <div class="ps-stat-lbl">Maidens</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.sr}</div>
            <div class="ps-stat-lbl">Bowl SR</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.best}</div>
            <div class="ps-stat-lbl">Best</div>
          </div>
          <div class="ps-stat-item">
            <div class="ps-stat-val">${bw.wides + bw.noBalls}</div>
            <div class="ps-stat-lbl">Wd+NB</div>
          </div>
        </div>
      </div>`;
    });
    html += '</div>';
    bodyEl.innerHTML = html;
  }
}


// ===================================================
// ============  MATCH HISTORY FEATURE  ==============
// ===================================================

// ── Global Match History State ──
let globalMatchHistory = [];

async function fetchGlobalHistory() {
  try {
    const res = await fetch('/api/matches');
    if (res.ok) {
      const data = await res.json();
      globalMatchHistory = data.reverse(); // Newest first
    }
  } catch(e) {
    console.error("Failed to fetch global history:", e);
  }
}

function loadHistory() {
  return globalMatchHistory;
}

async function saveMatchToHistory() {
  if (_isViewer) return;
  const inn1 = match.innings[0];
  const inn2 = match.innings[1];
  
  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  const userPhone = userData.phone || 'guest';

  const entry = {
    id: Date.now(),
    date: new Date().toISOString(),
    owner: userPhone,
    team1: match.team1,
    team2: match.team2,
    overs: match.overs,
    playersPerTeam: match.playersPerTeam,
    result: match.result,
    innings: [
      snapshotInnings(inn1),
      snapshotInnings(inn2)
    ]
  };

  try {
    await fetch('/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    await fetchGlobalHistory();
  } catch(e) {
    console.error("Failed to save match to server:", e);
  }
}

function snapshotInnings(inn) {
  return {
    battingTeamName: inn.battingTeamName,
    bowlingTeamName: inn.bowlingTeamName,
    runs: inn.runs,
    wickets: inn.wickets,
    balls: inn.balls,
    extras: { ...inn.extras },
    totalExtras: inn.totalExtras,
    battedList: [...inn.battedList],
    batters: JSON.parse(JSON.stringify(inn.batters)),
    bowlers: JSON.parse(JSON.stringify(inn.bowlers)),
    ballLog: inn.ballLog ? JSON.parse(JSON.stringify(inn.ballLog)) : [],
    fow: [...inn.fow]
  };
}

// ── Navigation ──
async function showHistory() {
  if (!isLoggedIn()) {
    toast("Please login to view match history");
    showScreen('screen-login');
    return;
  }
  await fetchGlobalHistory();
  renderHistoryScreen();
  showScreen('screen-history');
}

function hideHistory() {
  showScreen('screen-setup');
}

function clearHistory() {
  if (!confirm('Clear all match history? This cannot be undone.')) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistoryScreen();
  toast('History cleared');
}

// ── Main render ──
function renderHistoryScreen() {
  const history = loadHistory();
  const body = $('history-body');

  if (history.length === 0) {
    body.innerHTML = `
      <div class="hist-empty">
        <div class="hist-empty-icon">🏏</div>
        <div class="hist-empty-title">No matches yet</div>
        <div class="hist-empty-sub">Completed matches will appear here</div>
      </div>`;
    return;
  }

  let html = '<div class="hist-list">';
  history.forEach((entry, idx) => {
    const inn1 = entry.innings[0];
    const inn2 = entry.innings[1];
    const dateStr = formatHistoryDate(entry.date);

    // Determine winner highlight
    const inn1won = inn1.battingTeamName === entry.result.split(' won')[0];

    html += `
    <div class="hist-card" id="hist-card-${idx}">
      <!-- Summary row (always visible) -->
      <div class="hist-summary" onclick="toggleHistDetail(${idx})">
        <div class="hist-meta">
          <span class="hist-date">${dateStr}</span>
          <span class="hist-format">${entry.overs} Ov · ${entry.playersPerTeam}a-side</span>
        </div>

        <div class="hist-teams">
          <div class="hist-team-row ${inn1won ? 'hist-winner' : ''}">
            <span class="hist-team-name">${inn1.battingTeamName}</span>
            <span class="hist-team-score">${inn1.runs}/${inn1.wickets} <small>(${oversString(inn1.balls)})</small></span>
          </div>
          <div class="hist-vs">vs</div>
          <div class="hist-team-row ${!inn1won && entry.result !== 'Match Tied!' ? 'hist-winner' : ''}">
            <span class="hist-team-name">${inn2.battingTeamName}</span>
            <span class="hist-team-score">${inn2.runs}/${inn2.wickets} <small>(${oversString(inn2.balls)})</small></span>
          </div>
        </div>

        <div class="hist-result-banner ${entry.result === 'Match Tied!' ? 'hist-tie' : ''}">
          ${entry.result}
        </div>

        <div class="hist-expand-icon" id="hist-icon-${idx}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>

      <!-- Expandable full scorecard -->
      <div class="hist-detail" id="hist-detail-${idx}" style="display:none;">
        ${renderHistoryScorecard(entry)}
      </div>
    </div>`;
  });

  html += '</div>';
  body.innerHTML = html;
}

// Toggle expand/collapse of a match detail
function toggleHistDetail(idx) {
  const detail = $(`hist-detail-${idx}`);
  const icon   = $(`hist-icon-${idx}`);
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  icon.style.transform  = isOpen ? '' : 'rotate(180deg)';
}

// ── Build a full scorecard HTML for one history entry ──
function renderHistoryScorecard(entry) {
  let html = '';

  entry.innings.forEach(inn => {
    html += `<div class="hist-sc-innings">`;
    html += `<div class="hist-sc-header">
      <span>${inn.battingTeamName} batting</span>
      <span class="hist-sc-score">${inn.runs}/${inn.wickets} (${oversString(inn.balls)} ov)</span>
    </div>`;

    // Batting table
    html += `<table class="sc-table hist-table"><thead><tr>
      <th>Batter</th><th>Dismissal</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th>
    </tr></thead><tbody>`;

    inn.battedList.forEach(name => {
      const b = inn.batters[name];
      if (!b) return;
      const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
      const dis = b.isOut ? b.dismissal : 'not out';
      html += `<tr class="${!b.isOut ? 'not-out' : ''}">
        <td>${b.name}</td>
        <td class="dismissal-cell">${dis}</td>
        <td>${b.runs}</td><td>${b.balls}</td>
        <td>${b.fours}</td><td>${b.sixes}</td><td>${sr}</td>
      </tr>`;
    });
    html += `</tbody></table>`;

    // Extras & total
    html += `<div class="sc-extras">Extras: ${inn.totalExtras} (Wd ${inn.extras.wide}, NB ${inn.extras.noBall}, B ${inn.extras.bye}, LB ${inn.extras.legBye})</div>`;

    // Bowling table
    html += `<div class="sc-section-title">Bowling</div>`;
    html += `<table class="sc-table hist-table"><thead><tr>
      <th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Eco</th>
    </tr></thead><tbody>`;

    Object.values(inn.bowlers).forEach(bw => {
      const eco = bw.balls > 0 ? (bw.runs / (bw.balls / 6)).toFixed(2) : '0.00';
      html += `<tr>
        <td>${bw.name}</td>
        <td>${oversString(bw.balls)}</td><td>${bw.maidens}</td>
        <td>${bw.runs}</td><td>${bw.wickets}</td><td>${eco}</td>
      </tr>`;
    });
    html += `</tbody></table>`;

    // FOW
    if (inn.fow && inn.fow.length > 0) {
      html += `<div class="sc-section-title">Fall of Wickets</div><div class="sc-fow">`;
      inn.fow.forEach(f => {
        html += `<span class="fow-chip">${f.runs}/${f.wickets} (${f.overs} ov, ${f.batter})</span>`;
      });
      html += `</div>`;
    }

    html += `</div>`;   // hist-sc-innings
  });

  return html;
}

// ── Date formatter ──
function formatHistoryDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHrs  = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 2)  return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHrs < 24)  return `${diffHrs}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7)  return `${diffDays} days ago`;

    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

// ===================================================
// ============  CAREER STATS FEATURE  ===============
// ===================================================

let careerTab = 'batting';
let _isPersonalStats = false; // 'batting' or 'bowling'

async function showCareerStats(isPersonal = false) {
  try {
    await fetchGlobalHistory();
    console.log("showCareerStats called with isPersonal:", isPersonal);
    _isPersonalStats = isPersonal;
    careerTab = 'batting';
    
    const searchInput = $('career-search-input');
    if (searchInput) searchInput.value = '';
    
    const searchContainer = $('career-search-container');
    if (searchContainer) searchContainer.style.display = isPersonal ? 'none' : 'block';

    const header = document.querySelector('#screen-career-stats .header-center');
    if (header) header.textContent = isPersonal ? 'My Career Stats' : 'All Players Stats';

    document.querySelectorAll('#screen-career-stats .ps-tab').forEach(t => t.classList.remove('active'));
    const tabBtn = $('tab-career-batting');
    if (tabBtn) tabBtn.classList.add('active');

    console.log("Calling renderCareerStatsBody...");
    renderCareerStatsBody();
    console.log("Calling showScreen...");
    showScreen('screen-career-stats');
  } catch (e) {
    console.error("Error in showCareerStats:", e);
    alert("Error loading stats: " + e.message);
  }
}

function hideCareerStats() {
  showScreen('screen-setup');
}

function switchCareerTab(tab) {
  careerTab = tab;
  document.querySelectorAll('#screen-career-stats .ps-tab').forEach(t => t.classList.remove('active'));
  $(`tab-career-${tab}`).classList.add('active');
  renderCareerStatsBody();
}

function aggregateCareerStats() {
  const history = loadHistory();
  const players = {}; // map of normalizedName -> stats

  history.forEach(match => {
    const matchParticipants = new Set();

    match.innings.forEach((inn, idx) => {
      // Batting Stats
      Object.values(inn.batters || {}).forEach(b => {
        const normName = b.name.trim().toLowerCase();
        if (!players[normName]) players[normName] = initCareerPlayer(b.name.trim());
        const p = players[normName];
        
        if (!matchParticipants.has(normName)) {
          p.matches++;
          matchParticipants.add(normName);
        }

        p.bat.innings++;
        if (!b.isOut) p.bat.notOuts++;
        p.bat.runs += b.runs;
        p.bat.balls += b.balls;
        p.bat.fours += b.fours;
        p.bat.sixes += b.sixes;
        if (b.runs > p.bat.highScore) {
          p.bat.highScore = b.runs;
          p.bat.hsNotOut = !b.isOut;
        }
        if (b.runs >= 50 && b.runs < 100) p.bat.fifties++;
        if (b.runs >= 100) p.bat.hundreds++;
      });

      // Bowling Stats
      Object.values(inn.bowlers || {}).forEach(bw => {
        if (bw.balls > 0) {
          const normName = bw.name.trim().toLowerCase();
          if (!players[normName]) players[normName] = initCareerPlayer(bw.name.trim());
          const p = players[normName];
          
          if (!matchParticipants.has(normName)) {
            p.matches++;
            matchParticipants.add(normName);
          }

          p.bowl.innings++;
          p.bowl.balls += bw.balls;
          p.bowl.runs += bw.runs;
          p.bowl.wickets += bw.wickets;
          p.bowl.maidens += bw.maidens;
          
          // Best bowling
          if (bw.wickets > p.bowl.bestWickets || (bw.wickets === p.bowl.bestWickets && bw.runs < p.bowl.bestRuns)) {
            p.bowl.bestWickets = bw.wickets;
            p.bowl.bestRuns = bw.runs;
          }
        }
      });

      // Fielding Stats (from Ball Log)
      if (inn.ballLog && Array.isArray(inn.ballLog)) {
        inn.ballLog.forEach(ball => {
          if (ball.isWicket && ball.fielder) {
            const fName = ball.fielder.trim();
            const normName = fName.toLowerCase();
            if (!players[normName]) players[normName] = initCareerPlayer(fName);
            const p = players[normName];
            
            if (!matchParticipants.has(normName)) {
              p.matches++;
              matchParticipants.add(normName);
            }

            if (ball.wicketType === 'Caught') p.field.catches++;
            else if (ball.wicketType === 'Run Out') p.field.runOuts++;
            else if (ball.wicketType === 'Stumped') p.field.stumpings++;
            p.field.total++;
          }
        });
      }
    });
  });

  return Object.values(players);
}

function initCareerPlayer(name) {
  return {
    name: name,
    matches: 0,
    bat: { innings: 0, notOuts: 0, runs: 0, balls: 0, fours: 0, sixes: 0, highScore: 0, hsNotOut: false, fifties: 0, hundreds: 0 },
    bowl: { innings: 0, balls: 0, runs: 0, wickets: 0, maidens: 0, bestWickets: 0, bestRuns: Infinity },
    field: { catches: 0, runOuts: 0, stumpings: 0, total: 0 }
  };
}

function renderCareerStatsBody() {
  try {
    const body = $('career-stats-body');
    if (!body) { console.error("career-stats-body not found"); return; }
    
    const searchInput = $('career-search-input');
    const query = searchInput ? searchInput.value.toLowerCase() : '';
    
    console.log("Aggregating career stats...");
    let stats = aggregateCareerStats();
    console.log("Stats aggregated. Count:", stats.length);
    
    let profileHeaderHtml = '';
    if (_isPersonalStats) {
      const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
      const loginName = userData.phone || "";
      const profile = userData.profile || {};
      
            if (profile.matchName || profile.battingHand || profile.bowlingType) {
        const displayName = profile.matchName || loginName;
        profileHeaderHtml = `
          <div style="background: rgba(0, 212, 106, 0.1); border: 1px solid rgba(0, 212, 106, 0.2); border-radius: 12px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; display: flex; align-items: center; gap: 12px;">
            <div style="width: 36px; height: 36px; background: var(--clr-green); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.9rem;">${displayName.charAt(0).toUpperCase()}</div>
            <div style="flex: 1;">
              <div style="font-weight: 700; font-size: 0.95rem; color: var(--clr-text);">${displayName.charAt(0).toUpperCase() + displayName.slice(1)}</div>
              <div style="display: flex; gap: 10px; font-size: 0.75rem; color: var(--clr-text-secondary); margin-top: 2px;">
                <span>🏏 ${profile.battingHand || 'Batting Hand'}</span>
                <span>🎯 ${profile.bowlingType || 'Bowling Type'}</span>
              </div>
            </div>
          </div>
          <div class="section-label" style="margin-bottom: 0.75rem; font-size: 0.8rem; opacity: 0.7;">Career Statistics</div>
        `;
      }
    }

    if (_isPersonalStats) {
      const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
      const loginName = userData.phone || "";
      const profile = userData.profile || {};
      const searchName = (profile.matchName || loginName).trim().toLowerCase();
      if (searchName) {
        stats = stats.filter(p => p.name.toLowerCase() === searchName);
      } else {
        stats = [];
      }
    } else if (query) {
      stats = stats.filter(p => p.name.toLowerCase().includes(query));
    }

    if (stats.length === 0) {
      body.innerHTML = profileHeaderHtml + `<div class="ps-empty"><div style="font-size:3rem; margin-bottom:1rem;">🔍</div><div class="ps-empty-title">No Players Found</div><div class="ps-empty-sub">Try a different search term.</div></div>`;
      return;
    }

    let html = profileHeaderHtml + '<div class="ps-cards-grid">';
    if (careerTab === 'batting') {
      stats.sort((a, b) => b.bat.runs - a.bat.runs);
      stats.forEach(p => {
        if (p.bat.innings === 0) return;
        const avg = (p.bat.innings - p.bat.notOuts) > 0 ? (p.bat.runs / (p.bat.innings - p.bat.notOuts)).toFixed(1) : (p.bat.runs > 0 ? '∞' : '0.0');
        const sr = p.bat.balls > 0 ? ((p.bat.runs / p.bat.balls) * 100).toFixed(1) : '0.0';
        const hsStr = `${p.bat.highScore}${p.bat.hsNotOut ? '*' : ''}`;
        html += `
        <div class="ps-card">
          <div class="ps-card-header">
            <div class="ps-avatar">${p.name.charAt(0).toUpperCase()}</div>
            <div class="ps-card-info">
              <div class="ps-player-name">${p.name}</div>
              <div class="ps-player-team">${p.matches} Matches</div>
            </div>
            <div class="ps-card-hs">
              <div class="ps-hs-runs highlighted">${p.bat.runs}</div>
              <div class="ps-hs-label">Runs</div>
            </div>
          </div>
          <div class="ps-stats-row">
            <div class="ps-stat-box"><div class="ps-stat-lbl">Inn</div><div class="ps-stat-val">${p.bat.innings}</div></div>
            <div class="ps-stat-box"><div class="ps-stat-lbl">Avg</div><div class="ps-stat-val">${avg}</div></div>
            <div class="ps-stat-box"><div class="ps-stat-lbl">SR</div><div class="ps-stat-val">${sr}</div></div>
          </div>
        </div>`;
      });
    } else if (careerTab === 'bowling') {
      stats.sort((a, b) => b.bowl.wickets - a.bowl.wickets);
      stats.forEach(p => {
        if (p.bowl.innings === 0) return;
        const overs = p.bowl.balls > 0 ? `${Math.floor(p.bowl.balls/6)}.${p.bowl.balls%6}` : '0.0';
        const eco = p.bowl.balls > 0 ? (p.bowl.runs / (p.bowl.balls / 6)).toFixed(2) : '0.00';
        const avg = p.bowl.wickets > 0 ? (p.bowl.runs / p.bowl.wickets).toFixed(1) : '—';
        const best = p.bowl.bestRuns === Infinity ? '—' : `${p.bowl.bestWickets}/${p.bowl.bestRuns}`;
        html += `
        <div class="ps-card">
          <div class="ps-card-header">
            <div class="ps-avatar ps-avatar-bowl">${p.name.charAt(0).toUpperCase()}</div>
            <div class="ps-card-info">
              <div class="ps-player-name">${p.name}</div>
              <div class="ps-player-team">${p.matches} Matches</div>
            </div>
            <div class="ps-card-hs">
              <div class="ps-hs-runs highlighted">${p.bowl.wickets}</div>
              <div class="ps-hs-label">Wkts</div>
            </div>
          </div>
          <div class="ps-stats-row">
            <div class="ps-stat-box"><div class="ps-stat-lbl">Inn</div><div class="ps-stat-val">${p.bowl.innings}</div></div>
            <div class="ps-stat-box"><div class="ps-stat-lbl">Overs</div><div class="ps-stat-val">${overs}</div></div>
            <div class="ps-stat-box"><div class="ps-stat-lbl">Eco</div><div class="ps-stat-val">${eco}</div></div>
          </div>
        </div>`;
      });
    } else {
      // Fielding
      stats.sort((a, b) => b.field.total - a.field.total);
      stats.forEach(p => {
        if (p.field.total === 0) return;
        html += `
        <div class="ps-card">
          <div class="ps-card-header">
            <div class="ps-avatar" style="background: var(--clr-blue);">${p.name.charAt(0).toUpperCase()}</div>
            <div class="ps-card-info">
              <div class="ps-player-name">${p.name}</div>
              <div class="ps-player-team">${p.matches} Matches</div>
            </div>
            <div class="ps-card-hs">
              <div class="ps-hs-runs highlighted" style="color: var(--clr-blue);">${p.field.total}</div>
              <div class="ps-hs-label">Dismissals</div>
            </div>
          </div>
          <div class="ps-stats-row">
            <div class="ps-stat-box"><div class="ps-stat-lbl">Catches</div><div class="ps-stat-val">${p.field.catches}</div></div>
            <div class="ps-stat-box"><div class="ps-stat-lbl">Run Outs</div><div class="ps-stat-val">${p.field.runOuts}</div></div>
            <div class="ps-stat-box"><div class="ps-stat-lbl">Stumpings</div><div class="ps-stat-val">${p.field.stumpings}</div></div>
          </div>
        </div>`;
      });
    }
    html += '</div>';
    body.innerHTML = html;
  } catch (e) {
    console.error("Error in renderCareerStatsBody:", e);
    alert("Error rendering stats: " + e.message);
  }
}

// =====================================================================
// ==================  REAL-TIME SYNC (Socket.io)  ====================
// =====================================================================

function initRealtime() {
  if (typeof io === 'undefined') return;
  _socket = io();

  // Receive state update from server (viewer side)
  _socket.on('state-sync', (state) => {
    match = state;
    applyPhaseToScreen();
  });

  // Host disconnected — notify viewers
  _socket.on('host-disconnected', () => {
    toast('⚠️ Scorer disconnected');
    const lb = $('live-badge');
    if (lb) { lb.textContent = '⚠️ Offline'; lb.style.background = 'rgba(239,68,68,.2)'; }
  });

  // Update viewer count badge (host only)
  _socket.on('viewer-count', (count) => {
    const badge = $('viewer-count-badge');
    if (badge) badge.textContent = `👁 ${count}`;
  });

  // Receive commentary state
  _socket.on('commentary-state', (isLive) => {
    const btn = $('btn-listen');
    const btnSc = $('btn-listen-scorecard');
    if (isLive) {
      if (btn) btn.style.display = 'inline-flex';
      if (btnSc) btnSc.style.display = 'inline-flex';
      toast('🎙️ Live Commentary is now available!');
    } else {
      if (btn) btn.style.display = 'none';
      if (btnSc) btnSc.style.display = 'none';
      if (typeof isListening !== 'undefined' && isListening) toggleListening();
    }
  });
}

// Host: create a room on the server when match starts
function hostMatch() {
  if (!_socket) return;
  _socket.emit('host-match', ({ code }) => {
    _roomCode = code;
    // Update the small pill in header
    const pill = $('room-code-pill');
    if (pill) { $('room-code-text').textContent = code; pill.style.display = 'flex'; }
    // Show the big share modal automatically
    showShareModal(code);
  });
}

// Show the prominent Share Code modal
function showShareModal(code) {
  $('share-code-display').textContent = code;
  $('modal-share').style.display = 'flex';
}
function hideShareModal() { $('modal-share').style.display = 'none'; }

function copyShareCode() {
  const code = _roomCode;
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    $('copy-share-btn').textContent = '✅ Copied!';
    setTimeout(() => { $('copy-share-btn').textContent = '📋 Copy Code'; }, 2000);
  });
}

function shareViaWhatsApp() {
  const url = window.location.origin;
  const msg = `Join my live cricket match! 🏏\nMatch Code: *${_roomCode}*\nOpen the app: ${url}\nClick "Join Live Match" and enter the code.`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}


// Host: push current match state to all viewers
// Host: push current match state to all viewers and save locally
function syncState() {
  saveMatchState(); // Persist locally for page refreshes
  if (!_socket || !_roomCode || _isViewer) return;
  _socket.emit('push-state', { code: _roomCode, state: JSON.parse(JSON.stringify(match)) });
}

function saveMatchState() {
  if (match && (match.phase === 'scoring' || match.phase === 'setup')) {
    localStorage.setItem('cricscore_active_match', JSON.stringify(match));
  }
}

function clearMatchState() {
  localStorage.removeItem('cricscore_active_match');
}

// Viewer: join using a code
function joinMatch() {
  const code = $('join-code-input').value.trim().toUpperCase();
  $('join-error').textContent = '';
  if (code.length < 6) { $('join-error').textContent = 'Enter a 6-character code.'; return; }

  _socket.emit('join-match', { code }, ({ error, ok, state }) => {
    if (error) { $('join-error').textContent = error; return; }
    _roomCode = code;
    _isViewer = true;
    hideJoinModal();
    setViewerMode(true);
    if (state) { match = state; applyPhaseToScreen(); }
    else { toast('Joined! Waiting for match to start...'); }
  });
}

// Apply the correct screen based on match.phase (for viewers receiving state)
function applyPhaseToScreen() {
  const phase = match.phase || 'setup';

  if (phase === 'innings-select') {
    const battingTeamIdx = match.battingFirst;
    const bowlingTeamIdx = battingTeamIdx === 1 ? 2 : 1;
    const battingTeam = battingTeamIdx === 1 ? match.team1 : match.team2;
    $('innings-setup-title').textContent = 'Choose Opening Batters & Bowler';
    $('innings-setup-subtitle').textContent = `1st Innings — ${battingTeam.name} batting`;
    showScreen('screen-innings-setup');

  } else if (phase === 'scoring') {
    $('header-match-title').textContent = `${match.team1.name} vs ${match.team2.name}`;
    showScreen('screen-scoring');
    renderScoring();

  } else if (phase === 'bowler-select') {
    const inn = match.innings[match.currentInnings - 1];
    if (inn) {
      $('over-complete-subtitle').textContent =
        `Over ${Math.floor(inn.balls / 6)} complete — ${inn.runs}/${inn.wickets}`;
    }
    showScreen('screen-new-bowler');

  } else if (phase === 'result') {
    // Re-render result screen from existing match state
    const inn1 = match.innings[0], inn2 = match.innings[1];
    if (!inn1 || !inn2) return;
    const isTie = inn1.runs === inn2.runs;
    $('result-trophy-emoji').textContent = isTie ? '🤝' : '🏆';
    $('result-winner').textContent = match.result || '';
    const inn1won = inn1.runs > inn2.runs;
    const inn2won = inn2.runs > inn1.runs;
    $('result-cards').innerHTML = `
      <div class="result-summary-card ${inn1won ? 'result-card-winner' : ''}">
        <div class="result-team-name">${inn1.battingTeamName}</div>
        <div class="result-team-score">${inn1.runs}/${inn1.wickets} <small>(${oversString(inn1.balls)} ov)</small></div>
      </div>
      <div class="result-vs-sep">vs</div>
      <div class="result-summary-card ${inn2won ? 'result-card-winner' : ''}">
        <div class="result-team-name">${inn2.battingTeamName}</div>
        <div class="result-team-score">${inn2.runs}/${inn2.wickets} <small>(${oversString(inn2.balls)} ov)</small></div>
      </div>`;
    $('result-scorecard-wrap').innerHTML = buildResultMiniScorecard(inn1, inn2);
    showScreen('screen-result');
    setTimeout(() => displayAwards(), 50);
  }
}

// Disable all scoring controls for viewers
function setViewerMode(enabled) {
  _isViewer = enabled;
  if (!enabled) return;
  // Show live badge
  const lb = $('live-badge');
  if (lb) lb.style.display = 'flex';
  // Disable all interactive scoring buttons
  const selectors = [
    '.run-btn', '.extra-btn', '.wicket-btn',
    '#btn-undo', '#btn-start-match',
    '#btn-player-stats'
  ];
  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    });
  });
}

// ── UI helpers ──
function showJoinModal() {
  $('join-code-input').value = '';
  $('join-error').textContent = '';
  $('modal-join').style.display = 'flex';
  setTimeout(() => $('join-code-input').focus(), 100);
}
function hideJoinModal() { $('modal-join').style.display = 'none'; }

function copyRoomCode() {
  if (!_roomCode) return;
  navigator.clipboard.writeText(_roomCode).then(() => toast(`Code ${_roomCode} copied!`));
}

// ── Kick off socket connection and UI when DOM is ready ──
document.addEventListener('DOMContentLoaded', () => {
  try {
    initRealtime();
  } catch(e) { console.error("Realtime init failed", e); }
  
  try {
    renderLeaderboard(); 
  } catch(e) { console.error("Leaderboard render failed", e); }
  
  try {
    initAuth(); 
  } catch(e) { console.error("Auth init failed", e); }
});

// =====================================================
// SIDEBAR DRAWER
// =====================================================
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebar-backdrop').classList.add('open');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-backdrop').classList.remove('open');
}

// Bottom nav active state
function updateNav(el) {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  el.classList.add('active');
}

// Share the app itself (not match code)
function shareApp() {
  const url = window.location.origin;
  const msg = `🏏 Check out CricScore - Free Ball-by-Ball Cricket Scorer!\n${url}`;
  if (navigator.share) {
    navigator.share({ title: 'CricScore', text: msg, url }).catch(() => {});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  }
}

// =====================================================
// LEADERBOARD
// =====================================================
let _lbTab = 'bat';

async function showLeaderboard() {
  if (!isLoggedIn()) {
    toast("Please login to view statistics");
    showScreen('screen-login');
    return;
  }
  await fetchGlobalHistory();
  showScreen('screen-leaderboard');
  _lbTab = 'bat';
  $('lb-tab-bat').classList.add('active');
  $('lb-tab-bowl').classList.remove('active');
  renderLeaderboard();
}

function switchLbTab(tab) {
  _lbTab = tab;
  $('lb-tab-bat').classList.toggle('active', tab === 'bat');
  $('lb-tab-bowl').classList.toggle('active', tab === 'bowl');
  renderLeaderboard();
}

function renderLeaderboard() {
  const body = $('leaderboard-body');
  const podium = $('leaderboard-podium');
  const history = loadHistory();

  if (!history.length) {
    podium.innerHTML = '';
    body.innerHTML = `<div class="ps-empty" style="margin-top:3rem;">
      <div style="font-size:3rem;">🏆</div>
      <div class="ps-empty-title">No Data Yet</div>
      <div class="ps-empty-sub">Play some matches to see leaderboards!</div>
    </div>`;
    return;
  }

  // Use aggregateCareerStats for consistent and correct aggregation
  const allStats = aggregateCareerStats();
  let rows = [];

  if (_lbTab === 'bat') {
    // Filter and map to the format expected by the leaderboard UI
    rows = allStats
      .filter(p => p.bat.innings > 0)
      .map(p => ({
        name: p.name,
        score: p.bat.runs,
        matches: p.matches,
        subLabel: 'runs'
      }))
      .sort((a, b) => b.score - a.score);
  } else {
    rows = allStats
      .filter(p => p.bowl.innings > 0)
      .map(p => ({
        name: p.name,
        score: p.bowl.wickets,
        matches: p.matches,
        subLabel: 'wickets'
      }))
      .sort((a, b) => b.score - a.score);
  }

  if (!rows.length) {
    podium.innerHTML = '';
    body.innerHTML = `<div class="ps-empty" style="margin-top:3rem;"><div>No data yet</div></div>`;
    return;
  }

  updateDashboardStats();

  // Populate Podium (Top 3)
  const top3 = rows.slice(0, 3);
  const remaining = rows.slice(3, 20);

  // Reorder for visual podium: [2, 1, 3]
  const visualOrder = [];
  if (top3[1]) visualOrder.push({ ...top3[1], rank: 2 });
  if (top3[0]) visualOrder.push({ ...top3[0], rank: 1 });
  if (top3[2]) visualOrder.push({ ...top3[2], rank: 3 });

  podium.innerHTML = visualOrder.map(p => `
    <div class="podium-item podium-item-${p.rank}">
      <div class="podium-rank">${p.rank === 1 ? '1st' : p.rank === 2 ? '2nd' : '3rd'}</div>
      <div class="podium-avatar">${p.rank === 1 ? '🥇' : '👤'}</div>
      <div class="podium-bar">
        <div class="podium-name" style="text-overflow:ellipsis; overflow:hidden; white-space:nowrap; width:100%;">${p.name}</div>
        <div class="podium-score">${p.score}</div>
        <div style="font-size:0.6rem;opacity:0.7;">${p.subLabel}</div>
      </div>
    </div>
  `).join('');

  // Populate Remaining List
  body.innerHTML = remaining.map((p, i) => `
    <div class="lb-row">
      <div class="lb-rank">${i + 4}</div>
      <div class="lb-name-wrap" style="flex:1;min-width:0;">
        <div class="lb-name">${p.name}</div>
        <div class="lb-team">${p.matches} Matches</div>
      </div>
      <div class="lb-stat">
        ${p.score}<br>
        <span class="lb-stat-label">${p.subLabel}</span>
      </div>
    </div>`).join('');
}

// ===== PANEL TABS (Scoring vs Commentary) =====
function switchPanelTab(tab, btn) {
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  document.querySelectorAll(".scoring-tab").forEach(t => t.classList.remove("active"));
  
  document.getElementById("tab-" + tab).classList.add("active");
  btn.classList.add("active");
  
  if (tab === "commentary") renderCommentary();
}

function renderCommentary() {
  const inn = getInnings();
  const feed = document.getElementById("commentary-feed");
  if (!inn || !feed) return;
  
  if (inn.ballLog.length === 0) {
    feed.innerHTML = "<div class='ps-empty'>No balls bowled yet</div>";
    return;
  }
  
  // Render in reverse (latest first)
  const balls = [...inn.ballLog].reverse();
  feed.innerHTML = balls.map((ball, idx) => {
    let tag = "";
    if (ball.isWicket) tag = "<span class='comm-tag tag-wicket'>Wicket</span>";
    else if (ball.runs === 4) tag = "<span class='comm-tag tag-four'>Boundary 4</span>";
    else if (ball.runs === 6) tag = "<span class='comm-tag tag-six'>Maximum 6</span>";
    
    let text = ball.isWicket ? "OUT! " + ball.outBatsman + " " + ball.dismissal : 
               ball.striker + " scores " + ball.runs + " runs off " + ball.bowler;
    if (ball.type === "extra") text = ball.extraType.toUpperCase() + "! " + ball.extras + " extra runs";

    // Use total balls to derive over number
    const overNum = Math.floor((inn.ballLog.length - idx - 1) / 6);
    const ballNum = (inn.ballLog.length - idx - 1) % 6;

    return `
      <div class="comm-item">
        <div class="comm-over">${overNum}.${ballNum}</div>
        <div class="comm-content">
          ${tag}
          <div class="comm-text">${text}</div>
        </div>
      </div>
    `;
  }).join("");
}

// ===== SHARE MATCH RESULT =====
function shareMatchResult() {
  if (!match || !match.innings || !match.innings[0]) {
    toast("No match data to share!");
    return;
  }

  const inn1 = match.innings[0];
  const inn2 = match.innings[1];
  
  let msg = "🏏 *CricScore Match Result* 🏏\n\n";
  msg += `*${inn1.battingTeamName}*: ${inn1.runs}/${inn1.wickets} (${oversString(inn1.balls)})\n`;
  if (inn2 && inn2.balls > 0) {
    msg += `*${inn2.battingTeamName}*: ${inn2.runs}/${inn2.wickets} (${oversString(inn2.balls)})\n\n`;
  }
  
  msg += `🏆 *${match.result || "Match Completed"}*\n\n`;
  msg += "Scored on CricScore app.";
  
  if (navigator.share) {
    navigator.share({
      title: "Match Result",
      text: msg
    }).then(() => {
      toast("Shared successfully!");
    }).catch((err) => {
      if (err.name !== "AbortError") {
        copyToClipboard(msg);
      }
    });
  } else {
    copyToClipboard(msg);
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      toast("📋 Result copied to clipboard!");
    }).catch(() => {
      toast("Failed to copy result.");
    });
  } else {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
      toast("📋 Result copied to clipboard!");
    } catch (err) {
      toast("Failed to copy result.");
    }
    document.body.removeChild(textArea);
  }
}

function downloadPDFScorecard() {
  if (!match || !match.innings || !match.innings[0]) {
    toast("No match data to export!");
    return;
  }

  toast("Generating PDF scorecard...");

  let html = `
    <div style="padding: 40px; background: #fff; color: #000; font-family: Arial, sans-serif; width: 750px;">
      <div style="text-align: center; border-bottom: 2px solid #00D46A; padding-bottom: 20px; margin-bottom: 30px;">
        <h1 style="margin: 0; color: #00D46A; font-size: 28px;">CRICSCORE</h1>
        <p style="margin: 5px 0; color: #666; font-size: 14px;">Official Match Scorecard</p>
        <h2 style="margin: 15px 0 5px; font-size: 20px;">${match.team1.name} vs ${match.team2.name}</h2>
        <p style="margin: 0; font-weight: bold; color: #e11d48;">${match.result || 'Match Completed'}</p>
      </div>
  `;

  for (let idx = 0; idx < 2; idx++) {
    const inn = match.innings[idx];
    if (!inn) continue;

    html += `
      <div style="margin-bottom: 40px; page-break-inside: avoid;">
        <div style="background: #f4f4f5; padding: 10px 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <span style="font-size: 18px; font-weight: 800;">${inn.battingTeamName}</span>
          <span style="font-size: 18px; font-weight: 800; color: #00D46A;">${inn.runs}/${inn.wickets} (${oversString(inn.balls)} ov)</span>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
          <thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0;">
            <tr>
              <th style="text-align: left; padding: 10px;">Batter</th>
              <th style="text-align: left; padding: 10px;">Dismissal</th>
              <th style="text-align: center; padding: 10px;">R</th>
              <th style="text-align: center; padding: 10px;">B</th>
              <th style="text-align: center; padding: 10px;">4s</th>
              <th style="text-align: center; padding: 10px;">6s</th>
              <th style="text-align: center; padding: 10px;">SR</th>
            </tr>
          </thead>
          <tbody>
    `;

    inn.battedList.forEach(name => {
      const b = inn.batters[name];
      if (!b) return;
      const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
      const dis = b.isOut ? b.dismissal : (inn.isComplete ? 'not out' : 'batting');
      html += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; font-weight: bold;">${b.name}</td>
          <td style="padding: 10px; color: #64748b; font-style: italic;">${dis}</td>
          <td style="padding: 10px; text-align: center; font-weight: bold;">${b.runs}</td>
          <td style="padding: 10px; text-align: center;">${b.balls}</td>
          <td style="padding: 10px; text-align: center;">${b.fours}</td>
          <td style="padding: 10px; text-align: center;">${b.sixes}</td>
          <td style="padding: 10px; text-align: center;">${sr}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>

        <div style="font-size: 12px; margin-bottom: 20px; color: #475569;">
          <strong>Extras:</strong> ${inn.totalExtras} (Wd ${inn.extras.wide}, NB ${inn.extras.noBall}, B ${inn.extras.bye}, LB ${inn.extras.legBye})
        </div>

        <h3 style="font-size: 16px; margin-bottom: 10px; border-left: 4px solid #00D46A; padding-left: 10px;">Bowling</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
          <thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0;">
            <tr>
              <th style="text-align: left; padding: 10px;">Bowler</th>
              <th style="text-align: center; padding: 10px;">O</th>
              <th style="text-align: center; padding: 10px;">M</th>
              <th style="text-align: center; padding: 10px;">R</th>
              <th style="text-align: center; padding: 10px;">W</th>
              <th style="text-align: center; padding: 10px;">Eco</th>
            </tr>
          </thead>
          <tbody>
    `;

    Object.values(inn.bowlers).forEach(bw => {
      const eco = bw.balls > 0 ? (bw.runs / (bw.balls / 6)).toFixed(2) : '0.00';
      html += `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; font-weight: bold;">${bw.name}</td>
          <td style="padding: 10px; text-align: center;">${oversString(bw.balls)}</td>
          <td style="padding: 10px; text-align: center;">${bw.maidens}</td>
          <td style="padding: 10px; text-align: center; font-weight: bold;">${bw.runs}</td>
          <td style="padding: 10px; text-align: center; font-weight: bold; color: #00D46A;">${bw.wickets}</td>
          <td style="padding: 10px; text-align: center;">${eco}</td>
        </tr>
      `;
    });

    html += '</tbody></table></div>';
  }

  html += `
    <div style="text-align: center; margin-top: 50px; border-top: 1px solid #e2e8f0; padding-top: 20px; color: #94a3b8; font-size: 11px;">
      Generated by CricScore App - Digital Cricket Scoring Solution.
    </div>
    </div>
  `;

  const opt = {
    margin:       [10, 10],
    filename:     `${match.team1.name}_vs_${match.team2.name}_Scorecard.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true, logging: true, letterRendering: true },
    jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(html).save().then(() => {
    toast("✅ PDF Downloaded!");
  }).catch(err => {
    console.error("PDF Error:", err);
    toast("❌ Failed to generate PDF.");
  });
}

// ===== ADVANCED SETTINGS =====
function toggleAdvancedSettings() {
  const panel = document.getElementById("advanced-settings-panel");
  const arrow = document.getElementById("settings-arrow");
  
  if (!panel || !arrow) return;
  
  const isOpen = panel.style.display === "block";
  panel.style.display = isOpen ? "none" : "block";
  arrow.style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
}

// ===== MATCH ANALYSIS GRAPHS =====
function renderMatchGraphs() {
  const inn1 = match.innings[0];
  const inn2 = match.innings[1];
  const container = document.getElementById("match-analysis");
  if (!inn1 || !container) return;

  // Calculate runs per over
  const getRunsPerOver = (inn) => {
    const overs = [];
    for (let i = 0; i < match.totalOvers; i++) {
      const overBalls = inn.ballLog.filter(b => b.overNumber === (i + 1));
      const runs = overBalls.reduce((sum, b) => sum + (b.runs || 0) + (b.extras || 0), 0);
      overs.push(runs);
    }
    return overs;
  };

  const runs1 = getRunsPerOver(inn1);
  const runs2 = inn2 ? getRunsPerOver(inn2) : [];
  const maxRuns = Math.max(...runs1, ...runs2, 10); // at least scale to 10

  let html = `
    <div class="analysis-title">\u{1F4CA} Runs Per Over Comparison</div>
    <div class="graph-legend">
      <div class="legend-item"><span class="legend-color" style="background:var(--clr-green)"></span> ${inn1.battingTeamName}</div>
      ${inn2 ? `<div class="legend-item"><span class="legend-color" style="background:var(--clr-blue)"></span> ${inn2.battingTeamName}</div>` : ""}
    </div>
    <div class="graph-wrapper">
  `;

  for (let i = 0; i < match.totalOvers; i++) {
    const h1 = (runs1[i] / maxRuns) * 100;
    const h2 = inn2 ? (runs2[i] / maxRuns) * 100 : 0;
    
    html += `
      <div class="graph-column">
        <div class="bar-inn bar-inn1" style="height:${h1}%" title="Over ${i+1}: ${runs1[i]} runs"></div>
        ${inn2 ? `<div class="bar-inn bar-inn2" style="height:${h2}%" title="Over ${i+1}: ${runs2[i]} runs"></div>` : ""}
        <div class="over-label">${i+1}</div>
      </div>
    `;
  }

  html += `</div>`;
  container.innerHTML = html;
}

// ===== AUTHENTICATION LOGIC (Login & Register) =====
let authMode = "login"; // "login" or "register"

function toggleAuthMode() {
  authMode = authMode === "login" ? "register" : "login";
  
  const title = $("auth-title");
  const subtitle = $("auth-subtitle");
  const btn = $("btn-auth");
  const toggleText = $("toggle-text");
  
  if (authMode === "register") {
    title.textContent = "Create Account";
    subtitle.textContent = "Join the community of elite scorers.";
    btn.textContent = "Create Free Account";
    toggleText.innerHTML = `Already have an account? <a href="#" onclick="toggleAuthMode()">Login instead</a>`;
  } else {
    title.textContent = "Welcome to CricScore";
    subtitle.textContent = "Elevate your game with professional scoring.";
    btn.textContent = "Login to Account";
    toggleText.innerHTML = `Don't have an account? <a href="#" onclick="toggleAuthMode()">Register Now</a>`;
  }
  
  // Show/Hide specific fields based on mode
  document.querySelectorAll('.register-only').forEach(el => {
    el.style.display = (authMode === "register") ? (el.tagName === 'BUTTON' ? 'inline-block' : 'block') : 'none';
  });
}

async function requestOTP() {
  let phone = $("login-phone").value.trim();
  // Remove spaces, dashes, etc for validation and sending
  phone = phone.replace(/[\s\-\(\)]/g, '');

  if (!phone || phone.length < 10) {
    toast("Please enter a valid 10-digit mobile number.");
    return;
  }
  
  const btn = $("btn-send-otp");
  btn.disabled = true;
  btn.textContent = "Sending...";
  
  try {
    const response = await fetch('/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to send OTP');
    
    if (result.realSMS) {
      toast("SMS sent! Please check your phone for the 6-digit code.");
    } else {
      toast(`MOCK SMS: Your CricScore OTP is ${result.otp}`);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.textContent = "Send OTP";
    btn.disabled = false;
  }
}

async function handleAuth() {
  let phone = $("login-phone").value.trim();
  const password = $("login-pass").value.trim();
  const otp = $("login-otp").value.trim();
  
  // Normalize phone
  phone = phone.replace(/[\s\-\(\)]/g, '');

  if (!phone || !password) {
    toast("Mobile number and password are required");
    return;
  }
  
  if (authMode === "register") {
    if (!otp) {
      toast("OTP is required for registration");
      return;
    }
  }
  
  if (password.length < 6) {
    toast("Password must be at least 6 characters");
    return;
  }

  const btn = $("btn-auth");
  const originalText = btn.textContent;
  btn.textContent = authMode === "login" ? "Authenticating..." : "Creating Account...";
  btn.disabled = true;
  
  try {
    const endpoint = authMode === "register" ? '/api/register' : '/api/login';
    const payload = authMode === "register" ? { phone, password, otp } : { phone, password };
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Authentication failed');
    }

    if (authMode === "register") {
      toast("Account created successfully! Please login.");
      toggleAuthMode();
    } else {
      // Success Login
      localStorage.setItem('cricscore_user', JSON.stringify({ 
        phone: result.user.phone, 
        profile: result.user.profile,
        loggedIn: true 
      }));
      
      showScreen("screen-home");
      updateDashboardStats();
      renderLeaderboard();
      toast(`Welcome back, ${phone}!`);
    }
  } catch (err) {
    toast(err.message);
    console.error("Auth error:", err);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}


function showHome() {
  if (!isLoggedIn()) {
    showScreen('screen-login');
    return;
  }
  showScreen('screen-home');
  updateDashboardStats();
}

function handleSignOut() {
  localStorage.removeItem('cricscore_user');
  toast("Signed out successfully");
  // Reload the page to clear all in-memory states
  setTimeout(() => {
    window.location.reload();
  }, 500);
}

function showProfile() {
  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  if (!userData.phone) {
    toast("Please login first");
    showScreen('screen-login');
    return;
  }

  const phone = userData.phone;
  const name = phone;
  $('profile-display-name').textContent = userData.profile?.matchName || name;
  $('profile-display-phone').textContent = phone;

  // Use profile from synced user data
  const profile = userData.profile || {};
  $('profile-match-name').value = profile.matchName || name;
  if (profile.battingHand) $('profile-batting-hand').value = profile.battingHand;
  if (profile.bowlingType) $('profile-bowling-type').value = profile.bowlingType;

  // Update avatar previews
  updateAvatarUI(profile.avatar);

  showScreen('screen-profile');
}

function updateAvatarUI(avatarUrl) {
  const profilePreview = $('profile-avatar-preview');
  const sidebarPreview = $('sidebar-avatar-preview');
  
  if (avatarUrl) {
    const imgHtml = `<img src="${avatarUrl}" style="width:100%; height:100%; object-fit:cover;">`;
    if (profilePreview) profilePreview.innerHTML = imgHtml;
    if (sidebarPreview) sidebarPreview.innerHTML = imgHtml;
  } else {
    if (profilePreview) profilePreview.innerHTML = '?';
    if (sidebarPreview) sidebarPreview.innerHTML = '🏏';
  }
}

async function handleAvatarUpload(input) {
  const file = input.files[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    toast("Image too large. Max 10MB.");
    input.value = '';
    return;
  }

  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  const phone = userData.phone;
  if (!phone) return;

  const formData = new FormData();
  formData.append('avatar', file);
  formData.append('phone', phone);

  try {
    toast("Uploading photo...");
    const response = await fetch('/api/upload-avatar', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Upload failed');
    }

    const result = await response.json();
    
    // Update local data
    if (!userData.profile) userData.profile = {};
    userData.profile.avatar = result.avatarUrl;
    localStorage.setItem('cricscore_user', JSON.stringify(userData));
    
    // Update UI
    updateAvatarUI(result.avatarUrl);
    toast("Photo updated successfully!");
  } catch (err) {
    toast(err.message);
    console.error("Avatar upload error:", err);
  } finally {
    input.value = '';
  }
}

async function saveProfile() {
  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  const phone = userData.phone;
  if (!phone) return;

  const profile = {
    matchName: $('profile-match-name').value.trim(),
    battingHand: $('profile-batting-hand').value,
    bowlingType: $('profile-bowling-type').value
  };

  try {
    const response = await fetch('/api/update-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, profile })
    });

    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Failed to update profile');
    }

    // Update local storage
    userData.profile = profile;
    localStorage.setItem('cricscore_user', JSON.stringify(userData));
    
    toast("Profile updated successfully!");
    showHome();
  } catch (err) {
    toast(err.message);
    console.error("Profile update error:", err);
  }
}

/* ============================================================
   AUTOMATED VOICE COMMENTARY (TTS)
   ============================================================ */
let isAutoVoiceEnabled = true;

function toggleAutoVoice() {
  isAutoVoiceEnabled = !isAutoVoiceEnabled;
  const btn = $('btn-auto-voice');
  if (btn) {
    if (isAutoVoiceEnabled) {
      btn.classList.add('listen-active');
      btn.style.color = 'var(--clr-text2)';
      toast("Voice Commentary Enabled");
    } else {
      btn.classList.remove('listen-active');
      btn.style.color = '#ef4444'; // Red to indicate it's off
      toast("Voice Commentary Disabled");
      window.speechSynthesis.cancel(); // Stop any ongoing speech
    }
  }
}

function playVoiceCommentary(type) {
  if (!isAutoVoiceEnabled || !('speechSynthesis' in window)) return;
  
  let text = '';
  if (type === '4') text = "That's a Four!";
  else if (type === '6') text = "It's a huge Six!";
  else if (type === 'W') text = "Out! He is gone!";
  
  if (text) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.1;
    window.speechSynthesis.speak(utterance);
  }
}

/**
 * =====================================================
 * DLS CALCULATOR LOGIC
 * =====================================================
 */
function showDLS() {
  showScreen('screen-dls');
  // Reset form or use current match data if applicable
  const currentInn = match.innings[0];
  if (currentInn && currentInn.runs > 0) {
      $('dls-team1-score').value = currentInn.runs;
      $('dls-total-overs').value = match.totalOvers;
  }
  // Trigger initial calculation
  setTimeout(() => runDLS(), 100);
}

// Simplified DLS Resource Table (Standard Edition approx)
const DLS_RESOURCES = {
    50: [100.0, 93.4, 85.1, 74.9, 62.7, 49.0, 34.9, 22.0, 11.9, 4.7, 0],
    40: [89.3, 84.2, 77.6, 69.1, 58.9, 46.7, 34.1, 22.0, 11.9, 4.7, 0],
    30: [75.1, 71.8, 67.3, 61.2, 53.4, 43.4, 32.5, 21.6, 11.8, 4.7, 0],
    20: [56.6, 54.8, 52.1, 48.3, 43.1, 36.1, 28.1, 19.7, 11.3, 4.7, 0],
    10: [34.1, 33.4, 32.5, 30.8, 28.3, 24.8, 20.2, 15.0, 9.4, 4.3, 0],
    5:  [18.4, 18.2, 17.9, 17.4, 16.5, 15.0, 12.9, 10.3, 7.1, 3.5, 0],
    0:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
};

function getDLSResource(overs, wickets) {
    if (overs <= 0) return 0;
    if (wickets >= 10) return 0;
    const keys = Object.keys(DLS_RESOURCES).map(Number).sort((a,b) => b-a);
    let upper = keys[0];
    let lower = 0;
    for (let k of keys) {
        if (overs >= k) { upper = k; break; }
        lower = k;
    }
    if (upper === overs) return DLS_RESOURCES[upper][wickets];
    const upperVal = DLS_RESOURCES[upper][wickets];
    const lowerVal = DLS_RESOURCES[lower] ? DLS_RESOURCES[lower][wickets] : 0;
    const ratio = (overs - lower) / (upper - lower);
    return lowerVal + (ratio * (upperVal - lowerVal));
}

function runDLS() {
    const btn = $('btn-run-dls');
    if (btn) {
        const original = btn.innerHTML;
        if (!original.includes('Calculating')) {
            btn.innerHTML = "🔄 Calculating...";
            btn.style.opacity = '0.7';
            setTimeout(() => {
                btn.innerHTML = original;
                btn.style.opacity = '1';
            }, 300);
        }
    }

    // Use parseFloat to handle balls (e.g. 20.2 overs)
    const s1 = parseFloat($('dls-team1-score').value) || 0;
    const t1 = parseFloat($('dls-total-overs').value) || 50;
    const p2 = parseFloat($('dls-interrupted-overs').value) || 0;
    const w2 = parseInt($('dls-interrupted-wickets').value) || 0;
    const r2 = parseFloat($('dls-revised-overs').value) || t1;

    if (s1 <= 0 || t1 <= 0) {
        $('dls-par-score').textContent = '—';
        $('dls-target-score').textContent = '—';
        return;
    }

    const res1 = getDLSResource(t1, 0);
    const res2Current = getDLSResource(r2 - p2, w2);
    const res2Total = getDLSResource(r2, 0);

    if (res1 === 0) {
        $('dls-par-score').textContent = 'Error';
        $('dls-target-score').textContent = 'Error';
        return;
    }

    const resourcesUsedByTeam2 = Math.max(0, res2Total - res2Current);
    const parScore = Math.floor(s1 * (resourcesUsedByTeam2 / res1));
    const targetScore = Math.floor(s1 * (res2Total / res1)) + 1;

    $('dls-par-score').textContent = isNaN(parScore) ? '—' : parScore;
    $('dls-target-score').textContent = isNaN(targetScore) ? '—' : targetScore;
    $('dls-target-desc').textContent = `Target for ${r2} overs`;

    // Auto-scroll to results for better visibility
    const resultCard = $('dls-result-container');
    if (resultCard) {
        resultCard.style.display = 'flex'; // Ensure visible
        // Pulse effect
        resultCard.style.transition = 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        resultCard.style.transform = 'scale(1.05)';
        resultCard.style.background = 'rgba(0, 212, 106, 0.15)';
        setTimeout(() => {
            resultCard.style.transform = 'scale(1)';
            resultCard.style.background = 'rgba(255, 255, 255, 0.05)';
        }, 600);
    }
}

function applyDLS() {
    const targetVal = parseInt($('dls-target-score').textContent);
    const revisedOvers = parseFloat($('dls-revised-overs').value);

    if (isNaN(targetVal) || isNaN(revisedOvers)) {
        toast("Please calculate the target first!");
        return;
    }

    match.dlsTarget = targetVal;
    match.totalOvers = revisedOvers;

    toast(`DLS Applied: Target ${targetVal}, Overs ${revisedOvers}`);
    
    // Switch to scoring screen and re-render
    showScreen('screen-scoring');
    renderScoring();
    syncState();
}
