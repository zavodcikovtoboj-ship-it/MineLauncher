'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const STAGE_LABELS = {
  manifest: 'Манифест версий',
  client: 'Файлы клиента',
  libraries: 'Библиотеки',
  natives: 'Нативы',
  assets: 'Ассеты',
  'assets-map': 'Раскладка ассетов',
  java: 'Java',
  loader: 'Загрузчик',
  launch: 'Запуск',
  modpack: 'Скачивание модпака',
  'modpack-files': 'Файлы модпака',
  content: 'Контент',
  repair: 'Восстановление файлов',
  update: 'Обновление лаунчера',
};

const TYPE_LABELS = {
  release: 'релиз',
  snapshot: 'снапшот',
  old_beta: 'старая бета',
  old_alpha: 'старая альфа',
};

const LOADER_LABELS = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

const ACCENTS = ['green', 'blue', 'purple', 'orange', 'red', 'cyan'];

const state = {
  config: null,
  versions: [],
  latest: null,
  loaders: null,
  loaderError: '',
  modpacks: [],
  instances: [],
  modpackHits: [],
  modpackUpdates: new Map(),
  versionMeta: new Map(),
  running: false,
  busy: false,
  busyLabel: '',
  msPending: false,
  modpackBusy: false,
  modpackChecking: false,
  contentTargets: [],
  contentKind: 'mods',
  contentTargetId: '',
  contentHits: [],
  contentItems: [],
  contentUpdates: [],
  contentBusy: false,
  servers: [],
  serverStatus: new Map(),
  serversBusy: false,
  stats: null,
  maintenanceVersionId: '',
  maintenanceBusy: false,
  backups: [],
  dropDepth: 0,
  updateInfo: null,
  updateFile: '',
  updateBusy: false,
  java: null,
  errorAction: null,
};

let toastTimer = null;

const t = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);
const isEnglish = () => (window.i18n?.lang || 'ru') === 'en';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(label, className, onClick, { disabled = false, title = '' } = {}) {
  const node = el('button', `btn ${className}`.trim(), label);
  node.type = 'button';
  node.disabled = Boolean(disabled);
  if (title) node.title = title;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function miniLink(label, onClick, className = '', disabled = false) {
  const node = el('button', `mini-link ${className}`.trim(), label);
  node.type = 'button';
  node.disabled = Boolean(disabled);
  if (disabled) node.classList.add('disabled');
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function toast(message, bad = false) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.classList.toggle('bad', Boolean(bad));
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 4200);
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(isEnglish() ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(isEnglish() ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const unit = (ru, en) => (isEnglish() ? en : ru);
  if (total < 60) return `${total} ${unit('с', 's')}`;
  if (total < 3600) return `${Math.floor(total / 60)} ${unit('мин', 'min')}`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours} ${unit('ч', 'h')} ${minutes} ${unit('мин', 'min')}`;
}

function formatDownloads(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)} млн`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)} тыс.`;
  return String(n);
}

function addLog(line) {
  const box = $('#log-output');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const next = box.textContent ? `${box.textContent}\n${line}` : String(line);
  box.textContent = next.length > 220000 ? next.slice(-180000) : next;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function parseTargetClient(id) {
  const value = String(id || '');
  if (value.startsWith('fabric:')) return { kind: 'fabric', mcVersion: value.slice(7) };
  if (value.startsWith('forge:')) return { kind: 'forge', mcVersion: value.slice(6) };
  if (value.startsWith('neoforge:')) return { kind: 'neoforge', mcVersion: value.slice(9) };
  if (value.startsWith('modpack:')) return { kind: 'modpack', slug: value.slice(8) };
  if (value.startsWith('instance:')) return { kind: 'instance', slug: value.slice(9) };
  return { kind: 'vanilla', mcVersion: value };
}

function isManagedTarget(id) {
  const target = parseTargetClient(id);
  return target.kind === 'instance' || target.kind === 'modpack';
}

function targetLoader(id) {
  const target = parseTargetClient(id);
  if (target.kind === 'instance') {
    return state.instances.find((item) => item.slug === target.slug)?.loader || 'vanilla';
  }
  if (target.kind === 'modpack') {
    return state.modpacks.find((item) => item.slug === target.slug)?.loader || 'vanilla';
  }
  return target.kind === 'vanilla' ? 'vanilla' : target.kind;
}

function selectedPlayTarget() {
  return $('#version-select')?.value || state.config?.selectedVersion || '';
}

function switchPage(name) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  if (name === 'logs') {
    const box = $('#log-output');
    box.scrollTop = box.scrollHeight;
  }
  if (name === 'instances') loadInstances().catch(() => {});
  if (name === 'servers') loadServers().catch(() => {});
  if (name === 'stats') loadStats().catch(() => {});
}

function applyTheme(theme = 'dark', accent = 'green') {
  const root = document.documentElement;
  root.dataset.theme = theme === 'light' ? 'light' : 'dark';
  root.dataset.accent = ACCENTS.includes(accent) ? accent : 'green';
  document.body.dataset.theme = root.dataset.theme;
  document.body.dataset.accent = root.dataset.accent;
  $$('.accent-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.accent === root.dataset.accent);
  });
}

function applyLanguage(language) {
  const lang = language === 'en' ? 'en' : 'ru';
  const select = $('#language-select');
  if (select) select.value = lang;
  if (!window.i18n) return false;
  if (window.i18n.lang === lang) {
    window.i18n.apply();
    return false;
  }
  window.i18n.setLanguage(lang);
  return true;
}

function applyConfig() {
  const c = state.config;
  if (!c) return;
  $('#play-username').value = c.username || 'Player';
  $('#account-username').value = c.username || 'Player';
  $('#ms-client-id').value = c.msClientId || '';
  $('#java-path').value = c.javaPath || '';
  $('#game-dir').value = c.gameDir || '';
  $('#jvm-args').value = c.jvmArgs || '';
  $('#show-snapshots').checked = Boolean(c.showSnapshots);
  $('#custom-resolution').checked = Boolean(c.customResolution);
  $('#res-inputs').classList.toggle('hidden', !c.customResolution);
  $('#res-width').value = c.width || 1280;
  $('#res-height').value = c.height || 720;
  $('#ram-range').value = Math.min(16384, Math.max(1024, c.ramMb || 4096));
  $('#theme-select').value = c.theme === 'light' ? 'light' : 'dark';
  $('#language-select').value = c.language === 'en' ? 'en' : 'ru';
  $('#speed-limit').value = String(Number(c.speedLimitKbps) || 0);
  if (!Array.from($('#speed-limit').options).some((option) => option.value === String(Number(c.speedLimitKbps) || 0))) {
    const option = el('option', '', `${Number(c.speedLimitKbps) || 0} КБ/с`);
    option.value = String(Number(c.speedLimitKbps) || 0);
    $('#speed-limit').appendChild(option);
    $('#speed-limit').value = option.value;
  }
  $('#mirror-mode').value = c.mirrorMode || 'auto';
  $('#proxy-mode').value = c.proxyMode || 'system';
  $('#proxy-url').value = c.proxyUrl || '';
  $('#proxy-row').classList.toggle('hidden', c.proxyMode !== 'manual');
  $('#auto-update').checked = Boolean(c.autoUpdateCheck);
  $('#update-feed').value = c.updateFeedUrl || '';
  $('#discord-client-id').value = c.discordClientId || '';
  $('#cleanup-days').value = Number(c.cleanupDays) || 7;
  $('#backup-retention').value = Number(c.backupRetention) || 10;
  applyTheme(c.theme, c.accent);
  applyLanguage(c.language);
  updateRamUi();
  refreshAccountUi();
}

function updateRamUi() {
  const input = $('#ram-range');
  const value = Number(input.value);
  const min = Number(input.min);
  const max = Number(input.max);
  const fill = ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${fill}%`);
  const gb = value / 1024;
  $('#ram-value').textContent = `${Number.isInteger(gb) ? gb : gb.toFixed(1)} ГБ`;
}

function refreshAccountUi() {
  const c = state.config;
  if (!c) return;
  const isMs = c.accountType === 'microsoft' && c.msProfile;
  const name = isMs ? c.msProfile.name : c.username || 'Player';
  $('#chip-name').textContent = name;
  $('#chip-type').textContent = isMs ? t('account.ms') : t('account.offline');
  $('#avatar').textContent = (name[0] || 'P').toUpperCase();
  $('#play-username').disabled = Boolean(isMs);
  $('#play-username').value = name;

  const status = $('#ms-status');
  if (isMs) {
    status.textContent = `${t('account.ms')}: ${c.msProfile.name}`;
    status.className = 'account-status ok';
    $('#ms-logout').classList.remove('hidden');
  } else {
    status.textContent = t('account.notLogged');
    status.className = 'account-status';
    $('#ms-logout').classList.add('hidden');
  }
}

function describeTarget(id) {
  const target = parseTargetClient(id);
  const version = state.versions.find((item) => item.id === target.mcVersion);
  const type = version ? TYPE_LABELS[version.type] || version.type : '—';
  const date = version?.releaseTime || '';

  if (target.kind === 'modpack') {
    const pack = state.modpacks.find((item) => item.slug === target.slug);
    if (!pack) {
      return { label: target.slug, type: 'модпак', date: '', sub: 'Модпак не установлен.' };
    }
    return {
      label: pack.name,
      type: 'модпак',
      date: '',
      sub: `Модпак «${pack.name}» · Minecraft ${pack.mcVersion} · ${pack.loaderLabel || LOADER_LABELS[pack.loader] || 'Vanilla'}.`,
    };
  }

  if (target.kind === 'instance') {
    const instance = state.instances.find((item) => item.slug === target.slug);
    if (!instance) {
      return { label: target.slug, type: 'инстанс', date: '', sub: 'Инстанс не найден.' };
    }
    return {
      label: instance.name,
      type: 'инстанс',
      date: '',
      sub: `Инстанс «${instance.name}» · Minecraft ${instance.mcVersion} · ${LOADER_LABELS[instance.loader] || instance.loader}.`,
    };
  }

  if (target.kind === 'fabric') {
    const loader = state.loaders?.fabric?.latestLoader || '';
    return {
      label: `${target.mcVersion} · Fabric`,
      type: 'Fabric',
      date,
      sub: `Minecraft ${target.mcVersion} · Fabric${loader ? ` ${loader}` : ''}. Загрузчик установится при первом запуске.`,
    };
  }

  if (target.kind === 'forge') {
    const entry = (state.loaders?.forge || []).find((item) => item.mcVersion === target.mcVersion);
    return {
      label: `${target.mcVersion} · Forge`,
      type: 'Forge',
      date,
      sub: `Minecraft ${target.mcVersion} · Forge${entry ? ` ${entry.loaderVersion}` : ''}. Загрузчик установится при первом запуске.`,
    };
  }

  if (target.kind === 'neoforge') {
    const entry = (state.loaders?.neoforge || []).find((item) => item.mcVersion === target.mcVersion);
    return {
      label: `${target.mcVersion} · NeoForge`,
      type: 'NeoForge',
      date,
      sub: `Minecraft ${target.mcVersion} · NeoForge${entry ? ` ${entry.loaderVersion}` : ''}. Загрузчик установится при первом запуске.`,
    };
  }

  return {
    label: target.mcVersion || '—',
    type,
    date,
    sub: version
      ? `Версия ${target.mcVersion} · ${type}. Нажмите «Играть».`
      : 'Выберите версию и нажмите «Играть».',
  };
}

function updateVersionBadges() {
  const select = $('#version-select');
  if (!select) return;
  const id = select.value;
  const info = describeTarget(id);
  $('#badge-version').textContent = info.label;
  $('#badge-type').textContent = info.type;
  $('#badge-date').textContent = info.date ? formatDate(info.date) : '';
  $('#hero-sub').textContent = info.sub;
}

function updatePlayButton() {
  const btn = $('#play-btn');
  if (!btn) return;
  btn.classList.toggle('running', state.running);
  btn.disabled = state.busy;
  $('#play-label').textContent = state.running
    ? t('play.stop')
    : state.busy
      ? state.busyLabel || 'Подождите…'
      : t('play.start');
  $('#play-glyph').textContent = state.running ? '■' : '▶';
}

function setRunning(running) {
  state.running = running;
  updatePlayButton();
  const select = $('#version-select');
  if (select) select.disabled = running;
  if (!running) {
    const hero = $('#hero-title');
    if (hero) hero.textContent = t('play.ready');
    updateVersionBadges();
    setTimeout(() => {
      if (!state.running) $('#progress-wrap').classList.add('hidden');
    }, 2500);
  }
}

function setBusy(busy, label = '') {
  state.busy = busy;
  state.busyLabel = label;
  updatePlayButton();
}

function resetProgress() {
  $('#progress-wrap').classList.remove('hidden');
  $('#progress-bar').style.width = '0%';
  $('#progress-bar').classList.remove('indeterminate');
  $('#progress-stage').textContent = t('play.preparing');
  $('#progress-file').textContent = '';
  $('#progress-percent').textContent = '';
}

