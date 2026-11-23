// Проверка модуля оформления: включение, цвет, защита OLED, самоотключение при сбоях, настройки.
// Запуск: NODE_PATH=<папка с node_modules, где есть jsdom> node test/theme.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const BUNDLE = path.join(__dirname, '..', 'plugins', 'lampa_watch.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Модуль с подставленным CSS, как это делает build.js
const CODE = fs.readFileSync(path.join(SRC, 'theme.js'), 'utf8').replace("'__THEME_CSS__'", () => JSON.stringify('body.lw-theme{background:#000}'));

function makeEnv(store) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const win = dom.window;
    const notes = [];
    const params = [];
    const data = Object.assign({}, store || {});

    win.appready = false; // сами не запускаем: тест вызывает start() по своему сценарию
    win.Lampa = {
        Storage: {
            get: (k, d) => (k in data ? data[k] : d),
            set: (k, v) => { data[k] = v; }
        },
        Noty: { show: (t) => notes.push(t) },
        Listener: { follow: () => {} },
        SettingsApi: { addParam: (p) => params.push(p) }
    };

    const LW = {};

    new Function('LW', 'window', 'document', CODE)(LW, win, win.document);
    LW.theme.tick = 5; // секунда = 5 мс

    return { LW, T: LW.theme, win, doc: win.document, body: win.document.body, notes, params, data };
}

const results = [];

async function test(name, fn) {
    try {
        await fn();
        results.push([true, name]);
    } catch (e) {
        results.push([false, name + '\n      ' + (e && e.stack || e)]);
    }
}

