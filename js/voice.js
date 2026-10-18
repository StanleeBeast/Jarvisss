// JARVIS Stimme: Auswahl der ElevenLabs-Stimmen (mit kostenloser Hörprobe), Qualität/Schnell und ehrliche
// Anzeige, welche Stimme tatsächlich gesprochen hat. Der ElevenLabs-Schlüssel liegt nur im Worker.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  const select = el('aiVoice');
  if (!select) return;
  let voices = [], fallbackNoted = false;

  const box = document.createElement('div');
  box.className = 'voice-extra';
  box.innerHTML = '<label class="hint">Sprechweise<select id="ttsMode"><option value="quality">Beste Qualität (ElevenLabs Multilingual v2)</option><option value="fast">Schnell &amp; günstiger (ElevenLabs Flash v2.5)</option></select></label>'
    + '<div class="voice-actions"><button type="button" id="voicePreview">Hörprobe (kostenlos)</button></div>'
    + '<p class="hint" id="voiceState">Stimmen werden geladen …</p>';
  select.closest('label')?.after(box);
  const mode = el('ttsMode');
  mode.value = data.profile.ttsMode || 'quality';
  mode.onchange = () => { data.profile.ttsMode = mode.value; saveData(); toast('Sprechweise gespeichert.'); };

  function option(v) {
    const o = document.createElement('option');
    o.value = v.id;
    const tags = v.labels ? [v.labels.language, v.labels.gender === 'male' ? 'männlich' : v.labels.gender === 'female' ? 'weiblich' : v.labels.gender, v.labels.accent, v.labels.description || v.labels.descriptive].filter(Boolean).slice(0, 3) : [];
    o.textContent = v.name + (tags.length ? ' · ' + tags.join(', ') : '');
    return o;
  }
  async function load() {
    if (typeof apiBase !== 'function' || !apiBase() || !hasCredentials()) { el('voiceState').textContent = 'Kein Backend verbunden – es spricht die Systemstimme des Geräts.'; return; }
    const res = await window.JarvisCore.api('/api/tts/voices');
    if (!res.ok) { el('voiceState').textContent = res.error === 'not_found' ? 'Der deployte Worker ist älter als diese Seite. Deploy-Workflow erneut ausführen.' : 'Stimmen nicht ladbar: ' + window.JarvisCore.errorText(res.error); return; }
    const b = res.body;
    voices = b.voices || [];
    const groups = [['elevenlabs', 'ElevenLabs'], ['openai', 'OpenAI (Rückfall)']];
    select.replaceChildren(...groups.map(([key, label]) => {
      const list = voices.filter(v => v.provider === key);
      if (!list.length) return null;
      const g = document.createElement('optgroup'); g.label = label;
      g.append(...list.map(option));
      return g;
    }).filter(Boolean));
    // Beim ersten Mal mit ElevenLabs die voreingestellte ElevenLabs-Stimme wählen.
    if (b.elevenlabs && !data.profile.voiceChosenEleven && !(data.profile.aiVoice || '').startsWith('el:')) {
      data.profile.aiVoice = b.defaultVoice; data.profile.voiceChosenEleven = true; saveData();
    }
    if (voices.some(v => v.id === data.profile.aiVoice)) select.value = data.profile.aiVoice;
    mode.closest('label').hidden = !b.elevenlabs;
    const current = voices.find(v => v.id === select.value);
    el('voiceState').textContent = b.error
      ? 'ElevenLabs antwortet gerade nicht (' + (b.error === 'tts_key_invalid' ? 'Schlüssel ungültig – Secret ELEVENLABS_API_KEY prüfen' : b.error) + '). Es spricht die OpenAI-Stimme.'
      : b.elevenlabs ? 'ElevenLabs ist verbunden. Aktuelle Stimme: ' + (current?.name || '–') + '. Eigene Stimmen aus deinem ElevenLabs-Konto erscheinen hier automatisch.'
        : 'ElevenLabs ist noch nicht eingerichtet (GitHub-Secret ELEVENLABS_API_KEY). Bis dahin spricht die OpenAI-Stimme.';
    updatePreview();
  }
  function updatePreview() {
    const v = voices.find(x => x.id === select.value);
    el('voicePreview').hidden = !v?.preview;
  }
  select.addEventListener('change', () => { data.profile.voiceChosenEleven = true; saveData(); updatePreview(); });
  el('voicePreview').addEventListener('click', () => {
    const v = voices.find(x => x.id === select.value);
    if (!v?.preview) return;
    const a = new Audio(v.preview);
    a.play().catch(() => toast('Hörprobe konnte nicht abgespielt werden.'));
  });

  window.JarvisVoice = {
    load,
    noteProvider(p) {
      window.JarvisVoice.lastProvider = p || null;
      if (p === 'openai-fallback' && !fallbackNoted) { fallbackNoted = true; toast('ElevenLabs hat nicht geantwortet – diesmal hat die OpenAI-Stimme gesprochen.'); }
    }
  };
  setTimeout(load, 1300);
  document.addEventListener('click', (e) => { if (e.target?.id === 'tab-settings') load(); });
})();