function updateProgress(payload) {
  if (!payload) return;
  $('#progress-wrap').classList.remove('hidden');
  $('#progress-stage').textContent = STAGE_LABELS[payload.stage] || payload.stage || t('play.preparing');
  $('#progress-file').textContent = payload.file || '';
  if (payload.stage === 'launch') {
    $('#hero-title').textContent = t('play.launched');
    $('#hero-sub').textContent = t('play.launchedSub');
  }
  const bar = $('#progress-bar');
  if (payload.total > 0) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(100, payload.percent))}%`;
    $('#progress-percent').textContent = `${Math.round(payload.percent)}%`;
  } else {
    bar.classList.add('indeterminate');
    $('#progress-percent').textContent = '';
  }
}

function showError(message, action) {
  const box = $('#error-box');
  box.classList.remove('hidden');
  $('#error-text').textContent = message;
  const actionButton = $('#error-action');
  state.errorAction = action || null;
  if (action) {
    actionButton.textContent = action.label;
    actionButton.classList.remove('hidden');
  } else {
    actionButton.classList.add('hidden');
  }
}

function hideError() {
  $('#error-box').classList.add('hidden');
  state.errorAction = null;
}

function handleLaunchError(res) {
  if (!res) return;
  if (res.code === 'MS_REAUTH') {
    toast(res.error || 'Требуется повторный вход Microsoft.', true);
    switchPage('account');
    return;
  }
  if (res.code === 'JAVA_MISSING') {
    showError(res.error, {
      label: `Скачать Java ${res.requiredMajor}`,
      kind: 'java',
      component: res.component,
      major: res.requiredMajor,
    });
    return;
  }
  if (res.error) {
    showError(res.error);
    toast(res.error, true);
  }
}

async function loadVersions(force = false) {
  const refresh = $('#refresh-versions');
  refresh.classList.add('spinning');
  try {
    const res = await window.api.getVersions(force);
    if (!res.ok) {
      toast(res.error || 'Не удалось получить список версий', true);
      return;
    }
    state.versions = res.versions || [];
    state.latest = res.latest || null;
    state.modpacks = res.modpacks || state.modpacks;
    renderVersionOptions();
    refreshJava();
    loadLoaderCatalog(force);
  } catch (err) {
    toast(err.message || 'Не удалось получить список версий', true);
  } finally {
    refresh.classList.remove('spinning');
  }
}

async function loadLoaderCatalog(force = false) {
  try {
    const res = await window.api.getLoaderCatalog(force);
    if (!res.ok) {
      state.loaderError = res.error || 'Каталог загрузчиков недоступен';
      renderVersionOptions();
      return;
    }
    state.loaders = {
      fabric: res.fabric || { latestLoader: '', games: [] },
      forge: res.forge || [],
      neoforge: res.neoforge || [],
    };
    state.loaderError = '';
    renderVersionOptions();
  } catch (err) {
    state.loaderError = err.message || 'Каталог загрузчиков недоступен';
    renderVersionOptions();
  }
}

function renderVersionOptions() {
  const select = $('#version-select');
  if (!select) return;
  const c = state.config || {};
  const releases = state.versions.filter((item) => item.type === 'release');
  const snapshots = state.versions.filter((item) => item.type === 'snapshot');
  const old = state.versions.filter((item) => item.type === 'old_beta' || item.type === 'old_alpha');
  const displayed = [...releases, ...(c.showSnapshots ? snapshots : []), ...old];
  const displayedIds = new Set(displayed.map((item) => item.id));
  const previous = select.value;

  select.textContent = '';

  const addGroup = (label, items, emptyLabel) => {
    const group = el('optgroup');
    group.label = label;
    if (!items.length) {
      if (!emptyLabel) return;
      const option = el('option', '', emptyLabel);
      option.disabled = true;
      group.appendChild(option);
      select.appendChild(group);
      return;
    }
    for (const item of items) {
      const option = el('option', '', item.label);
      option.value = item.value;
      group.appendChild(option);
    }
    select.appendChild(group);
  };

  addGroup('Релизы', releases.map((item) => ({ value: item.id, label: item.id })));
  if (c.showSnapshots) {
    addGroup('Снапшоты', snapshots.map((item) => ({ value: item.id, label: item.id })));
  }
  addGroup('Старые версии', old.map((item) => ({ value: item.id, label: item.id })));

  const fabric = state.loaders?.fabric;
  const fabricGames = new Set(fabric?.games || []);
  const fabricLoader = fabric?.latestLoader || '';
  addGroup(
    'Fabric',
    displayed
      .filter((item) => fabricGames.has(item.id))
      .map((item) => ({
        value: `fabric:${item.id}`,
        label: `${item.id} — Fabric${fabricLoader ? ` ${fabricLoader}` : ''}`,
      })),
    state.loaders ? 'Нет доступных версий Fabric' : state.loaderError || 'Загрузка каталога Fabric…'
  );

  const forgeItems = (state.loaders?.forge || [])
    .filter((entry) => displayedIds.has(entry.mcVersion))
    .map((entry) => ({
      value: `forge:${entry.mcVersion}`,
      label: `${entry.mcVersion} — Forge ${entry.loaderVersion}`,
    }));
  addGroup(
    'Forge',
    forgeItems,
    state.loaders ? 'Нет доступных версий Forge' : state.loaderError || 'Загрузка каталога Forge…'
  );

  const neoItems = (state.loaders?.neoforge || [])
    .filter((entry) => displayedIds.has(entry.mcVersion))
    .map((entry) => ({
      value: `neoforge:${entry.mcVersion}`,
      label: `${entry.mcVersion} — NeoForge ${entry.loaderVersion}`,
    }));
  addGroup(
    'NeoForge',
    neoItems,
    state.loaders ? 'Нет доступных версий NeoForge' : state.loaderError || 'Загрузка каталога NeoForge…'
  );

  addGroup(
    'Модпаки',
    state.modpacks.map((pack) => ({
      value: `modpack:${pack.slug}`,
      label: `${pack.name} — ${pack.loaderLabel || LOADER_LABELS[pack.loader] || 'Vanilla'} ${pack.mcVersion}`,
    })),
    'Нет модпаков — нажмите «Модпаки»'
  );

  addGroup(
    'Инстансы',
    state.instances.map((instance) => ({
      value: `instance:${instance.slug}`,
      label: `${instance.name} — ${LOADER_LABELS[instance.loader] || 'Vanilla'} ${instance.mcVersion}`,
    })),
    'Нет инстансов — создайте на странице «Инстансы»'
  );

  let selected = c.selectedVersion || previous;
  const target = parseTargetClient(selected);
  if (target.kind === 'modpack' && !state.modpacks.some((pack) => pack.slug === target.slug)) {
    selected = '';
  }
  if (target.kind === 'instance' && !state.instances.some((instance) => instance.slug === target.slug)) {
    selected = '';
  }
  if (!selected) selected = state.latest?.release || releases[0]?.id || '';

  const hasOption = Array.from(select.options).some((option) => option.value === selected);
  if (selected && !hasOption) {
    const group = el('optgroup');
    group.label = 'Выбрано';
    const option = el('option', '', selected);
    option.value = selected;
    group.appendChild(option);
    select.insertBefore(group, select.firstChild);
  }
  if (selected) select.value = selected;
  select.disabled = state.running;
  renderInstanceVersionOptions();
  updateVersionBadges();
}

function renderInstanceVersionOptions() {
  const select = $('#instance-version');
  if (!select) return;
  const previous = select.value;
  select.textContent = '';
  const releases = state.versions.filter((item) => item.type === 'release');
  const snapshots = state.versions.filter((item) => item.type === 'snapshot');
  const old = state.versions.filter((item) => item.type === 'old_beta' || item.type === 'old_alpha');
  for (const item of [...releases, ...(state.config?.showSnapshots ? snapshots : []), ...old]) {
    const option = el('option', '', item.id);
    option.value = item.id;
    select.appendChild(option);
  }
  if (previous && Array.from(select.options).some((option) => option.value === previous)) {
    select.value = previous;
  } else if (releases[0]) {
    select.value = releases[0].id;
  }
}

async function loadInstances() {
  try {
    const res = await window.api.listInstances();
    if (!res.ok) {
      toast(res.error || 'Не удалось загрузить инстансы', true);
      return state.instances;
    }
    state.instances = res.instances || [];
    renderInstances();
    if (state.versions.length) renderVersionOptions();
    else renderInstanceVersionOptions();
    return state.instances;
  } catch (err) {
    toast(err.message || 'Не удалось загрузить инстансы', true);
    return state.instances;
  }
}

async function requiredJavaFor(versionId) {
  if (!versionId) return 8;
  if (state.versionMeta.has(versionId)) return state.versionMeta.get(versionId);
  let major = 8;
  try {
    const meta = await window.api.getVersionMeta(versionId);
    if (meta.ok && meta.javaVersion?.majorVersion) major = meta.javaVersion.majorVersion;
  } catch {
    // keep the default
  }
  state.versionMeta.set(versionId, major);
  return major;
}

let javaCheckSeq = 0;

async function refreshJava() {
  const seq = ++javaCheckSeq;
  const status = $('#status-line');
  if (!status) return;
  status.textContent = t('play.javaChecking');
  status.className = 'status-line';

  const versionId = selectedPlayTarget();
  const requiredMajor = await requiredJavaFor(versionId);
  let res;
  try {
    res = await window.api.detectJava();
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (seq !== javaCheckSeq) return;
  const cta = $('#java-cta');
  if (!res.ok) {
    cta.classList.add('hidden');
    status.textContent = `Java: ошибка проверки (${res.error})`;
    status.className = 'status-line bad';
    return;
  }
  state.java = res;

  const all = Array.isArray(res.all) ? res.all : [];
  const suitable = all
    .filter((item) => item.major >= requiredMajor)
    .sort((a, b) => a.major - b.major)[0];

  if (suitable) {
    cta.classList.add('hidden');
    status.textContent = `Java ${suitable.major} · ${suitable.path}`;
    status.className = 'status-line ok';
    $('#java-status').textContent = `Найдена Java ${suitable.major}: ${suitable.path}`;
    $('#java-status').className = 'status-line ok';
  } else if (all.length) {
    cta.textContent = t('play.downloadJava') + ` ${requiredMajor}`;
    cta.classList.remove('hidden');
    const majors = all.map((item) => item.major).sort((a, b) => a - b).join(', ');
    status.textContent = `Для этой версии нужна Java ${requiredMajor}+, найдена только ${majors}.`;
    status.className = 'status-line bad';
    $('#java-status').textContent = `Java ${majors} не подходит, нужна ${requiredMajor}+. Можно скачать JRE от Mojang.`;
    $('#java-status').className = 'status-line bad';
  } else {
    cta.textContent = t('play.downloadJava') + ` ${requiredMajor}`;
    cta.classList.remove('hidden');
    status.textContent = 'Java не найдена.';
    status.className = 'status-line bad';
    $('#java-status').textContent = 'Java не найдена. Можно скачать JRE от Mojang.';
    $('#java-status').className = 'status-line bad';
  }
}

async function loadAppInfo() {
  try {
    const info = await window.api.appInfo();
    $('#app-info').textContent =
      `MineLauncher ${info.version} · Electron ${info.electron} · Node ${info.node} · ${info.platform}/${info.arch}`;
    const footer = $('#app-version');
    if (footer) footer.textContent = `MineLauncher ${info.version}`;
  } catch {
    // diagnostics only
  }
}

async function savePlayConfig() {
  const patch = {
    ramMb: Number($('#ram-range').value),
    selectedVersion: $('#version-select').value,
  };
  if (state.config.accountType !== 'microsoft') {
    patch.username = $('#play-username').value.trim().slice(0, 16) || 'Player';
  }
  try {
    state.config = await window.api.setConfig(patch);
    refreshAccountUi();
  } catch (err) {
    toast(err.message || 'Не удалось сохранить настройки', true);
  }
}

async function onPlay() {
  if (state.running) {
    await window.api.cancel().catch(() => {});
    return;
  }
  if (state.busy) return;

  const versionId = selectedPlayTarget();
  if (!versionId) {
    toast('Сначала выберите версию', true);
    return;
  }

  await savePlayConfig();
  hideError();
  resetProgress();
  setRunning(true);
  setDiscordActivityForLaunch(versionId);

  try {
    const res = await window.api.launch(versionId);
    if (!res.ok && !res.cancelled && res.error) handleLaunchError(res);
    if (res.crash?.found) {
      showCrash(res.crash);
      toast('Игра завершилась с ошибкой. Открыт анализ краша.', true);
    }
  } catch (err) {
    handleLaunchError({ error: err.message });
  } finally {
    setRunning(false);
    setDiscordActivityIdle();
    refreshJava();
    if ($('#page-stats').classList.contains('active')) loadStats().catch(() => {});
  }
}

async function installJava(component, majorVersion) {
  if (state.busy) return;
  hideError();
  resetProgress();
  setBusy(true, 'Установка Java…');
  try {
    const res = await window.api.installJava(component, majorVersion);
    if (!res.ok) {
      toast(res.error || 'Не удалось установить Java', true);
      showError(res.error || 'Не удалось установить Java');
      return;
    }
    state.config.javaPath = res.path;
    $('#java-path').value = res.path;
    toast(`Java ${res.version || ''} установлена`);
    await refreshJava();
  } catch (err) {
    toast(err.message || 'Не удалось установить Java', true);
  } finally {
    setBusy(false);
  }
}

async function installJavaForSelectedVersion() {
  const versionId = selectedPlayTarget();
  let major = 21;
  let component = '';
  try {
    const meta = versionId ? await window.api.getVersionMeta(versionId) : { ok: false };
    if (meta.ok) {
      major = meta.javaVersion?.majorVersion || 21;
      component = meta.javaVersion?.component || '';
    }
  } catch {
    // defaults
  }
  await installJava(component, major);
}

async function onMsLogin() {
  if (state.msPending) return;
  const clientId = $('#ms-client-id').value.trim();
  if (!clientId) {
    toast('Укажите Azure Client ID', true);
    switchPage('account');
    return;
  }

  state.msPending = true;
  $('#ms-login').disabled = true;
  $('#ms-status').textContent = 'Ожидание подтверждения входа…';
  $('#ms-status').className = 'account-status';

  try {
    const res = await window.api.msLogin(clientId);
    if (res.ok) {
      state.config.accountType = 'microsoft';
      state.config.msProfile = res.profile;
      state.config.username = res.profile.name;
      refreshAccountUi();
      toast(`Вход выполнен: ${res.profile.name}`);
      if ($('#page-stats').classList.contains('active')) loadStats().catch(() => {});
    } else {
      if (!/отменён/i.test(res.error || '')) toast(res.error || 'Ошибка входа', true);
      $('#ms-status').textContent = res.error || 'Ошибка входа';
      $('#ms-status').className = 'account-status bad';
    }
  } catch (err) {
    toast(err.message || 'Ошибка входа', true);
  } finally {
    state.msPending = false;
    $('#ms-login').disabled = false;
    $('#modal').classList.add('hidden');
  }
}

function showDeviceModal(info) {
  if (!info) return;
  $('#device-code').textContent = info.userCode || '····';
  $('#device-open').dataset.uri = info.verificationUri || info.verificationUriComplete || '';
  const minutes = Math.round((info.expiresIn || 900) / 60);
  $('#device-hint').textContent = `Ожидание подтверждения… Код действует ${minutes} мин.`;
  $('#modal').classList.remove('hidden');
}

async function selectVersion(value) {
  const select = $('#version-select');
  if (!Array.from(select.options).some((option) => option.value === value)) {
    renderVersionOptions();
  }
  if (Array.from(select.options).some((option) => option.value === value)) {
    select.value = value;
  }
  updateVersionBadges();
  try {
    state.config = await window.api.setConfig({ selectedVersion: select.value });
  } catch {
    // selection still works for the current session
  }
  refreshJava();
}

function packIcon(url, title) {
  const box = el('div', 'pack-icon');
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      box.textContent = (title || '?')[0].toUpperCase();
    });
    box.appendChild(img);
  } else {
    box.textContent = (title || '?')[0].toUpperCase();
  }
  return box;
}

function packCard({ iconUrl, title, description, meta, tags = [], actions, className = '' }) {
  const card = el('div', `pack-card ${className}`.trim());
  const body = el('div', 'pack-body');
  const heading = el('div', 'pack-title', title);
  tags.forEach(({ text, className: tagClass }) => {
    heading.appendChild(el('span', `tag ${tagClass || ''}`.trim(), text));
  });
  body.appendChild(heading);
  if (description) body.appendChild(el('div', 'pack-desc', description));
  if (meta) body.appendChild(el('div', 'pack-meta', meta));
  const actionBox = el('div', 'pack-action');
  for (const node of actions) actionBox.appendChild(node);
  card.append(packIcon(iconUrl, title), body, actionBox);
  return card;
}

function renderModpackResults(hits) {
  const box = $('#modpack-results');
  box.textContent = '';
  if (!hits.length) {
    box.appendChild(el('div', 'pack-empty', 'Ничего не найдено. Попробуйте другой запрос.'));
    return;
  }

  for (const hit of hits) {
    const installed = state.modpacks.some(
      (pack) => pack.projectId === hit.projectId || pack.slug === hit.slug
    );
    const versions = (hit.versions || []).slice(0, 4).join(', ');
    const install = button(
      installed ? t('modpacks.installedBtn') : t('modpacks.install'),
      installed ? 'ghost pack-btn' : 'primary pack-btn',
      () => installModpack(hit),
      { disabled: installed || state.modpackBusy }
    );
    box.appendChild(
      packCard({
        iconUrl: hit.iconUrl,
        title: hit.title,
        description: hit.description,
        meta: `${formatDownloads(hit.downloads)} загрузок${versions ? ` · ${versions}` : ''}`,
        actions: [install],
      })
    );
  }
}

function renderInstalledPacks() {
  const box = $('#modpack-installed');
  box.textContent = '';
  if (!state.modpacks.length) {
    box.appendChild(el('div', 'pack-empty', 'Пока нет установленных модпаков.'));
    return;
  }

  for (const pack of state.modpacks) {
    const update = state.modpackUpdates.get(pack.slug);
    const tags = update ? [{ text: 'обновление', className: 'warn' }] : [];
    const actions = [];
    if (update) {
      actions.push(button(t('content.update'), 'primary pack-btn', () => updateModpack(pack.slug), {
        disabled: state.modpackBusy,
      }));
    }
    actions.push(
      button(
        t('modpacks.choose'),
        'pack-btn',
        async () => {
          await selectVersion(`modpack:${pack.slug}`);
          closeModpacks();
          toast(`Выбран модпак «${pack.name}»`);
        },
        { disabled: state.modpackBusy }
      )
    );
    actions.push(
      button(t('modpacks.remove'), 'ghost pack-btn danger', () => removeModpack(pack), {
        disabled: state.modpackBusy,
      })
    );
    box.appendChild(
      packCard({
        iconUrl: pack.iconUrl,
        title: pack.name,
        description: pack.summary || '',
        meta: `Minecraft ${pack.mcVersion} · ${pack.loaderLabel || LOADER_LABELS[pack.loader] || 'Vanilla'}${
          pack.versionName ? ` · ${pack.versionName}` : ''
        }${update ? ` → ${update.latest.versionName}` : ''}`,
        tags,
        actions,
        className: 'installed',
      })
    );
  }
}

function resetModpackProgress() {
  $('#modpack-progress-wrap').classList.remove('hidden');
  const bar = $('#modpack-progress-bar');
  bar.style.width = '0%';
  bar.classList.remove('indeterminate');
  $('#modpack-progress-stage').textContent = 'Установка';
  $('#modpack-progress-file').textContent = '';
  $('#modpack-progress-percent').textContent = '';
}

function updateModpackProgress(payload) {
  if (!payload) return;
  $('#modpack-progress-wrap').classList.remove('hidden');
  $('#modpack-progress-stage').textContent = STAGE_LABELS[payload.stage] || payload.stage || 'Установка';
  $('#modpack-progress-file').textContent = payload.file || '';
  const bar = $('#modpack-progress-bar');
  if (payload.total > 0) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(100, payload.percent))}%`;
    $('#modpack-progress-percent').textContent = `${Math.round(payload.percent)}%`;
  } else {
    bar.classList.add('indeterminate');
    $('#modpack-progress-percent').textContent = '';
  }
}

