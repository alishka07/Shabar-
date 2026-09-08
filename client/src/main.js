import './styles.css';

import { onDataChange } from './db.js';
import { enableOfflineStart } from './offline.js';
import { onSyncStatus, startSyncLoop } from './sync.js';
import { renderList } from './ui/list-screen.js';
import { renderMap } from './ui/map-screen.js';
import { renderQueue } from './ui/queue-screen.js';
import { renderReportForm } from './ui/report-form.js';
import { renderSettings } from './ui/settings-screen.js';

const SCREENS = {
  new: renderReportForm,
  list: renderList,
  queue: renderQueue,
  map: renderMap,
  settings: renderSettings,
};

const screenRoot = document.querySelector('#screen');
const tabs = [...document.querySelectorAll('[data-tab]')];
const connBadge = document.querySelector('#conn');

let current = 'new';

async function paint() {
  for (const tab of tabs) tab.classList.toggle('is-active', tab.dataset.tab === current);
  await SCREENS[current](screenRoot);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    current = tab.dataset.tab;
    paint();
  });
}

// Форма — единственный экран с несохранённым вводом, её перерисовывать по
// событию данных нельзя: пользователь потеряет набранное.
onDataChange(() => {
  if (current !== 'new') paint();
});

onSyncStatus(({ online, running }) => {
  connBadge.textContent = running ? 'обмен…' : online ? 'канал есть' : 'канала нет';
  connBadge.className = `conn ${online ? 'is-online' : 'is-offline'}`;
});

enableOfflineStart();
startSyncLoop();
paint();
