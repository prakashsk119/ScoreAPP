// Features loaded dynamically

async function _showHistory() {
  if (!isLoggedIn()) {
    toast("Please login to view match history");
    showScreen('screen-login');
    return;
  }
  await _fetchGlobalHistory();
  _renderHistoryScreen();
  showScreen('screen-history');
}

async function _fetchGlobalHistory() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/matches`);
    if (res.ok) {
      const data = await res.json();
      globalMatchHistory = data.reverse(); // Newest first
    }
  } catch(e) {
    console.error("Failed to fetch global history:", e);
  }
}

function _renderHistoryScreen() {
  // Filter out tournament matches so they do not clutter the global match history
  const history = loadHistory().filter(m => !m.tournamentId);
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
    const inn1won = inn1.battingTeamName === (entry.result ? entry.result.split(' won')[0] : '');

    html += `
    <div class="hist-card" id="hist-card-${idx}">
      <!-- Summary row (always visible) -->
      <div class="hist-summary" onclick="toggleHistDetail(${idx})">
        <div class="hist-meta">
          <span class="hist-date">${dateStr}</span>
          <span class="hist-format">${entry.venue ? '📍 ' + entry.venue + ' · ' : ''}${entry.overs} Ov · ${entry.playersPerTeam}a-side</span>
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

function _toggleHistDetail(idx) {
  const detail = $(`hist-detail-${idx}`);
  const icon   = $(`hist-icon-${idx}`);
  const isOpen = detail.style.display !== 'none';
  detail.style.display = isOpen ? 'none' : 'block';
  icon.style.transform  = isOpen ? '' : 'rotate(180deg)';
}

function _showHistoryFromResult() {
  _renderHistoryScreen();
  showScreen('screen-history');
}

function _showProfile() {
  const userData = JSON.parse(localStorage.getItem('cricscore_user') || '{}');
  if (!userData.phone) {
    toast("Please login first");
    showScreen('screen-login');
    return;
  }

  const phone = userData.phone;
  const name = phone;
  
  if (phone && phone.startsWith("VismeUser")) {
    $('profile-display-name').textContent = userData.profile?.matchName || "Visme User";
    $('profile-display-phone').textContent = "";
  } else {
    $('profile-display-name').textContent = userData.profile?.matchName || name;
    $('profile-display-phone').textContent = phone;
  }

  // Use profile from synced user data
  const profile = userData.profile || {};
  $('profile-match-name').value = profile.matchName || ((phone && phone.startsWith("VismeUser")) ? "Visme User" : name);
  if (profile.battingHand) $('profile-batting-hand').value = profile.battingHand;
  if (profile.bowlingType) $('profile-bowling-type').value = profile.bowlingType;

  // Update avatar previews
  updateAvatarUI(profile.avatar);

  showScreen('screen-profile');
}