(async function () {
    await test('по умолчанию оформление выключено: класса нет, стиля нет', () => {
        const e = makeEnv();

        e.T.start();
        assert.ok(!e.body.classList.contains('lw-theme'));
        assert.strictEqual(e.doc.getElementById('lw-theme-css'), null);
    });

    await test('включено: класс на body, стиль один, повторный apply его не дублирует', () => {
        const e = makeEnv({ lw_theme: true });

        e.T.start();
        e.T.apply();
        assert.ok(e.body.classList.contains('lw-theme'));
        assert.strictEqual(e.doc.querySelectorAll('#lw-theme-css').length, 1);
        assert.ok(!e.body.classList.contains('lw-lime'));
    });

    await test('значение "true" строкой тоже считается включённым (так хранит Лампа)', () => {
        const e = makeEnv({ lw_theme: 'true' });

        assert.strictEqual(e.T.isOn(), true);
        e.T.start();
        assert.ok(e.body.classList.contains('lw-theme'));
    });

    await test('цвет лайм добавляет lw-lime, refresh после выключения снимает всё', () => {
        const e = makeEnv({ lw_theme: true, lw_theme_accent: 'lime' });

        e.T.start();
        assert.ok(e.body.classList.contains('lw-lime'));

        e.data.lw_theme = false;
        e.T.refresh();
        assert.ok(!e.body.classList.contains('lw-theme'));
        assert.ok(!e.body.classList.contains('lw-lime'));
    });

    await test('idleSeconds: 60 и 30 числами, off и мусор означают защиту выкл', () => {
        const e = makeEnv();

        assert.strictEqual(e.T.idleSeconds('60s'), 60);
        assert.strictEqual(e.T.idleSeconds('30s'), 30);
        assert.strictEqual(e.T.idleSeconds('off'), 0);
        assert.strictEqual(e.T.idleSeconds(undefined), 0);
        assert.strictEqual(e.T.idleSeconds('-5'), 0);
    });

    await test('защита OLED: без нажатий прячется верхняя строка, потом приглушаются плитки', async () => {
        const e = makeEnv({ lw_theme: true, lw_theme_idle: '30s' });

        e.T.start();
        assert.ok(!e.body.classList.contains('lw-idle10'));
        await sleep(80);
        assert.ok(e.body.classList.contains('lw-idle10'), 'верхняя строка спрятана через 10 с');
        assert.ok(!e.body.classList.contains('lw-idle'), 'плитки ещё не приглушены');
        await sleep(130);
        assert.ok(e.body.classList.contains('lw-idle'), 'плитки приглушены через 30 с');
    });

    await test('пока играет плеер, ничего не приглушается; после закрытия защита возвращается', async () => {
        const e = makeEnv({ lw_theme: true, lw_theme_idle: '30s' });

        const player = e.doc.createElement('div');

        player.className = 'player';
        e.body.appendChild(player);
        e.T.start();
        await sleep(300);
        assert.ok(!e.body.classList.contains('lw-idle'), 'плитки не трогаем во время фильма');
        assert.ok(!e.body.classList.contains('lw-idle10'), 'верхнюю строку тоже');

        player.remove();
        await sleep(300);
        assert.ok(e.body.classList.contains('lw-idle'), 'после фильма защита снова работает');
    });

    await test('нажатие кнопки сразу возвращает яркость и перезапускает отсчёт', async () => {
        const e = makeEnv({ lw_theme: true, lw_theme_idle: '30s' });

        e.T.start();
        await sleep(200);
        assert.ok(e.body.classList.contains('lw-idle'));

        e.doc.dispatchEvent(new e.win.KeyboardEvent('keydown', { key: 'ArrowRight' }));
        assert.ok(!e.body.classList.contains('lw-idle'));
        assert.ok(!e.body.classList.contains('lw-idle10'));

        await sleep(200);
        assert.ok(e.body.classList.contains('lw-idle'), 'после паузы приглушение возвращается');
    });

    await test('защита выключена: ничего не приглушается', async () => {
        const e = makeEnv({ lw_theme: true, lw_theme_idle: 'off' });

        e.T.start();
        await sleep(250);
        assert.ok(!e.body.classList.contains('lw-idle'));
        assert.ok(!e.body.classList.contains('lw-idle10'));
    });

    await test('если оформление выключили, таймеры больше не срабатывают', async () => {
        const e = makeEnv({ lw_theme: true, lw_theme_idle: '30s' });

        e.T.start();
        e.data.lw_theme = false;
        e.T.refresh();
        await sleep(250);
        assert.ok(!e.body.classList.contains('lw-idle'));
        assert.ok(!e.body.classList.contains('lw-idle10'));
    });

    await test('страховка: после трёх неудачных запусков оформление выключается само и говорит об этом', () => {
        const e = makeEnv({ lw_theme: true, lw_theme_fails: 3 });

        e.T.start();
        assert.ok(!e.body.classList.contains('lw-theme'));
        assert.strictEqual(e.data.lw_theme, false);
        assert.strictEqual(e.data.lw_theme_fails, 0);
        assert.strictEqual(e.notes.length, 1);
        assert.ok(e.notes[0].indexOf('три раза подряд') >= 0);
    });

    await test('запуск считается удачным через 8 секунд: счётчик сбоев обнуляется', async () => {
        const e = makeEnv({ lw_theme: true, lw_theme_fails: 1 });

        e.T.start();
        assert.strictEqual(e.data.lw_theme_fails, 2, 'на время запуска счётчик растёт');
        assert.ok(e.body.classList.contains('lw-theme'));
        await sleep(60);
        assert.strictEqual(e.data.lw_theme_fails, 0);
    });

    await test('настройки: переключатель выключен по умолчанию, цвет и защита выбираются списком', () => {
        const e = makeEnv();
        const api = { addParam: (p) => e.params.push(p) };

        e.T.addSettings(api);

        const names = e.params.map((p) => p.param.name);

        assert.deepStrictEqual(names, ['lw_theme_title', 'lw_theme', 'lw_theme_accent', 'lw_theme_idle']);
        assert.ok(e.params.every((p) => p.component === 'lampa_watch'));

        const on = e.params[1].param;

        assert.strictEqual(on.type, 'trigger');
        assert.strictEqual(on.default, false);
        assert.deepStrictEqual(Object.keys(e.params[2].param.values), ['blue', 'lime']);
        assert.deepStrictEqual(Object.keys(e.params[3].param.values), ['60s', '30s', 'off']);
        assert.strictEqual(e.params[3].param.default, '60s');
    });

    await test('переключатель в настройках сразу включает оформление', async () => {
        const e = makeEnv();

        e.T.addSettings({ addParam: (p) => e.params.push(p) });
        e.data.lw_theme = true;
        e.params[1].onChange(true);
        await sleep(80);
        assert.ok(e.body.classList.contains('lw-theme'));
    });

    await test('собранный плагин содержит оформление, а в CSS нет blur и белых заливок выбора', () => {
        const bundle = fs.readFileSync(BUNDLE, 'utf8');

        assert.ok(bundle.indexOf('LW.theme = (function') >= 0, 'модуль theme попал в сборку');
        assert.ok(bundle.indexOf('body.lw-theme') >= 0, 'CSS темы вшит');
        assert.ok(bundle.indexOf('__THEME_CSS__') < 0, 'метка заменена');

        const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

        assert.ok(!/blur\(\s*[0-9.]/.test(css), 'blur с размером запрещён');
        assert.ok(!/backdrop-filter\s*:\s*(?!none)/.test(css.replace(/-webkit-backdrop-filter/g, 'x')), 'backdrop-filter допустим только none');
        assert.ok(!/background(-color)?\s*:\s*#fff\b/i.test(css), 'белой заливки нет');
        assert.ok(!/transition\s*:[^;}]*\b(width|height|top|left|margin)\b/.test(css), 'анимируем только transform и opacity');
    });

    await test('у окон плагина нет белой заливки выбора: каждый прежний .focus с #fff переопределён темой', () => {
        const watch = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8') + fs.readFileSync(path.join(SRC, 'setup.js'), 'utf8');
        const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const old = [];

        // правила вида '.lw-row.focus{background:#fff;color:#000}' в строках addStyle
        watch.replace(/'([^']*\.focus[^']*)\{[^'}]*background:#fff/g, (m, sel) => { sel.split(',').forEach((s) => old.push(s.trim())); return m; });

        assert.ok(old.length >= 4, 'нашли прежние правила выбора: ' + old.length);

        old.forEach((sel) => {
            const re = new RegExp('body\\.lw-theme\\s+' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{[^}]*box-shadow\\s*:\\s*inset');

            assert.ok(re.test(css), 'тема переопределяет выбор: ' + sel);
        });
    });

    await test('кнопка «Лучшая раздача» показывает подпись даже без фокуса, а окно пожеланий — сетка плиток', () => {
        const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const watch = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');

        assert.ok(/body\.lw-theme \.full-start-new__buttons \.lw-watch-btn span,body\.lw-theme \.full-start-new__buttons \.lw-next-btn span\{display:inline\}/.test(css.replace(/\s+/g, ' ').replace(/\s*([{};])\s*/g, '$1')), 'подпись кнопки включена');
        assert.ok(/\.lw-box--wishes\{[^}]*display:grid/.test(css), 'пожелания: сетка');
        assert.ok(watch.indexOf("'lw-box lw-box--wishes'") >= 0, 'окно пожеланий помечено классом');
    });

    await test('плеер: линия времени и кнопки без белого, размытие Лампы снято на всех плашках плеера', () => {
        const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const rule = (sel) => {
            const i = css.indexOf(sel + '{');

            assert.ok(i >= 0, 'есть правило ' + sel);

            return css.slice(i, css.indexOf('}', i));
        };

        assert.ok(/linear-gradient/.test(rule('body.lw-theme .player-panel__position')), 'позиция времени: градиент акцента, не белая');
        assert.ok(/box-shadow:0 0 0 \.1em var\(--edge\)/.test(rule('body.lw-theme .player-panel__timeline.focus')), 'выбор линии времени: рамка акцента');
        assert.ok(/inset/.test(rule('body.lw-theme .player-panel .button.focus,body.lw-theme .player-skip.focus')), 'выбор кнопок плеера: внутренняя рамка');
        assert.ok(!/color:#000/.test(rule('body.lw-theme .player-skip.focus')), 'у «Пропустить» нет чёрного текста на светлом');

        const blur = css.match(/[^{}]+\{-webkit-backdrop-filter:none!important;backdrop-filter:none!important\}/);

        assert.ok(blur, 'есть общее правило снятия размытия');

        ['.normalization', '.player-video__paused', '.player-video__loader', '.player-panel__box-buttons', '.player-panel__time', '.player-skip', '.player-chat__body', '.noty--style--glass', '.player-info__values .value--size span'].forEach((sel) => {
            assert.ok(blur[0].indexOf('body.lw-theme ' + sel) >= 0, 'размытие снято: ' + sel);
        });
    });

    await test('поиск и окно ввода: клавиши, чипсы, источники и микрофон без белой заливки, окно ввода чёрное', () => {
        const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const rule = (sel) => {
            const i = css.indexOf(sel + '{');

            assert.ok(i >= 0, 'есть правило ' + sel);

            return css.slice(i, css.indexOf('}', i));
        };

        // всё, что Лампа красит белым при выборе в поиске, перекрыто рамкой акцента
        ['body.lw-theme .simple-keyboard .hg-button.hg-activeButton,body.lw-theme .simple-keyboard .hg-button.focus,body.lw-theme .simple-keyboard .hg-button:hover',
            'body.lw-theme .search-history-key.focus,body.lw-theme .search-source.focus,body.lw-theme .search-source.active.focus',
            'body.lw-theme .simple-keyboard-mic.focus',
            'body.lw-theme .simple-keyboard-buttons__enter:hover,body.lw-theme .simple-keyboard-buttons__cancel:hover',
            'body.lw-theme .settings-input__links.focus'].forEach((sel) => {
            assert.ok(/box-shadow:inset 0 0 0 \.09em var\(--edge\)/.test(rule(sel)), 'выбор с рамкой акцента: ' + sel);
        });

        assert.ok(/linear-gradient/.test(rule('body.lw-theme .search-source.active')), 'активный источник: градиент акцента, а не белая заливка');
        assert.ok(/background:#000!important/.test(rule('body.lw-theme .settings-input__content,body.lw-theme.glass--style .settings-input__content')), 'окно ввода: чистый чёрный');
    });

    await test('четыре функции: кнопка «Серия N», запас, плитки диагностики оформлены, без белого и размытия', () => {
        const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const rule = (sel) => {
            const i = css.indexOf(sel + '{');

            assert.ok(i >= 0, 'нет правила ' + sel);

            return css.slice(i, css.indexOf('}', i) + 1);
        };

        assert.ok(/\n\s*body\.lw-theme \.lw-next-btn\s*\{[^}]*linear-gradient\(155deg,\s*var\(--mid\),\s*var\(--deep\)\)/.test(css), 'главная кнопка серии залита акцентом');
        assert.ok(/box-shadow:inset 0 0 0 \.09em var\(--edge\)/.test(rule('body.lw-theme .lw-next-btn.focus')), 'у выбранной рамка акцента');
        assert.ok(/border:1px solid rgba\(255,157,77/.test(rule('body.lw-theme .lw-reserve')), 'блок «нужен запас» оранжевый, как «скорее будет лагать»');
        assert.ok(/font-size:7em/.test(rule('body.lw-theme .lw-big')), 'большой процент на экране запаса');
        assert.ok(/border:1px solid var\(--line\)/.test(rule('body.lw-theme .lw-dgc')), 'плитка диагностики');
        assert.ok(/rgba\(255,107,107/.test(rule('body.lw-theme .lw-dgc[data-level=bad]')) && /rgba\(255,210,90/.test(rule('body.lw-theme .lw-dgc[data-level=warn]')), 'рамка плитки меняется со статусом');
    });

    await test('четыре функции: у окон плагина нет белой заливки и анимаций размеров', () => {
        const health = fs.readFileSync(path.join(SRC, 'health.js'), 'utf8');
        const watch = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');

        // у watch.js белый выбор остаётся только для обычного вида: тема его перекрывает (это проверяют тесты выше)
        assert.ok(!/background:\s*#fff\b/i.test(health), 'белый фон в стилях диагностики');
        assert.ok(!/backdrop-filter|blur\(|transition\s*:\s*(width|height)/.test(health), 'размытие или анимация размера в диагностике');
        assert.ok(!/backdrop-filter|blur\(/.test(watch), 'размытие в стилях плагина');
    });

    results.forEach(([ok, name]) => console.log((ok ? 'PASS  ' : 'FAIL  ') + name));
    const failed = results.filter((r) => !r[0]).length;

    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
