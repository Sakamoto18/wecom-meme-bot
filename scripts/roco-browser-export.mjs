// Run in an already accessible public Wiki page via browser eval. This builds
// the serializable function body; no cookies, login credentials or private APIs.
// Usage: node scripts/roco-browser-export.mjs titles.json > collector.js
import { readFileSync } from 'node:fs';
const titles = JSON.parse(readFileSync(process.argv[2], 'utf8'));
function collect(titles) {
  const previous = window.rocoImport;
  const records = previous?.records || [];
  const remaining = titles.filter(title => !records.some(r => r.title === title));
  const state = window.rocoImport = { records, next: 0, done: records.length, error: null, finished: false };
  const clean = node => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('style,script').forEach(n => n.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };
  async function worker() {
    while (!state.error && state.next < remaining.length) {
      const title = remaining[state.next++];
      try {
        const params = new URLSearchParams({ action:'parse', page:title, prop:'text|revid', format:'json', redirects:'1' });
        const response = await fetch('/nrc/api.php?' + params, { signal:AbortSignal.timeout(45000) });
        if (!response.ok) throw Error('HTTP ' + response.status + ' ' + title);
        const data = await response.json();
        if (!data.parse?.text?.['*']) throw Error('Missing rendered page: ' + title);
        const doc = new DOMParser().parseFromString(data.parse.text['*'], 'text/html');
        const pet = doc.querySelector('[data-sd-kind="pet"]');
        if (!pet) throw Error('Missing pet: ' + title);
        const sections = Object.fromEntries([...pet.querySelectorAll('[data-sd-p-panel]')]
          .filter(n => n.dataset.sdPPanel !== 'skills' && clean(n)).map(n => [n.dataset.sdPPanel, clean(n)]));
        const templates = Object.fromEntries([...pet.querySelectorAll('[data-sd-p-template]')]
          .map(n => [n.dataset.sdPTemplate, clean(n)]));
        const skills = [...pet.querySelectorAll('.sd-p-skill-card')].map(n => ({
          name:n.dataset.name, source:n.dataset.source, level:n.dataset.source === 'machine' ? '' : n.dataset.level,
          type:n.dataset.type, category:n.dataset.category, power:n.dataset.power, energy:n.dataset.energy,
          effect:clean(n.querySelector('.sd-p-skill-description') || n), detail:templates[n.dataset.sdPSkill] || '',
        }));
        records.push({ title, petId:pet.dataset.petId, version:pet.dataset.nrcCodex, revision:data.parse.revid,
          fetchedAt:new Date().toISOString(), sections, skills });
        state.done++;
        await new Promise(resolve => setTimeout(resolve, 850));
      } catch (error) { state.error = String(error); }
    }
  }
  Promise.all([worker(), worker()]).then(() => { state.finished = true; });
  return { remaining: remaining.length, collected: records.length };
}
console.log(`() => (${collect.toString()})(${JSON.stringify(titles)})`);