async function refreshModpackList() {
  try {
    const res = await window.api.getModpacks();
    if (res.ok) {
      state.modpacks = res.packs || [];
      renderVersionOptions();
      renderInstancesModpacks();
    } else {
      toast(res.error || 'Не удалось загрузить модпаки', true);
    }
  } catch (err) {
    toast(err.message || 'Не удалось загрузить модпаки', true);
  }
  return state.modpacks;
}

async function searchModpacks(query) {
  const status = $('#modpack-status');
  const box = $('#modpack-results');
  status.textContent = 'Поиск модпаков на Modrinth…';
  status.className = 'status-line';
  box.textContent = '';
  try {
    const res = await window.api.searchModpacks(query);
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось выполнить поиск.';
      status.className = 'status-line bad';
      return;
    }
    state.modpackHits = res.hits || [];
    renderModpackResults(state.modpackHits);
    status.textContent = state.modpackHits.length
      ? `Найдено: ${state.modpackHits.length}. Нажмите «Установить».`
      : 'Ничего не найдено.';
  } catch (err) {
    status.textContent = err.message || 'Не удалось выполнить поиск.';
    status.className = 'status-line bad';
  }
}

async function openModpacks() {
  $('#modpack-modal').classList.remove('hidden');
  $('#modpack-progress-wrap').classList.add('hidden');
  $('#modpack-status').textContent = 'Загрузка списка…';
  $('#modpack-status').className = 'status-line';
  await refreshModpackList();
  renderInstalledPacks();
  if (!state.modpackHits.length) await searchModpacks('');
  else renderModpackResults(state.modpackHits);
}

function closeModpacks() {
  $('#modpack-modal').classList.add('hidden');
}

async function installModpack(hit) {
  if (state.modpackBusy) return;
  state.modpackBusy = true;
  resetModpackProgress();
  $('#modpack-status').className = 'status-line';
  $('#modpack-status').textContent = `Установка «${hit.title}»…`;
  renderModpackResults(state.modpackHits);
  renderInstalledPacks();
  try {
    const res = await window.api.installModpack(hit.projectId);
    if (!res.ok) {
      $('#modpack-status').textContent = res.error || 'Не удалось установить модпак.';
      $('#modpack-status').className = 'status-line bad';
      if (res.code === 'JAVA_MISSING') {
        closeModpacks();
        handleLaunchError(res);
      } else {
        toast(res.error || 'Ошибка установки модпака', true);
      }
      return;
    }

    state.modpacks = res.packs || [];
    if (res.instances) state.instances = res.instances;
    state.modpackUpdates.delete(res.pack.slug);
    renderInstalledPacks();
    renderInstances();
    renderVersionOptions();
    await selectVersion(`modpack:${res.pack.slug}`);
    $('#modpack-status').className = 'status-line ok';
    $('#modpack-status').textContent = `Модпак «${res.pack.name}» установлен и выбран.`;
    toast(`Модпак «${res.pack.name}» установлен`);
  } catch (err) {
    $('#modpack-status').textContent = err.message || 'Не удалось установить модпак.';
    $('#modpack-status').className = 'status-line bad';
    toast(err.message || 'Ошибка установки модпака', true);
  } finally {
    state.modpackBusy = false;
    renderModpackResults(state.modpackHits);
    renderInstalledPacks();
    renderInstancesModpacks();
  }
}

async function removeModpack(pack) {
  if (state.modpackBusy) return;
  if (!confirm(`Удалить модпак «${pack.name}» вместе с его папкой и мирами?`)) return;
  state.modpackBusy = true;
  try {
    const res = await window.api.removeModpack(pack.slug);
    if (!res.ok) {
      toast(res.error || 'Не удалось удалить модпак', true);
      return;
    }
    const wasSelected = selectedPlayTarget() === `modpack:${pack.slug}`;
    state.modpacks = res.packs || [];
    state.modpackUpdates.delete(pack.slug);
    renderInstalledPacks();
    renderInstancesModpacks();
    renderVersionOptions();
    if (wasSelected) {
      const fallback = $('#version-select').value;
      state.config = await window.api.setConfig({ selectedVersion: fallback });
      refreshJava();
    }
    toast(`Модпак «${pack.name}» удалён`);
  } catch (err) {
    toast(err.message || 'Не удалось удалить модпак', true);
  } finally {
    state.modpackBusy = false;
    renderModpackResults(state.modpackHits);
    renderInstalledPacks();
    renderInstancesModpacks();
  }
}

function updateModpackStatus() {
  const label = $('#modpack-update-status');
  if (!label) return;
  if (state.modpackChecking) {
    label.textContent = 'Проверка обновлений…';
  } else if (!state.modpackChecked) {
    label.textContent = '';
  } else if (state.modpackUpdates.size) {
    label.textContent = `Доступно обновлений: ${state.modpackUpdates.size}`;
  } else {
    label.textContent = 'Обновлений нет';
  }
}

async function checkModpackUpdates() {
  if (state.modpackChecking) return;
  state.modpackChecking = true;
  updateModpackStatus();
  const modalStatus = $('#modpack-status');
  if (modalStatus && !$('#modpack-modal').classList.contains('hidden')) {
    modalStatus.textContent = 'Проверка обновлений модпаков на Modrinth…';
    modalStatus.className = 'status-line';
  }
  try {
    const res = await window.api.checkModpackUpdates();
    if (!res.ok) {
      toast(res.error || 'Не удалось проверить обновления модпаков', true);
      return;
    }
    state.modpackUpdates = new Map((res.updates || []).map((item) => [item.slug, item]));
    state.modpackChecked = true;
    updateModpackStatus();
    renderInstancesModpacks();
    renderInstalledPacks();
    if (modalStatus && !$('#modpack-modal').classList.contains('hidden')) {
      modalStatus.textContent = state.modpackUpdates.size
        ? `Доступны обновления: ${state.modpackUpdates.size}.`
        : 'Все модпаки обновлены.';
    }
    if (!state.modpackUpdates.size) toast('Обновлений модпаков нет');
  } catch (err) {
    toast(err.message || 'Не удалось проверить обновления модпаков', true);
  } finally {
    state.modpackChecking = false;
    updateModpackStatus();
    renderInstancesModpacks();
  }
}

async function updateModpack(slug) {
  if (state.modpackBusy) return;
  const pack = state.modpacks.find((item) => item.slug === slug);
  const update = state.modpackUpdates.get(slug);
  if (!pack) return;
  const targetVersion = update?.latest?.versionName ? ` до ${update.latest.versionName}` : '';
  if (!confirm(`Обновить модпак «${pack.name}»${targetVersion}? Настройки и миры сохранятся.`)) return;
  state.modpackBusy = true;
  resetModpackProgress();
  $('#modpack-status').className = 'status-line';
  $('#modpack-status').textContent = `Обновление «${pack.name}»…`;
  renderInstalledPacks();
  renderInstancesModpacks();
  try {
    const res = await window.api.updateModpack(slug);
    if (!res.ok) {
      $('#modpack-status').textContent = res.error || 'Не удалось обновить модпак.';
      $('#modpack-status').className = 'status-line bad';
      toast(res.error || 'Не удалось обновить модпак', true);
      return;
    }
    state.modpacks = res.packs || state.modpacks;
    state.modpackUpdates.delete(slug);
    renderInstalledPacks();
    renderInstancesModpacks();
    renderVersionOptions();
    updateModpackStatus();
    const message = res.updated ? `Модпак «${pack.name}» обновлён` : `Модпак «${pack.name}» уже обновлён`;
    $('#modpack-status').className = 'status-line ok';
    $('#modpack-status').textContent = message;
    toast(message);
  } catch (err) {
    toast(err.message || 'Не удалось обновить модпак', true);
  } finally {
    state.modpackBusy = false;
    renderInstalledPacks();
    renderInstancesModpacks();
  }
}

function instanceCard(instance) {
  const card = el('div', 'entity-card');
  const icon = el('div', 'entity-icon', (instance.name || '?')[0].toUpperCase());
  const body = el('div', 'entity-body');
  const title = el('div', 'entity-title', instance.name);
  title.appendChild(el('span', 'tag accent', LOADER_LABELS[instance.loader] || instance.loader));
  title.appendChild(el('span', 'tag', instance.mcVersion));
  if (!instance.exists) title.appendChild(el('span', 'tag warn', 'папка отсутствует'));
  body.appendChild(title);
  body.appendChild(el('div', 'entity-meta', `instance:${instance.slug} · создан ${formatDate(instance.createdAt)}`));
  body.appendChild(el('div', 'entity-desc', instance.notes || 'Отдельные моды, конфиги и миры.'));

  const actions = el('div', 'entity-actions');
  actions.appendChild(
    button(t('instances.play'), 'primary small-btn', async () => {
      await selectVersion(`instance:${instance.slug}`);
      toast(`Выбран инстанс «${instance.name}»`);
      switchPage('play');
    })
  );
  actions.appendChild(
    button(t('instances.content'), 'ghost small-btn', () => openContent(`instance:${instance.slug}`))
  );
  actions.appendChild(
    button(t('instances.maintenance'), 'ghost small-btn', () => openMaintenance(`instance:${instance.slug}`))
  );
  actions.appendChild(
    button('Папка', 'ghost small-btn', () => window.api.openTargetFolder(`instance:${instance.slug}`, 'instance'))
  );
  actions.appendChild(
    button(t('instances.export'), 'ghost small-btn', () => exportInstance(instance), {
      disabled: !instance.exists,
    })
  );
  actions.appendChild(
    button(t('instances.remove'), 'ghost small-btn danger-btn', () => removeInstance(instance))
  );

  card.append(icon, body, actions);
  return card;
}

function modpackCard(pack) {
  const update = state.modpackUpdates.get(pack.slug);
  const card = el('div', 'entity-card');
  const icon = el('div', 'entity-icon');
  if (pack.iconUrl) {
    const img = el('img');
    img.src = pack.iconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      icon.textContent = (pack.name || '?')[0].toUpperCase();
    });
    icon.appendChild(img);
  } else {
    icon.textContent = (pack.name || '?')[0].toUpperCase();
  }
  const body = el('div', 'entity-body');
  const title = el('div', 'entity-title', pack.name);
  title.appendChild(el('span', 'tag', pack.loaderLabel || LOADER_LABELS[pack.loader] || 'Vanilla'));
  title.appendChild(el('span', 'tag', pack.mcVersion));
  if (update) title.appendChild(el('span', 'tag warn', 'обновление'));
  body.appendChild(title);
  body.appendChild(
    el('div', 'entity-meta', `${pack.versionName || '—'} · modpack:${pack.slug} · установлен ${formatDate(pack.installedAt)}`)
  );
  body.appendChild(el('div', 'entity-desc', pack.summary || 'Модпак Modrinth.'));

  const actions = el('div', 'entity-actions');
  if (update) {
    actions.appendChild(button(t('content.update'), 'primary small-btn', () => updateModpack(pack.slug)));
  }
  actions.appendChild(
    button(t('instances.play'), 'ghost small-btn', async () => {
      await selectVersion(`modpack:${pack.slug}`);
      toast(`Выбран модпак «${pack.name}»`);
      switchPage('play');
    })
  );
  actions.appendChild(
    button(t('instances.content'), 'ghost small-btn', () => openContent(`modpack:${pack.slug}`))
  );
  actions.appendChild(
    button(t('instances.maintenance'), 'ghost small-btn', () => openMaintenance(`modpack:${pack.slug}`))
  );
  actions.appendChild(
    button(t('instances.remove'), 'ghost small-btn danger-btn', () => removeModpack(pack))
  );

  card.append(icon, body, actions);
  return card;
}