async function _refreshUserProfile(phone) {
  if (!phone) return;
  try {
    const response = await fetch(`${BACKEND_URL}/api/profile?phone=${encodeURIComponent(phone)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.profile) {
        const storedStr = localStorage.getItem('cricscore_user');
        if (storedStr) {
          const storedUser = JSON.parse(storedStr);
          let avatarUrl = data.profile.avatar;
          if (avatarUrl && avatarUrl.startsWith('/')) {
            avatarUrl = BACKEND_URL + avatarUrl;
          }
          storedUser.profile = { ...storedUser.profile, ...data.profile, avatar: avatarUrl || storedUser.profile?.avatar };
          localStorage.setItem('cricscore_user', JSON.stringify(storedUser));
          if (typeof updateSidebarUI === 'function') updateSidebarUI(storedUser);
          if (typeof updateAvatarUI === 'function') updateAvatarUI(storedUser.profile?.avatar);
        }
      }
    }
  } catch (e) {
    console.warn("Profile sync error:", e);
  }
}

async function _showCareerStats(isPersonal = false) {
  try {
    await _fetchGlobalHistory();
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

function _showTeams() {
  showScreen('screen-teams');
  _renderTeamsList();
}

function _renderTeamsList() {
  const container = $('teams-list-container');
  if (!container) return;

  const teams = loadTeams();
  if (teams.length === 0) {
    container.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-icon">🛡️</div>
        <h3>No Teams Created Yet</h3>
        <p>Create your team, add players, assign captain & roles!</p>
        <button class="btn-primary" onclick="openCreateTeamModal()">+ Create Team</button>
      </div>`;
    return;
  }

  let html = '';
  teams.forEach(t => {
    const id = t._id || t.id;
    const playerCount = t.players ? t.players.length : 0;
    const captain = t.captain ? `Cap: ${t.captain}` : 'No Captain';

    html += `
      <div class="team-card" onclick="showTeamDetail('${id}')">
        <div class="team-card-header">
          <div class="team-avatar">${t.name.charAt(0).toUpperCase()}</div>
          <div>
            <h3>${t.name}</h3>
            <p class="team-sub">${t.location || 'Local Team'} • ${playerCount} Players</p>
          </div>
        </div>
        <div class="team-card-meta">
          <span>👑 ${captain}</span>
        </div>
        <div class="team-card-actions">
          <button class="btn-primary-sm" onclick="event.stopPropagation(); openTeamRoster('${id}')">Manage Players</button>
        </div>
      </div>`;
  });
  container.innerHTML = html;
}

async function _fetchTeams() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/teams`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) saveTeamsLocally(data);
    }
  } catch (e) {
    console.warn("Teams fetch error:", e);
  }
}

function _showTeamDetail(teamId) {
  currentSelectedTeamId = teamId;
  const teams = loadTeams();
  const team = teams.find(t => (t._id === teamId || t.id === teamId));
  if (!team) {
    toast("Team not found");
    _showTeams();
    return;
  }

  $('team-detail-title').textContent = team.name;
  const teamActions = $('team-detail-actions');
  if (teamActions) {
    teamActions.innerHTML = isTeamOwner(team) ? `
      <button class="btn-primary-sm" onclick="openAddPlayerModal()">+ Add Player</button>
      <button class="btn-delete-team" onclick="confirmDeleteTeam('${team._id || team.id}')">Delete Team</button>` : '';
  }

  // Compute team stats
  const stats = calculateTeamStats(team.name);
  const heroCard = $('team-hero-card');
  if (heroCard) {
    heroCard.innerHTML = `
      <div class="hero-top">
        <div style="display:flex; align-items:center; gap:0.8rem;">
          <div class="team-avatar-lg">${team.name.charAt(0).toUpperCase()}</div>
          <div>
            <h2>${team.name}</h2>
            <p class="hero-sub">📍 ${team.location || 'Local Ground'} • ${team.players ? team.players.length : 0} Players</p>
          </div>
        </div>
      </div>
      <div class="hero-stats-row">
        <div class="hero-stat-pill">
          <span class="num">${stats.matches}</span>
          <span class="lbl">Matches</span>
        </div>
        <div class="hero-stat-pill">
          <span class="num">${stats.winPct}%</span>
          <span class="lbl">Win Rate</span>
        </div>
        <div class="hero-stat-pill">
          <span class="num">${stats.wins}W / ${stats.losses}L</span>
          <span class="lbl">Record</span>
        </div>
      </div>`;
  }

  showScreen('screen-team-detail');
  switchTeamTab('dashboard');
}

function _showTournaments() {
  showScreen('screen-tournaments');
  filterTournaments('all');
}

async function _fetchTournaments() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/tournaments`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        const localTnmts = (function() {
          try { return JSON.parse(localStorage.getItem('cricscore_tournaments') || '[]'); } catch(e) { return []; }
        })();
        const merged = mergeTournaments(data, localTnmts);
        const repaired = repairTournamentData(merged);
        saveTournamentsLocally(repaired);
        populateTournamentSelect();
      }
    }
  } catch (e) {
    console.warn("Tournaments fetch error:", e);
  }
}

