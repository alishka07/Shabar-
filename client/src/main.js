import './styles.css';

import { onDataChange } from './db.js';
import { enableOfflineStart } from './offline.js';
import { onSyncStatus, startSyncLoop, sync } from './sync.js';
import { isUnlocked } from './vault.js';
import { renderList } from './ui/list-screen.js';
import { renderLock } from './ui/lock-screen.js';
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
const tabsBar = document.querySelector('.tabs');
const tabs = [...document.querySelectorAll('[data-tab]')];
const connBadge = document.querySelector('#conn');

let current = 'new';
let syncLoopStarted = false;

async function paint() {
  if (!isUnlocked()) {
    tabsBar.hidden = true;
    connBadge.textContent = 'заперто';
    connBadge.className = 'conn';
    renderLock(screenRoot, onUnlocked);
    return;
  }

  tabsBar.hidden = false;
  for (const tab of tabs) tab.classList.toggle('is-active', tab.dataset.tab === current);
  await SCREENS[current](screenRoot);
}

function onUnlocked() {
  // Очередь могла копиться, пока приложение было заперто.
  if (!syncLoopStarted) {
    startSyncLoop();
    syncLoopStarted = true;
  } else {
    sync();
  }
  current = 'new';
  paint();
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
  if (!isUnlocked()) return;
  connBadge.textContent = running ? 'обмен…' : online ? 'канал есть' : 'канала нет';
  connBadge.className = `conn ${online ? 'is-online' : 'is-offline'}`;
});

// Оболочка кладётся в кэш независимо от ПИН-кода: приложение должно
// открываться без сети ещё до того, как оператор введёт код.
enableOfflineStart();
paint();