function renderInstances() {
  const box = $('#instances-list');
  if (!box) return;
  box.textContent = '';
  if (!state.instances.length) {
    box.appendChild(el('div', 'pack-empty', t('instances.empty')));
  } else {
    for (const instance of state.instances) box.appendChild(instanceCard(instance));
  }
  renderInstancesModpacks();
}

function renderInstancesModpacks() {
  const box = $('#instances-modpacks');
  if (!box) return;
  box.textContent = '';
  if (!state.modpacks.length) {
    box.appendChild(el('div', 'pack-empty', t('instances.emptyPacks')));
  } else {
    for (const pack of state.modpacks) box.appendChild(modpackCard(pack));
  }
  updateModpackStatus();
}

async function createInstance() {
  const name = $('#instance-name').value.trim();
  const mcVersion = $('#instance-version').value;
  const loader = $('#instance-loader').value;
  const status = $('#instance-status');
  if (!mcVersion) {
    toast('Выберите версию Minecraft', true);
    return;
  }
  const buttonEl = $('#instance-create');
  buttonEl.disabled = true;
  status.className = 'status-line';
  status.textContent = 'Создание инстанса…';
  try {
    const res = await window.api.createInstance({ name, mcVersion, loader });
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось создать инстанс';
      status.className = 'status-line bad';
      toast(res.error || 'Не удалось создать инстанс', true);
      return;
    }
    state.instances = res.instances || state.instances;
    $('#instance-name').value = '';
    renderInstances();
    renderVersionOptions();
    status.className = 'status-line ok';
    status.textContent = `Инстанс «${res.instance.name}» создан.`;
    toast(`Инстанс «${res.instance.name}» создан`);
  } catch (err) {
    status.textContent = err.message || 'Не удалось создать инстанс';
    status.className = 'status-line bad';
    toast(err.message || 'Не удалось создать инстанс', true);
  } finally {
    buttonEl.disabled = false;
  }
}

async function exportInstance(instance) {
  try {
    const res = await window.api.exportInstance(instance.slug);
    if (!res.ok) {
      if (!res.cancelled) toast(res.error || 'Не удалось экспортировать инстанс', true);
      return;
    }
    toast(`Инстанс экспортирован: ${formatBytes(res.size)}`);
  } catch (err) {
    toast(err.message || 'Не удалось экспортировать инстанс', true);
  }
}

async function importInstance() {
  const status = $('#instance-status');
  status.className = 'status-line';
  status.textContent = 'Импорт инстанса…';
  try {
    const res = await window.api.importInstance();
    if (!res.ok) {
      if (!res.cancelled) {
        status.textContent = res.error || 'Не удалось импортировать инстанс';
        status.className = 'status-line bad';
        toast(res.error || 'Не удалось импортировать инстанс', true);
      }
      return;
    }
    state.instances = res.instances || state.instances;
    renderInstances();
    renderVersionOptions();
    status.className = 'status-line ok';
    status.textContent = `Инстанс «${res.instance.name}» импортирован.`;
    toast(`Инстанс «${res.instance.name}» импортирован`);
  } catch (err) {
    status.textContent = err.message || 'Не удалось импортировать инстанс';
    status.className = 'status-line bad';
    toast(err.message || 'Не удалось импортировать инстанс', true);
  }
}

async function removeInstance(instance) {
  if (!confirm(`Удалить инстанс «${instance.name}» вместе с модами, конфигами и мирами?`)) return;
  try {
    const res = await window.api.removeInstance(instance.slug);
    if (!res.ok) {
      toast(res.error || 'Не удалось удалить инстанс', true);
      return;
    }
    const wasSelected = selectedPlayTarget() === `instance:${instance.slug}`;
    state.instances = res.instances || [];
    renderInstances();
    renderVersionOptions();
    if (wasSelected) {
      const fallback = $('#version-select').value;
      state.config = await window.api.setConfig({ selectedVersion: fallback });
      refreshJava();
    }
    toast(`Инстанс «${instance.name}» удалён`);
  } catch (err) {
    toast(err.message || 'Не удалось удалить инстанс', true);
  }
}

async function loadServers() {
  try {
    const res = await window.api.getServers();
    if (!res.ok) {
      toast(res.error || 'Не удалось загрузить серверы', true);
      return;
    }
    state.servers = res.servers || [];
    renderServers();
  } catch (err) {
    toast(err.message || 'Не удалось загрузить серверы', true);
  }
}

function serverPill(result) {
  if (result === 'checking') return el('span', 'server-pill', t('servers.checking'));
  if (!result) return el('span', 'server-pill', '—');
  if (result.status?.online) return el('span', 'server-pill ok', t('servers.online'));
  return el('span', 'server-pill bad', t('servers.offline'));
}

function renderServers() {
  const box = $('#servers-list');
  if (!box) return;
  box.textContent = '';
  if (!state.servers.length) {
    box.appendChild(el('div', 'pack-empty', t('servers.empty')));
    return;
  }

  for (const server of state.servers) {
    const result = state.serverStatus.get(server.id);
    const status = result && result !== 'checking' ? result.status : null;
    const card = el('div', `server-card${result && result !== 'checking' && !status ? ' offline' : ''}`);

    const icon = el('div', 'server-icon');
    if (status?.favicon && /^data:image\//.test(status.favicon)) {
      const img = el('img');
      img.src = status.favicon;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        icon.textContent = (server.name || '?')[0].toUpperCase();
      });
      icon.appendChild(img);
    } else {
      icon.textContent = (server.name || '?')[0].toUpperCase();
    }

    const body = el('div', 'server-body');
    const title = el('div', 'server-title');
    title.appendChild(el('div', 'server-name', server.name));
    title.appendChild(serverPill(result));
    body.appendChild(title);
    body.appendChild(el('div', 'server-address', server.address));

    if (result === 'checking') {
      body.appendChild(el('div', 'server-motd', t('servers.checking')));
    } else if (status) {
      body.appendChild(el('div', 'server-motd', status.motd || t('servers.online')));
      const stats = el('div', 'server-stats');
      const players = el('span');
      players.append(t('servers.players'), ' ', el('strong', '', `${status.players.online}/${status.players.max}`));
      const version = el('span');
      version.append(t('servers.version'), ' ', el('strong', '', status.version || '—'));
      const ping = el('span');
      ping.append(t('servers.pingLabel'), ' ', el('strong', '', `${status.latency} мс`));
      stats.append(players, version, ping);
      body.appendChild(stats);
    } else if (result?.error) {
      body.appendChild(el('div', 'server-motd', result.error));
    } else {
      body.appendChild(el('div', 'server-motd', 'Нажмите «Проверить», чтобы запросить статус.'));
    }

    const actions = el('div', 'server-actions');
    actions.appendChild(button(t('servers.ping'), 'ghost small-btn', () => pingServerById(server.id)));
    actions.appendChild(
      button(t('servers.copy'), 'ghost small-btn', async () => {
        const ok = await copyText(server.address);
        toast(ok ? `Адрес скопирован: ${server.address}` : 'Не удалось скопировать адрес', !ok);
      })
    );
    actions.appendChild(
      button(t('servers.remove'), 'ghost small-btn danger-btn', () => removeServer(server))
    );

    card.append(icon, body, actions);
    box.appendChild(card);
  }
}

async function pingServerById(id) {
  state.serverStatus.set(id, 'checking');
  renderServers();
  try {
    const res = await window.api.pingServer(id);
    if (!res.ok) {
      state.serverStatus.set(id, { status: null, error: res.error || 'Сервер недоступен.' });
    } else {
      state.serverStatus.set(id, res.server);
    }
  } catch (err) {
    state.serverStatus.set(id, { status: null, error: err.message || 'Сервер недоступен.' });
  }
  renderServers();
}

async function pingAllServers() {
  if (state.serversBusy) return;
  state.serversBusy = true;
  const status = $('#servers-status');
  for (const server of state.servers) state.serverStatus.set(server.id, 'checking');
  renderServers();
  status.textContent = 'Проверка серверов…';
  status.className = 'status-line';
  try {
    const res = await window.api.pingAllServers();
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось проверить серверы';
      status.className = 'status-line bad';
      return;
    }
    for (const item of res.servers || []) state.serverStatus.set(item.id, item);
    renderServers();
    const online = (res.servers || []).filter((item) => item.status?.online).length;
    status.textContent = `Проверено: ${res.servers?.length || 0}, онлайн: ${online}.`;
    status.className = 'status-line';
  } catch (err) {
    status.textContent = err.message || 'Не удалось проверить серверы';
    status.className = 'status-line bad';
  } finally {
    state.serversBusy = false;
  }
}

async function addServer() {
  const name = $('#server-name').value.trim();
  const address = $('#server-address').value.trim();
  const status = $('#servers-status');
  if (!address) {
    toast('Укажите адрес сервера', true);
    return;
  }
  try {
    const res = await window.api.addServer({ name, address });
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось добавить сервер';
      status.className = 'status-line bad';
      toast(res.error || 'Не удалось добавить сервер', true);
      return;
    }
    state.servers = res.servers || state.servers;
    $('#server-name').value = '';
    $('#server-address').value = '';
    renderServers();
    status.className = 'status-line ok';
    status.textContent = `Сервер «${res.server.name}» добавлен.`;
    toast(`Сервер «${res.server.name}» добавлен`);
    pingServerById(res.server.id);
  } catch (err) {
    status.textContent = err.message || 'Не удалось добавить сервер';
    status.className = 'status-line bad';
    toast(err.message || 'Не удалось добавить сервер', true);
  }
}

async function removeServer(server) {
  if (!confirm(`Удалить сервер «${server.name}» из списка?`)) return;
  try {
    const res = await window.api.removeServer(server.id);
    if (!res.ok) {
      toast(res.error || 'Не удалось удалить сервер', true);
      return;
    }
    state.servers = res.servers || [];
    state.serverStatus.delete(server.id);
    renderServers();
    toast(`Сервер «${server.name}» удалён`);
  } catch (err) {
    toast(err.message || 'Не удалось удалить сервер', true);
  }
}

function buildTable(headers, rows, emptyText) {
  const wrap = el('div');
  if (!rows.length) {
    wrap.appendChild(el('div', 'table-empty', emptyText));
    return wrap;
  }
  const table = el('table', 'data-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const label of headers) headRow.appendChild(el('th', '', label));
  head.appendChild(headRow);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const value of row) tr.appendChild(el('td', '', value));
    body.appendChild(tr);
  }
  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}

async function loadStats() {
  try {
    const res = await window.api.getStats();
    if (!res.ok) {
      toast(res.error || 'Не удалось загрузить статистику', true);
      return;
    }
    state.stats = res.summary;
    renderStats();
  } catch (err) {
    toast(err.message || 'Не удалось загрузить статистику', true);
  }
}

function renderStats() {
  const summary = state.stats;
  if (!summary) return;
  $('#stats-launches').textContent = String(summary.launches || 0);
  $('#stats-playtime').textContent = formatDuration(summary.totalSeconds || 0);
  $('#stats-average').textContent = formatDuration(summary.averageSeconds || 0);
  $('#stats-crashes').textContent = String(summary.crashes || 0);
  $('#stats-last').textContent = summary.lastPlayed
    ? `${t('stats.last')}: ${formatDateTime(summary.lastPlayed)}`
    : t('stats.empty');

  const byTarget = (summary.byTarget || []).map((entry) => [
    entry.name || entry.targetId,
    String(entry.launches || 0),
    formatDuration(entry.seconds || 0),
    entry.lastPlayed ? formatDateTime(entry.lastPlayed) : '—',
    String(entry.crashes || 0),
  ]);
  const byTargetBox = $('#stats-by-target');
  byTargetBox.textContent = '';
  byTargetBox.appendChild(
    buildTable(
      [t('stats.target'), t('stats.count'), t('stats.time'), t('stats.date'), t('stats.crashes')],
      byTarget,
      t('stats.empty')
    )
  );

  const recent = (summary.recent || []).map((session) => {
    const result = session.crashed
      ? 'сбой'
      : session.exitCode === null || session.exitCode === undefined
        ? '—'
        : session.exitCode === 0
          ? 'закрыто'
          : `код ${session.exitCode}`;
    return [
      formatDateTime(session.startedAt),
      session.name || session.targetId,
      formatDuration(session.seconds || 0),
      result,
    ];
  });
  const recentBox = $('#stats-recent');
  recentBox.textContent = '';
  recentBox.appendChild(
    buildTable(
      [t('stats.date'), t('stats.target'), t('stats.time'), t('stats.result')],
      recent,
      t('stats.empty')
    )
  );
}

async function resetStats() {
  if (!confirm('Сбросить всю статистику запусков? Это действие нельзя отменить.')) return;
  try {
    const res = await window.api.resetStats();
    if (!res.ok) {
      toast(res.error || 'Не удалось сбросить статистику', true);
      return;
    }
    await loadStats();
    toast('Статистика сброшена');
  } catch (err) {
    toast(err.message || 'Не удалось сбросить статистику', true);
  }
}

function contentTargetMeta(id) {
  const value = String(id || '');
  const known = state.contentTargets.find((item) => item.id === value);
  if (known) return known;
  const parsed = parseTargetClient(value);
  if (parsed.kind === 'instance') {
    const instance = state.instances.find((item) => item.slug === parsed.slug);
    return {
      id: value,
      name: instance?.name || parsed.slug,
      mcVersion: instance?.mcVersion || '',
      loader: instance?.loader || 'vanilla',
      kind: 'instance',
    };
  }
  if (parsed.kind === 'modpack') {
    const pack = state.modpacks.find((item) => item.slug === parsed.slug);
    return {
      id: value,
      name: pack?.name || parsed.slug,
      mcVersion: pack?.mcVersion || '',
      loader: pack?.loader || 'vanilla',
      kind: 'modpack',
    };
  }
  if (parsed.kind === 'vanilla') {
    return {
      id: value,
      name: `${t('content.targetVanilla')} ${parsed.mcVersion}`.trim(),
      mcVersion: parsed.mcVersion,
      loader: 'vanilla',
      kind: 'vanilla',
    };
  }
  return {
    id: value,
    name: `${parsed.mcVersion} · ${LOADER_LABELS[parsed.kind] || parsed.kind}`,
    mcVersion: parsed.mcVersion,
    loader: parsed.kind,
    kind: 'loader',
  };
}