function _showTournamentDetail(tnmtId) {
  currentSelectedTnmtId = tnmtId;
  const tnmts = loadTournaments();
  const tnmt = tnmts.find(t => (t._id === tnmtId || t.id === tnmtId));
  if (!tnmt) {
    toast("Tournament not found");
    _showTournaments();
    return;
  }

  $('tnmt-detail-title').textContent = tnmt.name;

  // Hero Card
  const matches = getTournamentMatches(tnmt);
  const heroCard = $('tnmt-hero-card');
  const effStatus = getEffectiveTournamentStatus(tnmt);
  if (heroCard) {
    heroCard.innerHTML = `
      <div class="hero-top">
        <div>
          <h2>${tnmt.name}</h2>
          <p class="hero-sub">📍 ${tnmt.location || 'Local Ground'} • ${tnmt.format || 'T20'} Format</p>
        </div>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <select class="form-input" style="width:auto; padding:0.25rem 0.6rem; font-size:0.75rem; font-weight:700; border-radius:20px; background:var(--clr-surface-elevated, #f8fafc); color:var(--clr-text); border:1px solid var(--clr-border, #e2e8f0); cursor:pointer;" onchange="setTournamentStatus('${tnmt._id || tnmt.id}', this.value)">
            <option value="Ongoing" ${effStatus === 'Ongoing' ? 'selected' : ''}>🟡 ONGOING</option>
            <option value="Upcoming" ${effStatus === 'Upcoming' ? 'selected' : ''}>🔵 UPCOMING</option>
            <option value="Completed" ${effStatus === 'Completed' ? 'selected' : ''}>🟢 COMPLETED</option>
          </select>
        </div>
      </div>
      <div class="hero-stats-row">
        <div class="hero-stat-pill">
          <span class="num">${matches.length}</span>
          <span class="lbl">Matches</span>
        </div>
        <div class="hero-stat-pill">
          <span class="num">${tnmt.numTeams || (tnmt.teams ? tnmt.teams.length : 0)}</span>
          <span class="lbl">Teams</span>
        </div>
        <div class="hero-stat-pill">
          <span class="num">${matches.reduce((sum, m) => sum + (m.innings ? m.innings.reduce((a, b) => a + (b ? b.runs : 0), 0) : 0), 0)}</span>
          <span class="lbl">Total Runs</span>
        </div>
      </div>`;
  }

  showScreen('screen-tournament-detail');
  switchTnmtTab('overview');
}

async function _showLeaderboard() {
  if (!isLoggedIn()) {
    toast("Please login to view statistics");
    showScreen('screen-login');
    return;
  }
  await _fetchGlobalHistory();
  showScreen('screen-leaderboard');
  _lbTab = 'bat';
  $('lb-tab-bat').classList.add('active');
  $('lb-tab-bowl').classList.remove('active');
  renderLeaderboard();
}

function _runDLS() {
    const resultCard = $('dls-result-container');
    const resultHeader = $('dls-results-header');
    if (resultCard) {
        resultCard.style.display = 'flex';
        if (resultHeader) resultHeader.style.display = 'block';
    }

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
    const t1 = parseFloat($('dls-total-overs').value) || 0;
    const p2 = parseFloat($('dls-interrupted-overs').value) || 0;
    const w2 = parseInt($('dls-interrupted-wickets').value) || 0;
    const r2 = parseFloat($('dls-revised-overs').value) || t1;

    if (s1 <= 0 || t1 <= 0 || r2 <= 0) {
        $('dls-par-score').textContent = '—';
        $('dls-target-score').textContent = '—';
        if (s1 > 0 && t1 > 0 && r2 <= 0) toast("Revised overs must be greater than 0");
        else toast("Please enter both Total Score and Overs Scheduled.");
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

    // Apply pulse effect
    if (resultCard) {
        resultCard.style.transition = 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        resultCard.style.transform = 'scale(1.05)';
        resultCard.style.background = 'rgba(0, 212, 106, 0.15)';
        setTimeout(() => {
            resultCard.style.transform = 'scale(1)';
            resultCard.style.background = 'rgba(255, 255, 255, 0.05)';
        }, 600);
    }
}

function _applyDLS() {
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







