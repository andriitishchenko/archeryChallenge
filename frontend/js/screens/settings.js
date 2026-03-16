// =============================================
// ARROWMATCH — Settings Screen
// Profile form read/write.
// Depends on: core/state.js, core/api.js, core/utils.js
// =============================================

function refreshSettings() {
  if (!STATE.profile) return;
  const p = STATE.profile;
  if (p.name)   document.getElementById('s-name').value = p.name;
  if (p.gender) {
    document.querySelectorAll('input[name="gender"]').forEach(r => {
      r.checked = r.value === p.gender;
    });
  }
  if (p.age)     document.getElementById('s-age').value = p.age;
  if (p.bowType) {
    document.querySelectorAll('#bow-type-chips .chip').forEach(c => {
      c.classList.toggle('active', c.textContent.trim() === p.bowType);
    });
  }
  if (p.skillLevel) {
    document.querySelectorAll('#skill-level-chips .chip').forEach(c => {
      c.classList.toggle('active', c.textContent.trim() === p.skillLevel);
    });
  }
  if (p.country) document.getElementById('s-country').value = p.country;
  document.getElementById('display-user-id').textContent = STATE.userId || '—';
  updateSettingsAccountSection();
}

function updateSettingsAccountSection() {
  const isGuest = !STATE.user || STATE.user.isGuest;
  document.getElementById('account-section-guest').classList.toggle('hidden', !isGuest);
  document.getElementById('account-section-user').classList.toggle('hidden', isGuest);
  if (!isGuest && STATE.user?.email) {
    document.getElementById('acc-display-email').textContent = STATE.user.email;
  }
}

async function saveSettings() {
  const name      = document.getElementById('s-name').value.trim();
  const genderEl  = document.querySelector('input[name="gender"]:checked');
  const age       = document.getElementById('s-age').value;
  const bowChip   = document.querySelector('#bow-type-chips .chip.active');
  const skillChip = document.querySelector('#skill-level-chips .chip.active');
  const country   = document.getElementById('s-country').value;

  if (!name)      { showToast('Name is required', 'error'); return; }
  if (!genderEl)  { showToast('Select gender', 'error'); return; }
  if (!age)       { showToast('Select age range', 'error'); return; }
  if (!bowChip)   { showToast('Select bow type', 'error'); return; }
  if (!skillChip) { showToast('Select skill level', 'error'); return; }
  if (!country)   { showToast('Select country', 'error'); return; }

  const profile = {
    name,
    gender:     genderEl.value,
    age,
    bowType:    bowChip.textContent.trim(),
    skillLevel: skillChip.textContent.trim(),
    country,
  };

  STATE.profile = profile;
  localStorage.setItem('arrowmatch_profile', JSON.stringify(profile));

  try {
    await api('PUT', '/api/profile', {
      name:        profile.name,
      gender:      profile.gender,
      age:         profile.age,
      bow_type:    profile.bowType,
      skill_level: profile.skillLevel,
      country:     profile.country,
    });
    showToast('Profile saved!', 'success');
  } catch {
    showToast('Saved locally (offline — will sync later)', 'info');
  }

  showScene('list-challenge');
}

// selectChip is defined in screens/challenges.js (loaded after this file)