async function refreshContentTargets() {
  let targets = [];
  try {
    const res = await window.api.getContentTargets();
    if (res.ok) targets = res.targets || [];
  } catch {
    targets = [];
  }
  const play = selectedPlayTarget();
  if (play && !targets.some((item) => item.id === play)) {
    const meta = contentTargetMeta(play);
    if (meta.mcVersion) {
      targets = [{ ...meta, synthetic: true }, ...targets];
    }
  }
  state.contentTargets = targets;
  renderContentTargetOptions();
  return targets;
}

function renderContentTargetOptions() {
  const select = $('#content-target');
  if (!select) return;
  select.textContent = '';
  if (!state.contentTargets.length) {
    const option = el('option', '', 'Нет доступных инстансов и модпаков');
    option.disabled = true;
    select.appendChild(option);
    return;
  }
  for (const target of state.contentTargets) {
    const loader = LOADER_LABELS[target.loader] || target.loader || 'Vanilla';
    const option = el('option', '', `${target.name} — ${loader} ${target.mcVersion}`);
    option.value = target.id;
    select.appendChild(option);
  }
  const available = state.contentTargets.some((item) => item.id === state.contentTargetId);
  if (!available) {
    const play = selectedPlayTarget();
    state.contentTargetId = state.contentTargets.some((item) => item.id === play)
      ? play
      : state.contentTargets[0]?.id || '';
  }
  if (state.contentTargetId) select.value = state.contentTargetId;
  renderContentWarning();
}

function renderContentWarning() {
  const warning = $('#content-warning');
  if (!warning) return;
  const meta = contentTargetMeta(state.contentTargetId);
  const show = state.contentKind === 'mods' && meta.loader === 'vanilla';
  warning.classList.toggle('hidden', !show);
}

function setContentKind(kind) {
  if (!['mods', 'resourcepacks', 'shaders'].includes(kind) || kind === state.contentKind) return;
  state.contentKind = kind;
  $$('#content-tabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.kind === kind));
  state.contentHits = [];
  state.contentUpdates = [];
  const report = $('#content-report');
  report.classList.add('hidden');
  report.textContent = '';
  renderContentWarning();
  loadContentInstalled();
  searchContent($('#content-search').value.trim());
}

async function openContent(targetId) {
  state.contentTargetId = String(targetId || selectedPlayTarget() || '');
  $('#content-modal').classList.remove('hidden');
  $('#content-progress-wrap').classList.add('hidden');
  $('#content-report').classList.add('hidden');
  $('#content-report').textContent = '';
  $('#content-status').className = 'status-line';
  $('#content-status').textContent = 'Загрузка целей…';
  state.contentHits = [];
  state.contentUpdates = [];
  $('#content-results').textContent = '';
  $('#content-installed').textContent = '';
  await refreshContentTargets();
  if (!state.contentTargets.length) {
    $('#content-status').textContent =
      'Сначала создайте инстанс или установите модпак — контент хранится в их папках.';
    return;
  }
  $('#content-target').value = state.contentTargetId;
  renderContentWarning();
  await Promise.all([loadContentInstalled(), searchContent($('#content-search').value.trim())]);
}

function closeContent() {
  $('#content-modal').classList.add('hidden');
}

function resetContentProgress() {
  $('#content-progress-wrap').classList.remove('hidden');
  const bar = $('#content-progress-bar');
  bar.style.width = '0%';
  bar.classList.remove('indeterminate');
  $('#content-progress-stage').textContent = 'Установка';
  $('#content-progress-file').textContent = '';
  $('#content-progress-percent').textContent = '';
}

function updateContentProgress(payload) {
  if (!payload) return;
  $('#content-progress-wrap').classList.remove('hidden');
  $('#content-progress-stage').textContent = STAGE_LABELS[payload.stage] || payload.stage || 'Контент';
  $('#content-progress-file').textContent = payload.file || '';
  const bar = $('#content-progress-bar');
  if (payload.total > 0) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(100, payload.percent))}%`;
    $('#content-progress-percent').textContent = `${Math.round(payload.percent)}%`;
  } else {
    bar.classList.add('indeterminate');
    $('#content-progress-percent').textContent = '';
  }
}

let contentSearchSeq = 0;

async function searchContent(query) {
  if (!state.contentTargetId) return;
  const seq = ++contentSearchSeq;
  const targetId = state.contentTargetId;
  const kind = state.contentKind;
  const status = $('#content-status');
  status.className = 'status-line';
  status.textContent = `Поиск на Modrinth: ${kind === 'mods' ? 'моды' : kind === 'resourcepacks' ? 'наборы ресурсов' : 'шейдеры'}…`;
  try {
    const res = await window.api.searchContent({ targetId, kind, query });
    if (seq !== contentSearchSeq || targetId !== state.contentTargetId || kind !== state.contentKind) return;
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось выполнить поиск.';
      status.className = 'status-line bad';
      state.contentHits = [];
      renderContentResults();
      return;
    }
    state.contentHits = res.hits || [];
    renderContentResults();
    status.textContent = state.contentHits.length
      ? `Найдено: ${state.contentHits.length}. Установка идёт с зависимостями.`
      : t('content.noResults');
  } catch (err) {
    if (seq !== contentSearchSeq) return;
    status.textContent = err.message || 'Не удалось выполнить поиск.';
    status.className = 'status-line bad';
  }
}

function isContentInstalled(hit) {
  return state.contentItems.some(
    (item) => item.kind === state.contentKind && item.projectId === hit.projectId
  );
}

function renderContentResults() {
  const box = $('#content-results');
  if (!box) return;
  box.textContent = '';
  if (!state.contentHits.length) {
    box.appendChild(el('div', 'pack-empty', t('content.noResults')));
    return;
  }
  for (const hit of state.contentHits) {
    const installed = isContentInstalled(hit);
    const versions = (hit.versions || []).slice(0, 3).join(', ');
    const install = button(
      installed ? t('content.installedBtn') : t('content.install'),
      installed ? 'ghost pack-btn' : 'primary pack-btn',
      () => installContent(hit),
      { disabled: installed || state.contentBusy }
    );
    box.appendChild(
      packCard({
        iconUrl: hit.iconUrl,
        title: hit.title,
        description: hit.description,
        meta: `${formatDownloads(hit.downloads)} загрузок${versions ? ` · ${versions}` : ''}`,
        actions: [install],
      })
    );
  }
}

async function loadContentInstalled() {
  if (!state.contentTargetId) return;
  const targetId = state.contentTargetId;
  try {
    const res = await window.api.listContent(targetId);
    if (targetId !== state.contentTargetId) return;
    if (!res.ok) {
      $('#content-status').textContent = res.error || 'Не удалось загрузить установленный контент';
      $('#content-status').className = 'status-line bad';
      return;
    }
    state.contentItems = res.items || [];
    renderContentInstalled();
    renderContentResults();
  } catch (err) {
    if (targetId === state.contentTargetId) {
      $('#content-status').textContent = err.message || 'Не удалось загрузить установленный контент';
      $('#content-status').className = 'status-line bad';
    }
  }
}

function renderContentInstalled() {
  const box = $('#content-installed');
  if (!box) return;
  box.textContent = '';
  const items = state.contentItems.filter((item) => item.kind === state.contentKind);
  if (!items.length) {
    box.appendChild(el('div', 'pack-empty', t('content.emptyInstalled')));
    return;
  }
  for (const item of items) {
    const update = state.contentUpdates.find((entry) => entry.key === item.key);
    const tags = [];
    if (item.source === 'local') tags.push({ text: 'локальный', className: '' });
    if (update) tags.push({ text: 'обновление', className: 'warn' });
    if (item.exists === false) tags.push({ text: 'файл отсутствует', className: 'warn' });
    const actions = [];
    if (update) {
      actions.push(
        button(t('content.update'), 'primary pack-btn', () => updateContentItem(item), {
          disabled: state.contentBusy,
        })
      );
    }
    actions.push(
      button(t('content.remove'), 'ghost pack-btn danger', () => removeContentItem(item), {
        disabled: state.contentBusy,
      })
    );
    const deps = Array.isArray(item.dependencies) ? item.dependencies.length : 0;
    const metaParts = [item.versionName || '—', item.filename];
    if (deps) metaParts.push(`зависимостей: ${deps}`);
    if (update?.latest?.versionName) metaParts.push(`→ ${update.latest.versionName}`);
    box.appendChild(
      packCard({
        iconUrl: item.iconUrl,
        title: item.title,
        meta: metaParts.join(' · '),
        tags,
        actions,
      })
    );
  }
}

async function installContent(hit) {
  if (state.contentBusy) return;
  const targetId = state.contentTargetId;
  const kind = state.contentKind;
  state.contentBusy = true;
  resetContentProgress();
  const status = $('#content-status');
  status.className = 'status-line';
  status.textContent = `Установка «${hit.title}»…`;
  renderContentResults();
  renderContentInstalled();
  try {
    const res = await window.api.installContent({
      targetId,
      kind,
      projectId: hit.projectId,
      withDependencies: true,
    });
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось установить контент.';
      status.className = 'status-line bad';
      if (res.code === 'JAVA_MISSING') handleLaunchError(res);
      else toast(res.error || 'Не удалось установить контент', true);
      return;
    }
    state.contentItems = res.items || state.contentItems;
    state.contentUpdates = state.contentUpdates.filter((entry) => entry.key !== res.item?.key);
    renderContentInstalled();
    renderContentResults();
    status.className = 'status-line ok';
    status.textContent = `«${hit.title}» установлен${kind === 'mods' ? ' вместе с зависимостями' : ''}.`;
    toast(`Установлено: ${hit.title}`);
  } catch (err) {
    status.textContent = err.message || 'Не удалось установить контент.';
    status.className = 'status-line bad';
    toast(err.message || 'Не удалось установить контент', true);
  } finally {
    state.contentBusy = false;
    renderContentResults();
    renderContentInstalled();
  }
}

async function updateContentItem(item) {
  if (state.contentBusy) return;
  const targetId = state.contentTargetId;
  state.contentBusy = true;
  resetContentProgress();
  const status = $('#content-status');
  status.className = 'status-line';
  status.textContent = `Обновление «${item.title}»…`;
  renderContentInstalled();
  try {
    const res = await window.api.updateContent({ targetId, key: item.key });
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось обновить контент.';
      status.className = 'status-line bad';
      toast(res.error || 'Не удалось обновить контент', true);
      return;
    }
    state.contentItems = res.items || state.contentItems;
    state.contentUpdates = state.contentUpdates.filter((entry) => entry.key !== item.key);
    renderContentInstalled();
    status.className = 'status-line ok';
    status.textContent = `«${item.title}» обновлён.`;
    toast(`Обновлено: ${item.title}`);
  } catch (err) {
    status.textContent = err.message || 'Не удалось обновить контент.';
    status.className = 'status-line bad';
    toast(err.message || 'Не удалось обновить контент', true);
  } finally {
    state.contentBusy = false;
    renderContentInstalled();
  }
}

async function removeContentItem(item) {
  if (state.contentBusy) return;
  if (!confirm(`Удалить «${item.title}» из этого инстанса?`)) return;
  try {
    const res = await window.api.removeContent({ targetId: state.contentTargetId, key: item.key });
    if (!res.ok) {
      toast(res.error || 'Не удалось удалить контент', true);
      return;
    }
    state.contentItems = res.items || [];
    state.contentUpdates = state.contentUpdates.filter((entry) => entry.key !== item.key);
    renderContentInstalled();
    renderContentResults();
    toast(`Удалено: ${item.title}`);
  } catch (err) {
    toast(err.message || 'Не удалось удалить контент', true);
  }
}

async function checkContentUpdates() {
  if (state.contentBusy) return;
  const targetId = state.contentTargetId;
  const status = $('#content-status');
  status.className = 'status-line';
  status.textContent = 'Проверка обновлений контента на Modrinth…';
  try {
    const res = await window.api.checkContentUpdates(targetId);
    if (targetId !== state.contentTargetId) return;
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось проверить обновления.';
      status.className = 'status-line bad';
      return;
    }
    state.contentUpdates = res.updates || [];
    renderContentInstalled();
    status.textContent = state.contentUpdates.length
      ? `Доступно обновлений: ${state.contentUpdates.length}.`
      : 'Все установленные моды, паки и шейдеры обновлены.';
    if (!state.contentUpdates.length) toast('Обновлений контента нет');
  } catch (err) {
    status.textContent = err.message || 'Не удалось проверить обновления.';
    status.className = 'status-line bad';
  }
}

function reportRow(title, detail, tone = '') {
  const row = el('div', 'report-row');
  const main = el('div', 'report-main');
  main.appendChild(el('strong', '', title));
  if (detail) main.appendChild(el('div', 'report-line', detail));
  row.appendChild(main);
  if (tone) row.appendChild(el('span', `report-${tone}`, '●'));
  return row;
}

function renderContentReport(report) {
  const box = $('#content-report');
  box.textContent = '';
  box.classList.remove('hidden');
  const problems =
    (report.conflicts?.length || 0) +
    (report.duplicates?.length || 0) +
    (report.missing?.length || 0);
  box.appendChild(
    el(
      'h4',
      '',
      report.ok
        ? `Конфликтов не найдено · файлов: ${report.files || 0}`
        : `Найдено проблем: ${problems} · файлов: ${report.files || 0}`
    )
  );
  if (report.ok && !report.untracked?.length) {
    box.appendChild(reportRow('Загрузчик и зависимости в порядке.', 'Все обязательные моды найдены.'));
    return;
  }
  for (const conflict of report.conflicts || []) {
    box.appendChild(
      reportRow(
        conflict.message,
        [conflict.type, conflict.file].filter(Boolean).join(' · '),
        conflict.severity === 'error' ? 'bad' : 'warn'
      )
    );
  }
  for (const duplicate of report.duplicates || []) {
    box.appendChild(reportRow(duplicate.message, duplicate.name, 'warn'));
  }
  for (const missing of report.missing || []) {
    box.appendChild(reportRow(`Файл не найден: ${missing.title}`, missing.relPath, 'bad'));
  }
  if (report.untracked?.length) {
    box.appendChild(
      reportRow(
        `Файлов вне учёта лаунчера: ${report.untracked.length}`,
        report.untracked.slice(0, 6).map((item) => item.name).join(', '),
        'warn'
      )
    );
  }
}

async function checkContentConflicts() {
  if (!state.contentTargetId) return;
  const targetId = state.contentTargetId;
  const status = $('#content-status');
  status.className = 'status-line';
  status.textContent = 'Анализ зависимостей и конфликтов…';
  try {
    const res = await window.api.getContentConflicts(targetId);
    if (targetId !== state.contentTargetId) return;
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось проверить конфликты.';
      status.className = 'status-line bad';
      return;
    }
    renderContentReport(res);
    status.textContent = res.ok ? 'Конфликтов не найдено.' : 'Найдены проблемы — откройте отчёт ниже.';
  } catch (err) {
    status.textContent = err.message || 'Не удалось проверить конфликты.';
    status.className = 'status-line bad';
  }
}

async function applyContentImport(res, expectedKind = '') {
  if (!res.ok) {
    if (!res.cancelled) {
      toast(res.error || 'Не удалось импортировать файл', true);
      $('#content-status').textContent = res.error || 'Не удалось импортировать файл';
      $('#content-status').className = 'status-line bad';
    }
    return false;
  }
  state.contentItems = res.items || state.contentItems;
  const kind = expectedKind || res.item?.kind || state.contentKind;
  if (kind !== state.contentKind) {
    state.contentKind = kind;
    $$('#content-tabs .tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.kind === kind));
    renderContentWarning();
  }
  renderContentInstalled();
  renderContentResults();
  $('#content-status').className = 'status-line ok';
  $('#content-status').textContent = `Импортирован файл: ${res.item?.filename || res.item?.title || ''}`;
  toast(`Импортировано: ${res.item?.title || res.item?.filename || 'файл'}`);
  return true;
}

async function importContentFile() {
  if (!state.contentTargetId) {
    toast('Сначала выберите инстанс или модпак', true);
    return;
  }
  const kind = state.contentKind === 'mods' ? '' : state.contentKind;
  try {
    const res = await window.api.importContent({ targetId: state.contentTargetId, kind });
    await applyContentImport(res, kind);
  } catch (err) {
    toast(err.message || 'Не удалось импортировать файл', true);
  }
}

function updateMaintenanceTargetUi() {
  const id = state.maintenanceVersionId;
  const info = id ? describeTarget(id) : null;
  $('#maintenance-target').textContent = info
    ? `${info.label} · ${info.type}${id.startsWith('instance:') || id.startsWith('modpack:') ? ` · ${id}` : ''}`
    : 'Цель не выбрана';
  const managed = isManagedTarget(id);
  const loader = targetLoader(id);
  $('#maintenance-reset').disabled = !managed;
  $('#maintenance-backup').disabled = !managed;
  $('#maintenance-loader').disabled = loader === 'vanilla';
  $('#maintenance-keep-worlds').disabled = !managed;
}

async function openMaintenance(targetId) {
  state.maintenanceVersionId = String(targetId || selectedPlayTarget() || '');
  $('#maintenance-modal').classList.remove('hidden');
  $('#maintenance-progress-wrap').classList.add('hidden');
  $('#maintenance-report').classList.add('hidden');
  $('#maintenance-report').textContent = '';
  $('#maintenance-disk-output').textContent = '';
  updateMaintenanceTargetUi();
  await loadBackups();
}

function closeMaintenance() {
  $('#maintenance-modal').classList.add('hidden');
}

function beginMaintenance(label) {
  state.maintenanceBusy = true;
  $$('#maintenance-modal .btn').forEach((node) => {
    if (!node.closest('.modal-head')) node.disabled = true;
  });
  const wrap = $('#maintenance-progress-wrap');
  wrap.classList.remove('hidden');
  const bar = $('#maintenance-progress-bar');
  bar.style.width = '0%';
  bar.classList.add('indeterminate');
  $('#maintenance-progress-stage').textContent = label;
  $('#maintenance-progress-file').textContent = '';
  $('#maintenance-progress-percent').textContent = '';
  $('#maintenance-report').classList.add('hidden');
  $('#maintenance-report').textContent = '';
}

function endMaintenance() {
  state.maintenanceBusy = false;
  $$('#maintenance-modal .btn').forEach((node) => {
    if (!node.closest('.modal-head')) node.disabled = false;
  });
  updateMaintenanceTargetUi();
  $('#maintenance-progress-wrap').classList.add('hidden');
}

function updateMaintenanceProgress(payload) {
  if (!payload) return;
  const wrap = $('#maintenance-progress-wrap');
  wrap.classList.remove('hidden');
  $('#maintenance-progress-stage').textContent = STAGE_LABELS[payload.stage] || payload.stage || 'Обслуживание';
  $('#maintenance-progress-file').textContent = payload.file || '';
  const bar = $('#maintenance-progress-bar');
  if (payload.total > 0) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(100, payload.percent))}%`;
    $('#maintenance-progress-percent').textContent = `${Math.round(payload.percent)}%`;
  } else {
    bar.classList.add('indeterminate');
    $('#maintenance-progress-percent').textContent = '';
  }
}

