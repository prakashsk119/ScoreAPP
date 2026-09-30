const fs = require('fs');

const appJsStr = fs.readFileSync('app.js', 'utf8');

const featureFuncs = [
  'showHistory', 'fetchGlobalHistory', 'renderHistoryScreen', 'toggleHistDetail', 'formatHistoryDate', 'showHistoryFromResult',
  'showProfile', 'refreshUserProfile', 'updateProfile', 'renderProfileUI', 'showCareerStats', 'fetchPlayerStats', 'renderCareerStats',
  'showTeams', 'renderTeamsList', 'fetchTeams', 'createTeam', 'showTeamDetail', 'updateTeam',
  'showTournaments', 'fetchTournaments', 'renderTournamentUI', 'createTournament', 'showTournamentDetail', 'updateTournament',
  'showLeaderboard', 'updateLeaderboardUI', 'fetchLeaderboard',
  'runDLS', 'applyDLS', 'showDLSModal'
];

let newAppJs = appJsStr;
let featuresJs = "// Features loaded dynamically\n\n";

for (const fn of featureFuncs) {
  const regex = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{`);
  const match = newAppJs.match(regex);
  if (match) {
    const start = match.index;
    let bracketCount = 0;
    let end = -1;
    let started = false;
    for (let i = start; i < newAppJs.length; i++) {
      if (newAppJs[i] === '{') {
        bracketCount++;
        started = true;
      } else if (newAppJs[i] === '}') {
        bracketCount--;
      }
      if (started && bracketCount === 0) {
        end = i + 1;
        break;
      }
    }
    
    if (end !== -1) {
      const funcBody = newAppJs.substring(start, end);
      featuresJs += funcBody + "\n\n";
      newAppJs = newAppJs.substring(0, start) + 
                 `async function ${fn}(...args) { await window.loadFeatures(); return _${fn}(...args); }` + 
                 newAppJs.substring(end);
                 
      featuresJs = featuresJs.replace(new RegExp(`(function\\s+)${fn}(\\s*\\()`), `$1_${fn}$2`);
    }
  }
}

const loaderScript = `
window._featuresLoaded = false;
window._featuresPromise = null;
window.loadFeatures = function() {
  if (window._featuresLoaded) return Promise.resolve();
  if (window._featuresPromise) return window._featuresPromise;
  window._featuresPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'features.min.js?v=1.0';
    s.onload = () => { window._featuresLoaded = true; resolve(); };
    s.onerror = reject;
    document.body.appendChild(s);
  });
  return window._featuresPromise;
};
`;

newAppJs = newAppJs + "\n" + loaderScript;

fs.writeFileSync('app.js', newAppJs);
fs.writeFileSync('features.js', featuresJs);

console.log('Successfully extracted feature functions.');
