// =============================================
// ARROWMATCH — Utilities
// Pure helpers with no side-effects on STATE.
// Depends on: core/state.js
// =============================================

function _generateLocalId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `AM-${ts}-${rand}`;
}

function _serverProfileToLocal(p) {
  return {
    name:       p.name,
    gender:     p.gender,
    age:        p.age,
    bowType:    p.bow_type,
    skillLevel: p.skill_level,
    country:    p.country,
  };
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className   = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity    = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
  } else {
    _fallbackCopy(text);
  }
}

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function getTimeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function loadCountries() {
  const countries = [
    'Afghanistan','Albania','Algeria','Argentina','Armenia','Australia','Austria','Azerbaijan',
    'Bangladesh','Belarus','Belgium','Bolivia','Brazil','Bulgaria','Canada','Chile','China',
    'Colombia','Croatia','Czech Republic','Denmark','Ecuador','Egypt','Estonia','Finland',
    'France','Georgia','Germany','Ghana','Greece','Hungary','India','Indonesia','Iran','Iraq',
    'Ireland','Israel','Italy','Japan','Jordan','Kazakhstan','Kenya','South Korea','Latvia',
    'Lebanon','Lithuania','Luxembourg','Malaysia','Mexico','Morocco','Netherlands',
    'New Zealand','Nigeria','Norway','Pakistan','Peru','Philippines','Poland','Portugal',
    'Romania','Russia','Saudi Arabia','Serbia','Singapore','Slovakia','Slovenia',
    'South Africa','Spain','Sri Lanka','Sweden','Switzerland','Taiwan','Turkey','Uganda',
    'Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan',
    'Venezuela','Vietnam',
  ];
  ['s-country', 'filter-country'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    countries.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      sel.appendChild(opt);
    });
  });
}