function showMaintenanceReport(heading, rows = []) {
  const box = $('#maintenance-report');
  box.textContent = '';
  box.classList.remove('hidden');
  box.appendChild(el('h4', '', heading));
  if (!rows.length) {
    box.appendChild(reportRow('Готово.', '', 'ok'));
    return;
  }
  for (const row of rows) box.appendChild(reportRow(row.title, row.detail, row.tone));
}

function maintenanceFailure(message) {
  showMaintenanceReport('Операция не выполнена', [{ title: message, tone: 'bad' }]);
  toast(message, true);
}

function verifyRows(summary) {
  if (!summary) return [];
  const rows = [];
  const target = summary.target || {};
  rows.push({
    title: `Проверено файлов: ${summary.checked || 0}`,
    detail: `${target.name || target.id || ''} · ${formatBytes(summary.checkedBytes || 0)} · ${Math.round((summary.durationMs || 0) / 100) / 10} с`,
  });
  if (summary.missing) {
    rows.push({ title: `Отсутствует файлов: ${summary.missing}`, tone: 'bad' });
  }
  if (summary.corrupt) {
    rows.push({ title: `Повреждено файлов: ${summary.corrupt}`, tone: 'bad' });
  }
  for (const issue of (summary.issues || []).slice(0, 30)) {
    rows.push({
      title: `${issue.type === 'hash' ? 'Повреждён' : 'Отсутствует'}: ${issue.label || issue.path}`,
      detail: issue.path,
      tone: issue.type === 'hash' ? 'warn' : 'bad',
    });
  }
  if (summary.issueCount > 30) {
    rows.push({ title: `…и ещё ${summary.issueCount - 30} проблем`, tone: 'warn' });
  }
  return rows;
}

async function runVerify() {
  if (state.maintenanceBusy) return;
  if (!state.maintenanceVersionId) {
    toast('Сначала выберите цель', true);
    return;
  }
  beginMaintenance('Проверка файлов…');
  try {
    const res = await window.api.verifyFiles(state.maintenanceVersionId);
    if (!res.ok) {
      maintenanceFailure(res.error || 'Не удалось проверить файлы');
      return;
    }
    const summary = res.summary;
    showMaintenanceReport(
      summary.ok ? 'Все файлы на месте.' : `Найдено проблем: ${summary.issueCount || 0}`,
      verifyRows(summary)
    );
    if (summary.ok) toast('Проверка завершена: файлы в порядке');
    else toast(`Найдено проблем: ${summary.issueCount || 0}`, true);
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось проверить файлы');
  } finally {
    endMaintenance();
  }
}

async function runRepair() {
  if (state.maintenanceBusy) return;
  if (!state.maintenanceVersionId) {
    toast('Сначала выберите цель', true);
    return;
  }
  beginMaintenance('Восстановление файлов…');
  try {
    const res = await window.api.repairFiles(state.maintenanceVersionId);
    if (!res.ok) {
      maintenanceFailure(res.error || 'Не удалось восстановить файлы');
      return;
    }
    const rows = [
      {
        title: `Восстановлено файлов: ${res.repaired || 0}`,
        detail: `После ремонта проверено: ${res.summary?.checked || 0} · проблем: ${res.summary?.issueCount || 0}`,
        tone: res.ok ? 'ok' : 'warn',
      },
    ];
    for (const failure of res.failed || []) {
      rows.push({ title: `Не удалось: ${failure.label}`, detail: failure.error, tone: 'bad' });
    }
    rows.push(...verifyRows(res.summary));
    showMaintenanceReport(res.ok ? 'Файлы восстановлены.' : 'Восстановление завершено с проблемами.', rows);
    toast(res.ok ? 'Файлы восстановлены' : 'Часть файлов не удалось восстановить', !res.ok);
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось восстановить файлы');
  } finally {
    endMaintenance();
  }
}

async function runLoaderReinstall() {
  if (state.maintenanceBusy) return;
  if (!state.maintenanceVersionId) return;
  if (!confirm('Переустановить загрузчик для выбранной цели?')) return;
  beginMaintenance('Переустановка загрузчика…');
  try {
    const res = await window.api.reinstallLoader(state.maintenanceVersionId);
    if (!res.ok) {
      if (res.code === 'JAVA_MISSING') handleLaunchError(res);
      maintenanceFailure(res.error || 'Не удалось переустановить загрузчик');
      return;
    }
    showMaintenanceReport('Загрузчик переустановлен.', [
      { title: `${res.loader || 'Загрузчик'} ${res.loaderVersion || ''}`, detail: `Профиль: ${res.profileId}` },
    ]);
    toast('Загрузчик переустановлен');
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось переустановить загрузчик');
  } finally {
    endMaintenance();
  }
}

async function runReset() {
  if (state.maintenanceBusy) return;
  if (!isManagedTarget(state.maintenanceVersionId)) return;
  if (!confirm(t('maintenance.resetConfirm'))) return;
  const keepWorlds = $('#maintenance-keep-worlds').checked;
  beginMaintenance('Сброс инстанса…');
  try {
    const res = await window.api.resetInstance(state.maintenanceVersionId, { keepWorlds });
    if (!res.ok) {
      maintenanceFailure(res.error || 'Не удалось сбросить инстанс');
      return;
    }
    showMaintenanceReport('Инстанс сброшен.', [
      { title: `Освобождено: ${formatBytes(res.freed || 0)}`, detail: res.keptWorlds ? 'Миры сохранены.' : 'Миры удалены.', tone: 'ok' },
    ]);
    toast('Инстанс сброшен');
    if (!$('#content-modal').classList.contains('hidden')) loadContentInstalled().catch(() => {});
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось сбросить инстанс');
  } finally {
    endMaintenance();
  }
}

async function runCrashAnalysis() {
  if (!state.maintenanceVersionId) {
    toast('Сначала выберите цель', true);
    return;
  }
  try {
    const res = await window.api.analyzeCrash(state.maintenanceVersionId);
    if (!res.ok) {
      toast(res.error || 'Не удалось проанализировать краш', true);
      return;
    }
    showCrash(res.analysis);
  } catch (err) {
    toast(err.message || 'Не удалось проанализировать краш', true);
  }
}

async function runCleanup() {
  if (state.maintenanceBusy) return;
  const days = Number($('#cleanup-days').value) || state.config.cleanupDays || 7;
  if (!confirm(`Удалить логи, отчёты и .part-файлы старше ${days} дн.?`)) return;
  beginMaintenance('Очистка старых файлов…');
  try {
    const res = await window.api.cleanupFiles({ days });
    if (!res.ok) {
      maintenanceFailure(res.error || 'Не удалось выполнить очистку');
      return;
    }
    const rows = [
      { title: `Удалено файлов: ${res.removed || 0}`, detail: `Освобождено: ${formatBytes(res.freed || 0)}`, tone: 'ok' },
    ];
    for (const item of (res.items || []).slice(0, 40)) {
      rows.push({ title: String(item).split(/[\\/]/).pop(), detail: String(item) });
    }
    if ((res.items || []).length > 40) rows.push({ title: `…и ещё ${res.items.length - 40} файлов` });
    showMaintenanceReport('Очистка завершена.', rows);
    toast(`Очистка: удалено ${res.removed || 0} файлов`);
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось выполнить очистку');
  } finally {
    endMaintenance();
  }
}

function renderDiskUsage(data) {
  const box = $('#maintenance-disk-output');
  box.textContent = '';
  const categories = [...(data.categories || [])].sort((a, b) => b.size - a.size);
  const total = Math.max(1, data.total || categories.reduce((sum, item) => sum + item.size, 0));
  for (const category of categories) {
    const row = el('div', 'disk-row');
    const head = el('div', 'disk-row-head');
    head.append(el('span', '', category.name), el('span', '', formatBytes(category.size)));
    const track = el('div', 'disk-bar');
    const fill = el('div', 'disk-fill');
    fill.style.width = `${Math.max(category.size ? 2 : 0, Math.round((category.size / total) * 100))}%`;
    fill.style.opacity = category.exists ? '1' : '0.35';
    track.appendChild(fill);
    row.append(head, track);
    box.appendChild(row);
  }
  box.appendChild(el('div', 'disk-row-head', `Всего: ${formatBytes(data.total || 0)}`));
}

async function loadDiskUsage() {
  try {
    const res = await window.api.getDiskUsage();
    if (!res.ok) {
      toast(res.error || 'Не удалось посчитать диск', true);
      return;
    }
    renderDiskUsage(res);
  } catch (err) {
    toast(err.message || 'Не удалось посчитать диск', true);
  }
}

async function loadBackups() {
  try {
    const res = await window.api.getBackups();
    if (!res.ok) {
      toast(res.error || 'Не удалось загрузить бэкапы', true);
      return;
    }
    state.backups = res.backups || [];
    renderBackups();
  } catch (err) {
    toast(err.message || 'Не удалось загрузить бэкапы', true);
  }
}

function renderBackups() {
  const box = $('#maintenance-backups');
  if (!box) return;
  box.textContent = '';
  if (!state.backups.length) {
    box.appendChild(el('div', 'pack-empty', t('maintenance.noBackups')));
    return;
  }
  const managed = isManagedTarget(state.maintenanceVersionId);
  for (const backup of state.backups) {
    const row = el('div', 'backup-row');
    row.appendChild(el('div', 'backup-name', backup.name));
    const meta = el('div', 'backup-meta');
    meta.appendChild(el('span', '', `${formatBytes(backup.size)} · ${formatDateTime(new Date(backup.mtime).toISOString())}`));
    const actions = el('div', 'backup-actions');
    actions.appendChild(
      miniLink(t('maintenance.restore'), () => restoreBackup(backup.name), '', !managed)
    );
    actions.appendChild(miniLink(t('maintenance.delete'), () => deleteBackup(backup.name), 'danger'));
    meta.appendChild(actions);
    row.appendChild(meta);
    box.appendChild(row);
  }
}

async function createBackup() {
  if (state.maintenanceBusy || !isManagedTarget(state.maintenanceVersionId)) return;
  beginMaintenance('Создание бэкапа…');
  try {
    const res = await window.api.createBackup(state.maintenanceVersionId, { includeWorlds: true });
    if (!res.ok) {
      maintenanceFailure(res.error || 'Не удалось создать бэкап');
      return;
    }
    state.backups = res.backups || state.backups;
    renderBackups();
    showMaintenanceReport('Бэкап создан.', [
      { title: res.name, detail: `${formatBytes(res.size || 0)} · миры включены: ${res.includeWorlds ? 'да' : 'нет'}`, tone: 'ok' },
    ]);
    toast(`Бэкап создан: ${formatBytes(res.size || 0)}`);
    await loadBackups();
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось создать бэкап');
  } finally {
    endMaintenance();
  }
}

