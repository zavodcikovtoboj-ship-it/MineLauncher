'use strict';

// Packaged-app UI smoke test over the Chrome DevTools Protocol.
// Starts dist/win-unpacked/MineLauncher.exe (or ML_SMOKE_EXE) with isolated
// app data, checks the main pages, modals and theming, then saves screenshots.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.ML_SMOKE_EXE || path.join(ROOT, 'dist', 'win-unpacked', 'MineLauncher.exe');
const DATA_DIR = process.env.ML_SMOKE_DATA || path.join(os.tmpdir(), 'mclauncher-ui-smoke');
const PORT = Number(process.env.ML_SMOKE_PORT) || 9333;
const SHOT_MAIN = path.join(ROOT, 'smoke.png');
const SHOT_MODPACKS = path.join(ROOT, 'smoke-modpacks.png');
const SHOT_INSTANCES = path.join(ROOT, 'smoke-instances.png');
const SHOT_SETTINGS = path.join(ROOT, 'smoke-settings.png');

const SOURCE_RUN = path.basename(EXE).toLowerCase() === 'electron.exe';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) {
      lastError = err;
    }
    await delay(400);
  }
  throw lastError || new Error(`Не дождались ${url}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let nextId = 1;

    const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 10000);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        events,
        call(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      });
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.rej(new Error(`${message.error.message} (${message.error.code})`));
        else entry.res(message.result);
        return;
      }
      events.push(message);
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connection failed'));
    });
  });
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`Сборка не найдена: ${EXE}`);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const args = [`--remote-debugging-port=${PORT}`];
  if (SOURCE_RUN) args.push(ROOT);
  const child = spawn(EXE, args, {
    cwd: ROOT,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APPDATA: DATA_DIR,
      LOCALAPPDATA: path.join(DATA_DIR, 'local'),
      ML_SMOKE: '1',
      ML_SMOKE_DATA: DATA_DIR,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  let cdp = null;
  try {
    const targets = await waitForHttp(`http://127.0.0.1:${PORT}/json`, 45000);
    const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
    if (!page) throw new Error('Не найдено окно лаунчера в CDP.');

    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Log.enable');

    const evaluate = async (expression) => {
      const result = await cdp.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(`JS error: ${text}`);
      }
      return result.result.value;
    };

    const waitFor = async (expression, label, timeoutMs = 90000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(expression)) return;
        await delay(500);
      }
      throw new Error(`Таймаут ожидания: ${label}`);
    };

    const click = async (selector) => {
      await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('Не найден элемент: ' + ${JSON.stringify(selector)});
        node.click();
        return true;
      })()`);
    };

    await waitFor(
      "document.querySelectorAll('#version-select option').length > 10",
      'загрузки списка версий'
    );
    await waitFor(
      "document.querySelectorAll('#version-select option[value^=\"fabric:\"]').length > 0",
      'каталога Fabric',
      180000
    );
    await waitFor(
      "document.querySelectorAll('#version-select option[value^=\"forge:\"]').length > 0",
      'каталога Forge',
      180000
    );
    await waitFor(
      "document.querySelectorAll('#version-select option[value^=\"neoforge:\"]').length > 0",
      'каталога NeoForge',
      180000
    );

    const groups = await evaluate(`
      Array.from(document.querySelectorAll('#version-select optgroup')).map((group) => ({
        label: group.label,
        count: group.querySelectorAll('option').length,
      }))
    `);
    console.log('version groups:', JSON.stringify(groups));

    const fabricValue = await evaluate(`
      (() => {
        const group = Array.from(document.querySelectorAll('#version-select optgroup'))
          .find((item) => item.label === 'Fabric');
        const option = group && Array.from(group.querySelectorAll('option'))
          .find((item) => item.value === 'fabric:26.3');
        return option ? option.value : '';
      })()
    `);
    if (!fabricValue) throw new Error('В группе Fabric нет 26.3.');
    await evaluate(`
      (() => {
        const select = document.querySelector('#version-select');
        select.value = ${JSON.stringify(fabricValue)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await delay(800);

    const fabricHero = await evaluate("document.querySelector('#hero-sub').textContent");
    console.log('fabric hero:', fabricHero);
    if (!/Fabric/i.test(fabricHero)) throw new Error('Описание Fabric не обновилось.');

    const layout = await evaluate(`({
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      footer: document.querySelector('#app-version')?.textContent || '',
      modals: {
        modpack: Boolean(document.querySelector('#modpack-modal')),
        content: Boolean(document.querySelector('#content-modal')),
        maintenance: Boolean(document.querySelector('#maintenance-modal')),
        crash: Boolean(document.querySelector('#crash-modal')),
        device: Boolean(document.querySelector('#modal')),
      },
    })`);
    console.log('layout:', JSON.stringify(layout));
    if (!/MineLauncher 1\.0\.0/.test(layout.footer)) {
      throw new Error(`Неверная версия в подвале: ${layout.footer}`);
    }
    if (Object.values(layout.modals).some((value) => !value)) {
      throw new Error('Не все модальные окна присутствуют в разметке.');
    }

    const mainShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_MAIN, Buffer.from(mainShot.data, 'base64'));

    // Every navigation tab must render without horizontal overflow.
    const pages = ['instances', 'servers', 'stats', 'account', 'settings', 'logs', 'play'];
    for (const pageName of pages) {
      await evaluate(`
        (() => {
          const nav = document.querySelector('.nav-item[data-page="${pageName}"]');
          if (!nav) throw new Error('Нет вкладки ${pageName}');
          nav.click();
          return true;
        })()
      `);
      await delay(350);
      const state = await evaluate(`({
        active: document.querySelector('#page-${pageName}')?.classList.contains('active') || false,
        overflow: document.documentElement.scrollWidth > innerWidth,
      })`);
      if (!state.active) throw new Error(`Вкладка ${pageName} не активировалась.`);
      if (state.overflow) throw new Error(`Горизонтальное переполнение на вкладке ${pageName}.`);
      console.log(`page ${pageName}: ok`);
    }

    // Theme and accent presets.
    await click('.nav-item[data-page="settings"]');
    await delay(300);
    await waitFor(
      "document.querySelector('#discord-status')?.textContent.trim().length > 0",
      'статуса Discord',
      10000
    );
    const settingsUi = await evaluate(`({
      accents: document.querySelectorAll('#accent-swatches .accent-swatch').length,
      themes: document.querySelectorAll('#theme-select option').length,
      languages: document.querySelectorAll('#language-select option').length,
      syncButtons: document.querySelectorAll('#sync-export-settings, #sync-import-settings, #sync-export-worlds, #sync-import-worlds').length,
      netButtons: document.querySelectorAll('#net-diagnostics').length,
      updateButtons: document.querySelectorAll('#update-check, #update-download, #update-install').length,
      discordPortal: Boolean(document.querySelector('#discord-portal')),
      discordToggle: Boolean(document.querySelector('#discord-rpc')),
      discordStatus: document.querySelector('#discord-status')?.textContent || '',
    })`);
    console.log('settings ui:', JSON.stringify(settingsUi));
    if (settingsUi.accents !== 6) throw new Error('Ожидалось 6 цветовых акцентов.');
    if (settingsUi.themes < 2) throw new Error('Не найдены темы оформления.');
    if (settingsUi.syncButtons !== 4) throw new Error('Не все кнопки синхронизации на месте.');
    if (settingsUi.discordToggle) throw new Error('Переключатель Discord должен быть убран.');
    if (!settingsUi.discordPortal) throw new Error('Нет кнопки Discord Developer Portal.');

    await evaluate(`
      (() => {
        const select = document.querySelector('#theme-select');
        select.value = 'light';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await delay(400);
    await click('.accent-swatch[data-accent="blue"]');
    await waitFor(
      "document.documentElement.dataset.accent === 'blue' && document.documentElement.dataset.theme === 'light'",
      'светлой темы и синего акцента',
      5000
    );
    const settingsShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_SETTINGS, Buffer.from(settingsShot.data, 'base64'));

    // Localization: English and back to Russian.
    await evaluate(`
      (() => {
        const select = document.querySelector('#language-select');
        select.value = 'en';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await waitFor("window.i18n?.lang === 'en'", 'переключения на английский', 5000);
    const englishNav = await evaluate(
      "document.querySelector('.nav-item[data-page=\"instances\"]').textContent.trim()"
    );
    if (englishNav !== 'Instances') throw new Error(`Английская локализация не применилась: ${englishNav}`);
    await evaluate(`
      (() => {
        const select = document.querySelector('#language-select');
        select.value = 'ru';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await waitFor("window.i18n?.lang === 'ru'", 'возврата на русский', 5000);

    await evaluate(`
      (() => {
        const theme = document.querySelector('#theme-select');
        theme.value = 'dark';
        theme.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    await click('.accent-swatch[data-accent="green"]');
    await waitFor(
      "document.documentElement.dataset.accent === 'green' && document.documentElement.dataset.theme === 'dark'",
      'возврата тёмной темы',
      5000
    );

    // Create a custom instance through the UI.
    await click('.nav-item[data-page="instances"]');
    await waitFor(
      "document.querySelectorAll('#instance-version option').length > 0",
      'списка версий для инстанса'
    );
    await evaluate(`
      (() => {
        const name = document.querySelector('#instance-name');
        const version = document.querySelector('#instance-version');
        const loader = document.querySelector('#instance-loader');
        name.value = 'Smoke Instance';
        version.value = version.options[0].value;
        loader.value = 'vanilla';
        document.querySelector('#instance-create').click();
        return { version: version.value };
      })()
    `);
    await waitFor(
      "document.querySelectorAll('#instances-list .entity-card').length > 0",
      'создания инстанса',
      15000
    );
    await waitFor(
      "Array.from(document.querySelectorAll('#version-select option')).some((option) => option.value.startsWith('instance:'))",
      'появления инстанса в списке запуска',
      10000
    );
    const instanceUi = await evaluate(`({
      status: document.querySelector('#instance-status').textContent,
      cards: document.querySelectorAll('#instances-list .entity-card').length,
      name: document.querySelector('#instances-list .entity-title')?.textContent || '',
    })`);
    console.log('instance ui:', JSON.stringify(instanceUi));
    if (!/Smoke Instance/.test(instanceUi.name)) throw new Error('Инстанс не появился в списке.');

    const instancesShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_INSTANCES, Buffer.from(instancesShot.data, 'base64'));

    // Maintenance modal for the created instance, including disk usage.
    await evaluate(`
      (() => {
        const card = document.querySelector('#instances-list .entity-card');
        const action = Array.from(card.querySelectorAll('.entity-actions .btn'))
          .find((node) => /Обслуж|Maintenance/i.test(node.textContent));
        if (!action) throw new Error('Нет кнопки обслуживания');
        action.click();
        return true;
      })()
    `);
    await waitFor(
      "!document.querySelector('#maintenance-modal').classList.contains('hidden')",
      'открытия обслуживания',
      10000
    );
    const maintenanceUi = await evaluate(`({
      target: document.querySelector('#maintenance-target').textContent,
      verifyDisabled: document.querySelector('#maintenance-verify').disabled,
      resetDisabled: document.querySelector('#maintenance-reset').disabled,
      backupDisabled: document.querySelector('#maintenance-backup').disabled,
      loaderDisabled: document.querySelector('#maintenance-loader').disabled,
      backupRows: document.querySelectorAll('#maintenance-backups .backup-row').length,
    })`);
    console.log('maintenance ui:', JSON.stringify(maintenanceUi));
    if (!/Smoke Instance|instance:/.test(maintenanceUi.target)) {
      throw new Error('Цель обслуживания не выбрана.');
    }
    if (maintenanceUi.verifyDisabled || maintenanceUi.resetDisabled || maintenanceUi.backupDisabled) {
      throw new Error('Кнопки обслуживания должны быть доступны для инстанса.');
    }
    if (!maintenanceUi.loaderDisabled) {
      throw new Error('Для Vanilla кнопка переустановки загрузчика должна быть отключена.');
    }
    await click('#maintenance-disk');
    await waitFor(
      "document.querySelectorAll('#maintenance-disk-output .disk-row').length > 0",
      'расчёта дискового пространства',
      15000
    );
    await click('#maintenance-close');
    await waitFor(
      "document.querySelector('#maintenance-modal').classList.contains('hidden')",
      'закрытия обслуживания',
      5000
    );

    // Content modal opens with target selection and kind tabs.
    await click('.nav-item[data-page="play"]');
    await click('#play-content');
    await waitFor(
      "!document.querySelector('#content-modal').classList.contains('hidden')",
      'открытия контента',
      10000
    );
    await waitFor(
      "document.querySelectorAll('#content-target option').length > 0",
      'целей контента',
      15000
    );
    const contentUi = await evaluate(`({
      targets: document.querySelectorAll('#content-target option').length,
      tabs: document.querySelectorAll('#content-tabs .tab').length,
      activeTab: document.querySelector('#content-tabs .tab.active')?.dataset.kind || '',
      installedEmpty: document.querySelector('#content-installed').textContent.trim(),
    })`);
    console.log('content ui:', JSON.stringify(contentUi));
    if (contentUi.tabs !== 3) throw new Error('Ожидалось три категории контента.');
    if (!contentUi.activeTab) throw new Error('Не выбрана категория контента.');
    await click('#content-close');
    await waitFor(
      "document.querySelector('#content-modal').classList.contains('hidden')",
      'закрытия контента',
      5000
    );

    // Server browser defaults and statistics page.
    await click('.nav-item[data-page="servers"]');
    await waitFor(
      "document.querySelectorAll('#servers-list .server-card').length >= 3",
      'списка серверов',
      10000
    );
    const serverUi = await evaluate(`({
      cards: document.querySelectorAll('#servers-list .server-card').length,
      addButton: Boolean(document.querySelector('#server-add')),
      pingButton: Boolean(document.querySelector('#servers-ping-all')),
    })`);
    console.log('server ui:', JSON.stringify(serverUi));

    await click('.nav-item[data-page="stats"]');
    await waitFor(
      "document.querySelector('#stats-launches').textContent.trim().length > 0",
      'загрузки статистики',
      10000
    );
    const statsUi = await evaluate(`({
      launches: document.querySelector('#stats-launches').textContent,
      playtime: document.querySelector('#stats-playtime').textContent,
      crashes: document.querySelector('#stats-crashes').textContent,
      tables: document.querySelectorAll('#stats-by-target table, #stats-recent .table-empty').length,
    })`);
    console.log('stats ui:', JSON.stringify(statsUi));

    // Drag-and-drop overlay reacts to a file drag and hides again.
    const dragUi = await evaluate(`
      (() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['demo'], 'demo.jar', { type: 'application/java-archive' }));
        window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
        const shown = !document.querySelector('#drop-overlay').classList.contains('hidden');
        window.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
        return {
          shown,
          hidden: document.querySelector('#drop-overlay').classList.contains('hidden'),
        };
      })()
    `);
    console.log('drag ui:', JSON.stringify(dragUi));
    if (!dragUi.shown || !dragUi.hidden) throw new Error('Оверлей drag-and-drop работает некорректно.');

    // Modpack modal and Modrinth search.
    await click('.nav-item[data-page="play"]');
    await click('#open-modpacks');
    await waitFor(
      "!document.querySelector('#modpack-modal').classList.contains('hidden')",
      'открытия модального окна модпаков',
      15000
    );
    await waitFor(
      "document.querySelectorAll('#modpack-results .pack-card').length > 0",
      'результатов Modrinth',
      60000
    );

    await evaluate(`
      (() => {
        const input = document.querySelector('#modpack-search');
        input.value = 'Fabulously Optimized';
        document.querySelector('#modpack-search-btn').click();
        return true;
      })()
    `);
    await waitFor(
      "Array.from(document.querySelectorAll('#modpack-results .pack-title')).some((el) => /Fabulously Optimized/i.test(el.textContent))",
      'поиска Fabulously Optimized',
      60000
    );

    const modpackUi = await evaluate(`({
      status: document.querySelector('#modpack-status').textContent,
      cards: document.querySelectorAll('#modpack-results .pack-card').length,
      titles: Array.from(document.querySelectorAll('#modpack-results .pack-title')).slice(0, 5).map((el) => el.textContent),
      installed: document.querySelector('#modpack-installed').textContent.trim(),
      progressHidden: document.querySelector('#modpack-progress-wrap').classList.contains('hidden'),
      icons: Array.from(document.querySelectorAll('#modpack-results .pack-icon img')).slice(0, 3).map((img) => img.complete && img.naturalWidth > 0),
    })`);
    console.log('modpack ui:', JSON.stringify(modpackUi));

    await delay(600);
    const modalShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_MODPACKS, Buffer.from(modalShot.data, 'base64'));

    const problems = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
      .map((event) => {
        if (event.method === 'Runtime.exceptionThrown') {
          return event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text;
        }
        const entry = event.params.entry;
        return entry.level === 'error' ? `${entry.source}: ${entry.text}` : null;
      })
      .filter(Boolean)
      .filter((line) => !/Failed to load resource.*favicon/i.test(line));

    console.log('renderer problems:', problems.length ? JSON.stringify(problems, null, 2) : 'none');
    console.log('screenshots:', SHOT_MAIN, SHOT_MODPACKS, SHOT_INSTANCES, SHOT_SETTINGS);
    console.log('stdout:', stdout.trim() || '(empty)');
    console.log('stderr:', stderr.trim() || '(empty)');

    if (layout.scrollWidth > layout.width) throw new Error('Горизонтальное переполнение интерфейса.');
    if (!modpackUi.cards) throw new Error('Модальное окно модпаков пустое.');
    if (problems.length) throw new Error(`Ошибки рендерера: ${problems.length}`);
  } finally {
    cdp?.close();
    killTree(child);
  }
})().catch((err) => {
  console.error('UI SMOKE FAILED:', err);
  process.exit(1);
});