async function restoreBackup(name) {
  if (state.maintenanceBusy) return;
  if (!isManagedTarget(state.maintenanceVersionId)) {
    toast('Восстановление доступно только для инстанса или модпака', true);
    return;
  }
  if (!confirm(`Восстановить бэкап ${name}? Текущие файлы модов и конфигов будут заменены.`)) return;
  beginMaintenance('Восстановление бэкапа…');
  try {
    const res = await window.api.restoreBackup(state.maintenanceVersionId, name);
    if (!res.ok) {
      maintenanceFailure(res.error || 'Не удалось восстановить бэкап');
      return;
    }
    showMaintenanceReport('Бэкап восстановлен.', [
      { title: res.name, detail: `Файлов восстановлено: ${res.restored || 0}`, tone: 'ok' },
    ]);
    toast(`Бэкап восстановлен: файлов ${res.restored || 0}`);
    if (!$('#content-modal').classList.contains('hidden')) loadContentInstalled().catch(() => {});
  } catch (err) {
    maintenanceFailure(err.message || 'Не удалось восстановить бэкап');
  } finally {
    endMaintenance();
  }
}

async function deleteBackup(name) {
  if (!confirm(`Удалить бэкап ${name}?`)) return;
  try {
    const res = await window.api.deleteBackup(name);
    if (!res.ok) {
      toast(res.error || 'Не удалось удалить бэкап', true);
      return;
    }
    state.backups = res.backups || [];
    renderBackups();
    toast('Бэкап удалён');
  } catch (err) {
    toast(err.message || 'Не удалось удалить бэкап', true);
  }
}

function showCrash(analysis) {
  if (!analysis) return;
  $('#crash-file').textContent = analysis.file || 'Файл не найден';
  $('#crash-summary').textContent = analysis.summary || 'Анализ недоступен.';
  const causes = $('#crash-causes');
  causes.textContent = '';
  for (const cause of analysis.causes || []) {
    const card = el('div', 'cause-card');
    card.appendChild(el('strong', '', cause.title));
    card.appendChild(el('p', '', cause.advice));
    causes.appendChild(card);
  }
  if (!analysis.causes?.length) {
    causes.appendChild(el('div', 'pack-empty', 'Явных причин не найдено.'));
  }
  $('#crash-excerpt').textContent = analysis.excerpt || 'Лог пуст.';
  $('#crash-modal').classList.remove('hidden');
}

function closeCrash() {
  $('#crash-modal').classList.add('hidden');
}

async function patchConfig(patch, { quiet = false } = {}) {
  try {
    state.config = await window.api.setConfig(patch);
    return state.config;
  } catch (err) {
    if (!quiet) toast(err.message || 'Не удалось сохранить настройки', true);
    return state.config;
  }
}

function renderDiagnostics(results) {
  const box = $('#net-results');
  box.textContent = '';
  const status = $('#net-status');
  const okCount = results.filter((item) => item.ok).length;
  status.textContent = `Проверено узлов: ${results.length}, доступно: ${okCount}.`;
  status.className = okCount === results.length ? 'status-line ok' : 'status-line';
  for (const item of results) {
    const row = el('div', 'diag-row');
    row.appendChild(el('span', `diag-dot ${item.ok ? 'ok' : 'bad'}`.trim()));
    const name = el('div', 'diag-name');
    name.appendChild(el('div', '', item.name || item.host));
    name.appendChild(
      el('div', 'diag-ms', [item.host, item.ip, item.url].filter(Boolean).slice(0, 2).join(' · '))
    );
    row.appendChild(name);
    row.appendChild(
      el('span', 'diag-ms', item.ok ? `${item.ms} мс · HTTP ${item.status}` : item.error || 'Недоступно')
    );
    box.appendChild(row);
  }
}

async function runNetworkDiagnostics() {
  const status = $('#net-status');
  const box = $('#net-results');
  status.textContent = 'Проверка соединения…';
  status.className = 'status-line';
  box.textContent = '';
  try {
    const res = await window.api.runDiagnostics();
    if (!res.ok) {
      status.textContent = res.error || 'Не удалось выполнить диагностику';
      status.className = 'status-line bad';
      return;
    }
    renderDiagnostics(res.results || []);
  } catch (err) {
    status.textContent = err.message || 'Не удалось выполнить диагностику';
    status.className = 'status-line bad';
  }
}

function renderUpdateStatus(text, bad = false) {
  const status = $('#update-status');
  if (!status) return;
  status.textContent = text;
  status.className = bad ? 'status-line bad' : 'status-line';
}

function setUpdateControls() {
  const downloading = state.updateBusy;
  const available = Boolean(state.updateInfo?.hasUpdate);
  const downloaded = Boolean(state.updateFile);
  $('#update-download').classList.toggle('hidden', !available || downloaded);
  $('#update-download').disabled = downloading;
  $('#update-install').classList.toggle('hidden', !downloaded);
  $('#update-banner-download').classList.toggle('hidden', !available || downloaded);
  $('#update-banner-download').disabled = downloading;
  $('#update-banner-install').classList.toggle('hidden', !downloaded);
}

function updateBannerProgress(payload) {
  const wrap = $('#update-banner-progress');
  wrap.classList.remove('hidden');
  const bar = $('#update-progress-bar');
  if (payload?.total > 0) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(100, payload.percent || 0))}%`;
    $('#update-progress-percent').textContent = `${Math.round(payload.percent || 0)}%`;
  } else {
    bar.classList.add('indeterminate');
    $('#update-progress-percent').textContent = '';
  }
  $('#update-progress-stage').textContent = t('update.downloading');
  renderUpdateStatus(`${t('update.downloading')} ${payload?.percent ? `${Math.round(payload.percent)}%` : ''}`.trim());
}

function showUpdateBanner(info) {
  if (!info?.hasUpdate) return;
  $('#update-title').textContent = t('update.available', { version: info.latest });
  $('#update-notes').textContent = String(info.notes || '').slice(0, 320);
  $('#update-banner-progress').classList.add('hidden');
  $('#update-banner').classList.remove('hidden');
  state.updateInfo = info;
  setUpdateControls();
}

function hideUpdateBanner() {
  $('#update-banner').classList.add('hidden');
}

function handleUpdateAvailable(info) {
  if (!info) return;
  state.updateInfo = info;
  showUpdateBanner(info);
  renderUpdateStatus(
    `Доступна версия ${info.latest} (установлена ${info.current}).`
  );
  setUpdateControls();
}

function handleUpdateChecked(info) {
  if (!info) return;
  if (info.ok === false) {
    renderUpdateStatus(info.error || 'Не удалось проверить обновления', true);
    return;
  }
  state.updateInfo = info;
  if (info.hasUpdate) {
    showUpdateBanner(info);
    renderUpdateStatus(`Доступна версия ${info.latest}.`);
  } else {
    renderUpdateStatus(`Обновлений нет. Установлена версия ${info.current || ''}.`);
  }
  setUpdateControls();
}

async function checkForUpdates(manual = false) {
  if (state.updateBusy) return;
  if (manual) {
    renderUpdateStatus('Проверка обновлений…');
    if (!state.config.updateFeedUrl) {
      renderUpdateStatus('Сначала укажите канал обновлений.', true);
      toast('Сначала укажите канал обновлений', true);
      return;
    }
  }
  try {
    const res = await window.api.checkUpdates();
    if (!res.ok) {
      renderUpdateStatus(res.error || 'Не удалось проверить обновления', true);
      if (manual) toast(res.error || 'Не удалось проверить обновления', true);
      return;
    }
    state.updateInfo = res.update;
    if (res.update.hasUpdate) {
      showUpdateBanner(res.update);
      renderUpdateStatus(`Доступна версия ${res.update.latest} (установлена ${res.update.current}).`);
      toast(`Доступно обновление ${res.update.latest}`);
    } else {
      renderUpdateStatus(`Обновлений нет. Установлена версия ${res.update.current}.`);
      if (manual) toast('Обновлений нет');
    }
    setUpdateControls();
  } catch (err) {
    renderUpdateStatus(err.message || 'Не удалось проверить обновления', true);
    if (manual) toast(err.message || 'Не удалось проверить обновления', true);
  }
}

async function downloadUpdate() {
  if (state.updateBusy) return;
  state.updateBusy = true;
  setUpdateControls();
  const wrap = $('#update-banner-progress');
  wrap.classList.remove('hidden');
  $('#update-progress-bar').classList.remove('indeterminate');
  $('#update-progress-bar').style.width = '0%';
  $('#update-progress-percent').textContent = '';
  renderUpdateStatus(t('update.downloading'));
  try {
    const res = await window.api.downloadUpdate();
    if (!res.ok) {
      renderUpdateStatus(res.error || 'Не удалось скачать обновление', true);
      toast(res.error || 'Не удалось скачать обновление', true);
      return;
    }
    state.updateFile = res.path || '';
    renderUpdateStatus(`${t('update.ready')} ${formatBytes(res.size || 0)}`);
    toast('Обновление скачано');
  } catch (err) {
    renderUpdateStatus(err.message || 'Не удалось скачать обновление', true);
    toast(err.message || 'Не удалось скачать обновление', true);
  } finally {
    state.updateBusy = false;
    setUpdateControls();
  }
}

async function installUpdate() {
  if (!state.updateFile) return;
  if (!confirm('Запустить установщик обновления? Лаунчер будет закрыт.')) return;
  try {
    const res = await window.api.installUpdate();
    if (!res.ok) {
      toast(res.error || 'Не удалось запустить установщик', true);
      return;
    }
    toast('Установщик запущен. Лаунчер закрывается…');
  } catch (err) {
    toast(err.message || 'Не удалось запустить установщик', true);
  }
}

async function refreshDiscordStatus() {
  const status = $('#discord-status');
  if (!status) return;
  try {
    const res = await window.api.getDiscordStatus();
    if (!res.ok) {
      status.textContent = res.error || t('settings.discordError');
      status.className = 'status-line bad';
      return;
    }
    if (!res.clientId) {
      status.textContent = t('settings.discordNoId');
      status.className = 'status-line bad';
    } else if (res.connected) {
      status.textContent = res.builtin
        ? t('settings.discordConnectedBuiltin')
        : t('settings.discordConnected');
      status.className = 'status-line ok';
    } else {
      status.textContent = t('settings.discordWaiting');
      status.className = 'status-line';
    }
  } catch (err) {
    status.textContent = err.message || t('settings.discordError');
    status.className = 'status-line bad';
  }
}

function setDiscordActivityForLaunch(versionId) {
  const info = describeTarget(versionId);
  window.api
    .setDiscordActivity({
      details: `Minecraft ${info.label}`.slice(0, 128),
      state: 'Играет',
      startTimestamp: Date.now(),
    })
    .catch(() => {});
}

function setDiscordActivityIdle() {
  window.api
    .setDiscordActivity({ details: 'В лаунчере', state: 'MineLauncher', startTimestamp: Date.now() })
    .catch(() => {});
}

function setSyncStatus(text, bad = false) {
  const status = $('#sync-status');
  status.textContent = text;
  status.className = bad ? 'status-line bad' : 'status-line';
}

async function exportSettings() {
  setSyncStatus('Экспорт настроек…');
  try {
    const res = await window.api.exportSettings();
    if (!res.ok) {
      if (!res.cancelled) setSyncStatus(res.error || 'Не удалось экспортировать настройки', true);
      return;
    }
    setSyncStatus(`Настройки сохранены: ${res.path}`);
    toast('Настройки экспортированы');
  } catch (err) {
    setSyncStatus(err.message || 'Не удалось экспортировать настройки', true);
  }
}

async function importSettings() {
  setSyncStatus('Импорт настроек…');
  try {
    const res = await window.api.importSettings();
    if (!res.ok) {
      if (!res.cancelled) setSyncStatus(res.error || 'Не удалось импортировать настройки', true);
      return;
    }
    state.config = res.config || (await window.api.getConfig());
    applyConfig();
    applyLanguage(state.config.language);
    applyTheme(state.config.theme, state.config.accent);
    setSyncStatus(`Импортировано настроек: ${res.applied?.length || 0}.`);
    toast('Настройки импортированы');
    renderAllDynamic();
  } catch (err) {
    setSyncStatus(err.message || 'Не удалось импортировать настройки', true);
  }
}

async function exportWorlds() {
  const targetId = selectedPlayTarget();
  if (!isManagedTarget(targetId)) {
    setSyncStatus('Экспорт миров доступен только для инстанса или модпака.', true);
    return;
  }
  setSyncStatus('Экспорт миров…');
  try {
    const res = await window.api.exportWorlds(targetId);
    if (!res.ok) {
      if (!res.cancelled) setSyncStatus(res.error || 'Не удалось экспортировать миры', true);
      return;
    }
    setSyncStatus(`Миры «${res.target}» сохранены: ${formatBytes(res.size || 0)}.`);
    toast('Миры экспортированы');
  } catch (err) {
    setSyncStatus(err.message || 'Не удалось экспортировать миры', true);
  }
}

async function importWorlds() {
  const targetId = selectedPlayTarget();
  if (!isManagedTarget(targetId)) {
    setSyncStatus('Импорт миров доступен только для инстанса или модпака.', true);
    return;
  }
  if (!confirm(`Импортировать миры в «${describeTarget(targetId).label}»? Одноимённые файлы будут заменены.`)) {
    return;
  }
  setSyncStatus('Импорт миров…');
  try {
    const res = await window.api.importWorlds(targetId);
    if (!res.ok) {
      if (!res.cancelled) setSyncStatus(res.error || 'Не удалось импортировать миры', true);
      return;
    }
    setSyncStatus(`В «${res.target}» восстановлено файлов: ${res.restored}.`);
    toast(`Миры импортированы: файлов ${res.restored}`);
  } catch (err) {
    setSyncStatus(err.message || 'Не удалось импортировать миры', true);
  }
}

function renderAllDynamic() {
  if (!state.config) return;
  updatePlayButton();
  updateVersionBadges();
  refreshAccountUi();
  renderVersionOptions();
  renderInstances();
  renderInstancesModpacks();
  renderServerTargetsIfNeeded();
  renderContentTargetOptions();
  renderContentInstalled();
  renderContentResults();
  renderServers();
  renderStats();
  renderBackups();
  setUpdateControls();
  updateModpackStatus();
  refreshDiscordStatus();
}

function renderServerTargetsIfNeeded() {
  // Server cards store rendered text; refresh only when the page is visible.
  if ($('#page-servers')?.classList.contains('active')) renderServers();
}

function bindDragAndDrop() {
  const overlay = $('#drop-overlay');
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    state.dropDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    state.dropDepth = Math.max(0, state.dropDepth - 1);
    if (!state.dropDepth) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    state.dropDepth = 0;
    overlay.classList.add('hidden');
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) await importDroppedFiles(files);
  });
}

async function importDroppedFiles(files) {
  let targetId = state.contentTargetId;
  if ($('#content-modal').classList.contains('hidden')) targetId = selectedPlayTarget();
  if (!targetId) {
    toast('Сначала выберите версию, инстанс или модпак', true);
    return;
  }
  if ($('#content-modal').classList.contains('hidden')) {
    await openContent(targetId);
  }
  targetId = state.contentTargetId;
  if (!targetId) {
    toast('Нет доступной цели для импорта', true);
    return;
  }

  let imported = 0;
  for (const file of files) {
    const filePath = window.api.getFilePath(file);
    if (!filePath) continue;
    const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    let kind = '';
    if (ext === '.jar') kind = 'mods';
    else if (state.contentKind !== 'mods') kind = state.contentKind;
    try {
      const res = await window.api.importContent({ targetId, kind, filePath });
      if (await applyContentImport(res, kind)) imported++;
    } catch (err) {
      toast(err.message || `Не удалось импортировать ${file.name}`, true);
    }
  }
  if (imported) {
    toast(`Импортировано файлов: ${imported}`);
    await loadContentInstalled();
  } else {
    toast('Файлы не импортированы: поддерживаются .jar и .zip', true);
  }
}

function bindEvents() {
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => switchPage(item.dataset.page));
  });
  $('#user-chip').addEventListener('click', () => switchPage('account'));

  $('#win-min').addEventListener('click', () => window.api.window.minimize());
  $('#win-max').addEventListener('click', () => window.api.window.maximize());
  $('#win-close').addEventListener('click', () => window.api.window.close());

  $('#play-btn').addEventListener('click', onPlay);
  $('#refresh-versions').addEventListener('click', () => loadVersions(true));
  $('#open-modpacks').addEventListener('click', openModpacks);
  $('#play-content').addEventListener('click', () => openContent(selectedPlayTarget()));
  $('#play-maintenance').addEventListener('click', () => openMaintenance(selectedPlayTarget()));

  $('#ram-range').addEventListener('input', updateRamUi);
  $('#ram-range').addEventListener('change', () => {
    patchConfig({ ramMb: Number($('#ram-range').value) });
  });

  const saveUsername = debounce((value) => {
    if (state.config.accountType === 'microsoft') return;
    patchConfig({ username: value }).then(refreshAccountUi);
  }, 450);

  $('#play-username').addEventListener('input', (event) => {
    if (state.config.accountType === 'microsoft') return;
    const value = event.target.value.trim().slice(0, 16) || 'Player';
    $('#account-username').value = value;
    saveUsername(value);
  });

  $('#version-select').addEventListener('change', (event) => {
    updateVersionBadges();
    patchConfig({ selectedVersion: event.target.value });
    hideError();
    refreshJava();
  });

  $('#account-username').addEventListener('input', (event) => {
    if (state.config.accountType === 'microsoft') return;
    $('#play-username').value = event.target.value.trim().slice(0, 16) || 'Player';
  });

  $('#save-offline').addEventListener('click', async () => {
    const name = $('#account-username').value.trim().slice(0, 16) || 'Player';
    try {
      const res = await window.api.offlineLogin(name);
      if (!res.ok) {
        toast(res.error || 'Ошибка', true);
        return;
      }
      state.config.accountType = 'offline';
      state.config.msProfile = null;
      state.config.username = res.account.name;
      $('#play-username').value = res.account.name;
      refreshAccountUi();
      toast(`Офлайн-ник: ${res.account.name}`);
    } catch (err) {
      toast(err.message || 'Ошибка', true);
    }
  });

  $('#ms-login').addEventListener('click', onMsLogin);
  $('#ms-logout').addEventListener('click', async () => {
    try {
      await window.api.logout();
      state.config.accountType = 'offline';
      state.config.msProfile = null;
      refreshAccountUi();
      toast('Вы вышли из аккаунта Microsoft');
    } catch (err) {
      toast(err.message || 'Не удалось выйти из аккаунта', true);
    }
  });

  $('#ms-client-id').addEventListener('change', (event) => {
    patchConfig({ msClientId: event.target.value.trim() });
  });

  $('#device-open').addEventListener('click', (event) => {
    const uri = event.currentTarget.dataset.uri;
    if (uri) window.api.openLink(uri);
  });
  $('#device-cancel').addEventListener('click', async () => {
    $('#device-hint').textContent = 'Отмена…';
    await window.api.msCancel().catch(() => {});
  });

  $('#java-detect').addEventListener('click', async () => {
    await patchConfig({ javaPath: $('#java-path').value.trim() });
    await refreshJava();
    toast('Проверка Java завершена');
  });
  $('#java-install').addEventListener('click', () => installJavaForSelectedVersion());
  $('#java-cta').addEventListener('click', () => installJavaForSelectedVersion());
  $('#java-path').addEventListener('change', async (event) => {
    await patchConfig({ javaPath: event.target.value.trim() });
    refreshJava();
  });

  $('#game-dir').addEventListener('change', async (event) => {
    await patchConfig({ gameDir: event.target.value.trim() });
    $('#game-dir').value = state.config.gameDir;
    refreshJava();
    loadInstances().catch(() => {});
  });
  $('#open-folder').addEventListener('click', () => window.api.openFolder('game'));
  $('#open-logs').addEventListener('click', () => window.api.openFolder('logs'));
  $('#log-open').addEventListener('click', () => window.api.openFolder('logs'));
  $('#jvm-args').addEventListener('change', (event) => {
    patchConfig({ jvmArgs: event.target.value.trim() });
  });
  $('#show-snapshots').addEventListener('change', (event) => {
    patchConfig({ showSnapshots: event.target.checked }).then(() => renderVersionOptions());
  });
  $('#custom-resolution').addEventListener('change', (event) => {
    $('#res-inputs').classList.toggle('hidden', !event.target.checked);
    patchConfig({ customResolution: event.target.checked });
  });
  $('#res-width').addEventListener('change', (event) => {
    patchConfig({ width: Number(event.target.value) || 1280 });
  });
  $('#res-height').addEventListener('change', (event) => {
    patchConfig({ height: Number(event.target.value) || 720 });
  });

  $('#theme-select').addEventListener('change', async (event) => {
    await patchConfig({ theme: event.target.value });
    applyTheme(state.config.theme, state.config.accent);
  });
  $('#language-select').addEventListener('change', async (event) => {
    await patchConfig({ language: event.target.value });
    applyLanguage(state.config.language);
  });
  $$('.accent-swatch').forEach((swatch) => {
    swatch.addEventListener('click', async () => {
      await patchConfig({ accent: swatch.dataset.accent });
      applyTheme(state.config.theme, state.config.accent);
    });
  });

  $('#speed-limit').addEventListener('change', (event) => {
    patchConfig({ speedLimitKbps: Number(event.target.value) || 0 });
  });
  $('#mirror-mode').addEventListener('change', (event) => {
    patchConfig({ mirrorMode: event.target.value });
  });
  $('#proxy-mode').addEventListener('change', (event) => {
    $('#proxy-row').classList.toggle('hidden', event.target.value !== 'manual');
    patchConfig({ proxyMode: event.target.value });
  });
  const saveProxy = debounce((value) => patchConfig({ proxyUrl: value }), 700);
  $('#proxy-url').addEventListener('input', (event) => saveProxy(event.target.value.trim()));
  $('#net-diagnostics').addEventListener('click', runNetworkDiagnostics);

  $('#auto-update').addEventListener('change', (event) => {
    patchConfig({ autoUpdateCheck: event.target.checked });
  });
  const saveFeed = debounce((value) => patchConfig({ updateFeedUrl: value }), 700);
  $('#update-feed').addEventListener('input', (event) => saveFeed(event.target.value.trim()));
  $('#update-check').addEventListener('click', () => checkForUpdates(true));
  $('#update-download').addEventListener('click', downloadUpdate);
  $('#update-install').addEventListener('click', installUpdate);

  $('#discord-portal').addEventListener('click', () => {
    window.api.openLink('https://discord.com/developers/applications');
  });
  const saveDiscordId = debounce((value) => {
    patchConfig({ discordClientId: value }).then(refreshDiscordStatus);
  }, 600);
  $('#discord-client-id').addEventListener('input', (event) => saveDiscordId(event.target.value.trim()));

  $('#sync-export-settings').addEventListener('click', exportSettings);
  $('#sync-import-settings').addEventListener('click', importSettings);
  $('#sync-export-worlds').addEventListener('click', exportWorlds);
  $('#sync-import-worlds').addEventListener('click', importWorlds);

  $('#cleanup-days').addEventListener('change', (event) => {
    patchConfig({ cleanupDays: Math.max(1, Number(event.target.value) || 7) });
  });
  $('#backup-retention').addEventListener('change', (event) => {
    patchConfig({ backupRetention: Math.max(1, Number(event.target.value) || 10) });
  });

  $('#log-clear').addEventListener('click', () => {
    $('#log-output').textContent = '';
  });

  $('#error-action').addEventListener('click', () => {
    const action = state.errorAction;
    if (!action) return;
    if (action.kind === 'java') installJava(action.component, action.major);
  });

  $('#modpack-close').addEventListener('click', closeModpacks);
  $('#modpack-search-btn').addEventListener('click', () =>
    searchModpacks($('#modpack-search').value.trim())
  );
  $('#modpack-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchModpacks(event.currentTarget.value.trim());
  });
  $('#modpack-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModpacks();
  });
  $('#modpack-check-updates').addEventListener('click', checkModpackUpdates);

  $('#instances-refresh').addEventListener('click', async () => {
    await Promise.all([loadInstances(), refreshModpackList()]);
  });
  $('#instance-import').addEventListener('click', importInstance);
  $('#instance-create').addEventListener('click', createInstance);
  $('#instances-modpack-updates').addEventListener('click', checkModpackUpdates);

  $('#servers-refresh').addEventListener('click', loadServers);
  $('#servers-ping-all').addEventListener('click', pingAllServers);
  $('#server-add').addEventListener('click', addServer);
  $('#server-address').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addServer();
  });

  $('#stats-refresh').addEventListener('click', loadStats);
  $('#stats-reset').addEventListener('click', resetStats);

  $('#content-close').addEventListener('click', closeContent);
  $('#content-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeContent();
  });
  $('#content-target').addEventListener('change', async (event) => {
    state.contentTargetId = event.target.value;
    state.contentHits = [];
    state.contentUpdates = [];
    $('#content-results').textContent = '';
    $('#content-report').classList.add('hidden');
    renderContentWarning();
    await loadContentInstalled();
    await searchContent($('#content-search').value.trim());
  });
  $('#content-import').addEventListener('click', importContentFile);
  $$('#content-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => setContentKind(tab.dataset.kind));
  });
  $('#content-search-btn').addEventListener('click', () =>
    searchContent($('#content-search').value.trim())
  );
  $('#content-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchContent(event.currentTarget.value.trim());
  });
  $('#content-check-updates').addEventListener('click', checkContentUpdates);
  $('#content-conflicts').addEventListener('click', checkContentConflicts);

  $('#maintenance-close').addEventListener('click', closeMaintenance);
  $('#maintenance-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeMaintenance();
  });
  $('#maintenance-verify').addEventListener('click', runVerify);
  $('#maintenance-repair').addEventListener('click', runRepair);
  $('#maintenance-loader').addEventListener('click', runLoaderReinstall);
  $('#maintenance-crash').addEventListener('click', runCrashAnalysis);
  $('#maintenance-reset').addEventListener('click', runReset);
  $('#maintenance-cleanup').addEventListener('click', runCleanup);
  $('#maintenance-disk').addEventListener('click', loadDiskUsage);
  $('#maintenance-backup').addEventListener('click', createBackup);

  $('#crash-close').addEventListener('click', closeCrash);
  $('#crash-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeCrash();
  });

  $('#update-banner-later').addEventListener('click', hideUpdateBanner);
  $('#update-banner-download').addEventListener('click', downloadUpdate);
  $('#update-banner-install').addEventListener('click', installUpdate);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#crash-modal').classList.contains('hidden')) {
      closeCrash();
      return;
    }
    if (!$('#modal').classList.contains('hidden')) {
      $('#modal').classList.add('hidden');
      window.api.msCancel().catch(() => {});
      return;
    }
    if (!$('#content-modal').classList.contains('hidden')) {
      closeContent();
      return;
    }
    if (!$('#maintenance-modal').classList.contains('hidden')) {
      closeMaintenance();
      return;
    }
    if (!$('#modpack-modal').classList.contains('hidden')) closeModpacks();
  });

  window.addEventListener('language-changed', renderAllDynamic);

  window.api.on('launch:progress', updateProgress);
  window.api.on('launch:log', addLog);
  window.api.on('launch:exit', (payload) => {
    if (payload?.cancelled) {
      toast('Запуск отменён');
      return;
    }
    if (payload?.code !== null && payload?.code !== undefined) {
      toast(
        payload.code === 0 ? 'Minecraft закрыт' : `Minecraft завершился с кодом ${payload.code}`,
        payload.code !== 0
      );
    }
  });
  window.api.on('launch:crash', (payload) => {
    if (payload?.analysis?.found) {
      showCrash(payload.analysis);
      toast('Обнаружен отчёт о краше — открыт анализ.', true);
    }
  });
  window.api.on('ms:device', showDeviceModal);
  window.api.on('modpack:progress', updateModpackProgress);
  window.api.on('modpack:log', (line) => {
    const status = $('#modpack-status');
    if (!status || $('#modpack-modal').classList.contains('hidden')) return;
    status.textContent = String(line || '').slice(0, 240);
    status.className = 'status-line';
  });
  window.api.on('content:progress', updateContentProgress);
  window.api.on('content:log', (line) => {
    const status = $('#content-status');
    if (!status || $('#content-modal').classList.contains('hidden')) return;
    status.textContent = String(line || '').slice(0, 240);
    status.className = 'status-line';
  });
  window.api.on('maintenance:progress', updateMaintenanceProgress);
  window.api.on('maintenance:log', (line) => addLog(String(line || '')));
  window.api.on('update:available', handleUpdateAvailable);
  window.api.on('update:checked', handleUpdateChecked);
  window.api.on('update:progress', updateBannerProgress);
}

async function init() {
  try {
    state.config = await window.api.getConfig();
    applyConfig();
    bindEvents();
    bindDragAndDrop();
    updatePlayButton();
    await loadAppInfo();
    await loadInstances();
    await loadVersions();
    await refreshJava();
    refreshDiscordStatus();
    addLog('MineLauncher готов.');
    addLog(`Папка игры: ${state.config.gameDir}`);
  } catch (err) {
    addLog(`Ошибка инициализации: ${err.message}`);
    toast(`Ошибка инициализации: ${err.message}`, true);
  }
}

init();
