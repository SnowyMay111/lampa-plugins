// Прогон интерфейса «Лучшая раздача» на макете Лампы в jsdom.
// Запуск: NODE_PATH=<папка с node_modules, где есть jsdom и jquery> node test/ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const jquery = require('jquery');

const SRC = path.join(__dirname, '..', 'src');
const BUNDLE = path.join(__dirname, '..', 'plugins', 'lampa_watch.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 1500);

    while (Date.now() < end) {
        if (fn()) return;
        await sleep(5);
    }

    throw new Error('не дождались: ' + (what || fn.toString()));
}

const GB = 1e9;
const R = (Title, gb, Seeders, Tracker) => ({ Title, Size: gb * GB, Seeders, Peers: Seeders + 3, Tracker: Tracker || 'RuTracker', MagnetUri: 'magnet:?xt=urn:btih:' + Math.random().toString(16).slice(2) });

const MOVIE = { id: 550, title: 'Бойцовский клуб', original_title: 'Fight Club', release_date: '1999-10-15', runtime: 139, original_language: 'en', genres: [], img: 'poster.jpg' };
const SERIES = { id: 70523, name: 'Тьма', original_name: 'Dark', first_air_date: '2017-12-01', number_of_seasons: 3, episode_run_time: [55], original_language: 'de', genres: [], img: 'dark.jpg', seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 10 }, { season_number: 2, episode_count: 8 }, { season_number: 3, episode_count: 8 }] };

const FIGHT = [
    R('Fight Club / Бойцовский клуб (1999) UHD BDRemux 2160p HEVC HDR10 Dolby Vision | Dub', 58, 40),
    R('Fight Club (1999) 2160p UHD BluRay x265 HDR10 Rus', 28, 12),
    R('Бойцовский клуб / Fight Club (1999) BDRip 1080p AVC Дубляж', 12, 150),
    R('Fight Club (1999) CAMRip', 1.4, 300)
];

// ---------------------------------------------------------------- макет Лампы

function makeEnv(opts) {
    opts = opts || {};

    const dom = new JSDOM('<!doctype html><html><head></head><body><div class="activity"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const $ = jquery(win);

    win.$ = win.jQuery = $;

    const calls = { noty: [], parser: [], torrent: [], played: [], back: 0, stat: [], selects: [], activity: [], toggles: [], updates: 0, inputs: [], native: [], settings: { components: [], params: [] } };
    const store = Object.assign({}, opts.store);
    const listeners = {};
    const modals = [];

    const Listener = {
        follow(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
        send(name, data) { (listeners[name] || []).slice().forEach((fn) => fn(data)); }
    };

    const Modal = {
        open(params) {
            const el = $('<div class="modal"><div class="modal__title"></div><div class="modal__body"></div></div>');

            el.find('.modal__title').text(params.title || '');
            el.find('.modal__body').append(params.html);

            if (params.buttons) {
                const footer = $('<div class="modal__footer"></div>');

                params.buttons.forEach((b) => footer.append($('<div class="modal__button selector"></div>').text(b.name).on('hover:enter', () => b.onSelect())));
                el.find('.modal__body').append(footer);
            }

            $('body').append(el);
            modals.push({ params, el });
        },
        update(html) {
            calls.updates++;
            modals[modals.length - 1].el.find('.modal__body').empty().append(html);
        },
        close() { modals.pop().el.remove(); },
        opened: () => modals.length > 0
    };

    if (opts.noUpdate) delete Modal.update; // старая Лампа без Modal.update

    const parserFn = opts.parser || ((obj, ok) => ok({ Results: FIGHT }));

    const Lampa = {
        Listener,
        Modal,
        Storage: {
            get: (k, d) => (k in store ? store[k] : d),
            set: (k, v) => { store[k] = v; },
            field: (k) => (k === 'parse_lang' ? 'df' : store[k])
        },
        Noty: { show: (t) => calls.noty.push(t) },
        Timeline: { watchedEpisode: (movie, season, episode) => (opts.watched ? opts.watched(season, episode) : 0) },
        Lang: { translate: (k) => k },
        Activity: { push: (o) => calls.activity.push(o) },
        Controller: { toggle: (n) => calls.toggles.push(n), back: () => { calls.back++; } },
        Select: { show: (p) => calls.selects.push(p) },
        SettingsApi: {
            addComponent: (c) => calls.settings.components.push(c),
            addParam: (p) => calls.settings.params.push(p)
        },
        Input: opts.noInput ? undefined : { edit: (p, cb) => { calls.inputs.push(p); calls.inputCb = cb; } },
        Parser: {
            get: (obj, ok, fail) => { calls.parser.push(obj); setTimeout(() => parserFn(obj, ok, fail), 2); },
            clear: () => { calls.parserCleared = true; }
        },
        Reguest: function () {
            this.timeout = () => {};
            this.clear = () => {};
            // нативный запрос: так парсер проверяют и Лампа, и плагин; ответы задаёт opts.net(url) (нет ответа = ошибка)
            this.native = (url, ok, fail) => {
                calls.native.push(url);
                setTimeout(() => {
                    const r = opts.net ? opts.net(url) : null;

                    if (r) ok(r); else fail();
                }, 2);
            };
            this.silent = (url, ok, fail, body, params) => {
                if (/parsers\.json/.test(url)) return setTimeout(fail, 2); // список с сайта плагина в тестах недоступен

                // настройки TorrServer: opts.server — его состояние, при записи заменяется целиком, как у настоящего
                if (/\/settings$/.test(url)) {
                    return setTimeout(() => {
                        const req = JSON.parse(body);

                        if (opts.serverDown || !opts.server) return fail();
                        if (req.action === 'get') return ok(JSON.parse(JSON.stringify(opts.server)));

                        Object.keys(req.sets).forEach((k) => { opts.server[k] = req.sets[k]; });

                        if (params && params.dataType === 'text') ok(''); else fail();
                    }, 2);
                }

                calls.stat.push(url);
                setTimeout(() => {
                    const stat = opts.stat ? opts.stat(url) : { download_speed: 8e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e9 };

                    if (stat) ok(stat); else fail();
                }, 2);
            };
        },
        Torrent: {
            start(element, movie) {
                calls.torrent.push(element);

                setTimeout(() => {
                    const files = (opts.files ? opts.files(element, movie) : [
                        { id: 1, path: 'Fight.Club/sample.mkv', length: 0.2 * GB },
                        { id: 2, path: 'Fight.Club/Fight.Club.1999.mkv', length: 12 * GB }
                    ]).map((f) => Object.assign({ season: undefined, episode: undefined }, f));

                    Listener.send('torrent_file', { type: 'list_open', items: files, params: { movie } });

                    files.forEach((f) => {
                        const item = $('<div class="torrent-file selector"></div>');

                        f.url = 'http://ts:8090/stream/' + encodeURIComponent(f.path.split('/').pop()) + '?link=HASH&index=' + f.id + '&' + (opts.playParam || 'preload');
                        item.on('hover:enter', () => calls.played.push(f));
                        Listener.send('torrent_file', { type: 'render', element: f, item, items: files, params: { movie } });
                    });
                }, 3);
            }
        }
    };

    win.Lampa = Lampa;
    win.appready = true;
    win.lampa_settings = opts.settings || { torrents_use: true };
    win.lampa_watch_config = Object.assign({ measureMs: 150, warmup: 20, interval: 15, settle: 5, verifyDelay: 5, tuneMs: 400, prefetchDelay: 600000, fpsMs: 120, missingMs: 80, reserveStallMs: 400 }, opts.config);

    // Модули собираются так же, как в build.js
    const parts = opts.bundle ? [fs.readFileSync(BUNDLE, 'utf8')] : ['health', 'speed', 'score', 'series', 'list', 'parser', 'tune', 'watch', 'setup'].map((name) =>
        'var LW = window.__LW = window.__LW || {};\n(function (LW) {\n\'use strict\';\n' + fs.readFileSync(path.join(SRC, name + '.js'), 'utf8') + '\n})(LW);');

    parts.forEach((code) => win.eval(code));

    return {
        win, $, calls, store, modals,
        top: () => modals[modals.length - 1],
        text: () => (modals.length ? modals[modals.length - 1].el.text() : ''),
        press(label) {
            const el = modals[modals.length - 1].el.find('.modal__button').filter((i, b) => $(b).text().indexOf(label) >= 0);

            if (!el.length) throw new Error('нет кнопки «' + label + '», есть: ' + modals[modals.length - 1].el.find('.modal__button').map((i, b) => $(b).text()).get().join(' | '));

            el.first().trigger('hover:enter');
        },
        row(label) {
            const el = modals[modals.length - 1].el.find('.lw-row').filter((i, r) => $(r).find('.lw-row__name').text() === label);

            if (!el.length) throw new Error('нет строки «' + label + '»');

            return el.first();
        },
        card(movie) {
            const root = $('<div><div class="full-start-new__buttons"><div class="full-start__button selector button--play"><span>Смотреть</span></div><div class="full-start__button selector button--book"></div></div></div>');

            Listener.send('full', { type: 'complite', data: { movie }, object: { activity: { render: () => root } } });

            return root;
        }
    };
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)]); }
}

(async () => {
    await test('кнопка появляется сразу после «Смотреть» и не дублируется', async () => {
        const env = makeEnv();
        const root = env.card(MOVIE);

        assert.strictEqual(root.find('.lw-watch-btn').length, 1);
        assert.ok(root.find('.button--play').next().hasClass('lw-watch-btn'));
        assert.strictEqual(root.find('.lw-watch-btn span').text(), 'Лучшая раздача');

        env.win.Lampa.Listener.send('full', { type: 'complite', data: { movie: MOVIE }, object: { activity: { render: () => root } } });
        assert.strictEqual(root.find('.lw-watch-btn').length, 1);
    });

    await test('кнопки нет, если торренты в Лампе отключены', async () => {
        const env = makeEnv({ settings: { torrents_use: false } });
        assert.strictEqual(env.card(MOVIE).find('.lw-watch-btn').length, 0);
    });

    await test('старый вид карточки: кнопка встаёт после «Торренты»', async () => {
        const env = makeEnv();
        const root = env.$('<div><div class="view--torrent selector"></div></div>');

        env.win.Lampa.Listener.send('full', { type: 'complite', data: { movie: MOVIE }, object: { activity: { render: () => root } } });
        assert.ok(root.find('.view--torrent').next().hasClass('lw-watch-btn'));
    });

    await test('окно пожеланий: строки для фильма, без сезона и серии', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');

        ['Качество', 'HDR', 'Dolby Vision', 'Язык озвучки', 'Тип озвучки', 'Субтитры', 'Раздающих не меньше', 'После поиска'].forEach((l) => env.row(l));
        assert.throws(() => env.row('Сезон'));
        assert.ok(env.text().indexOf('Найти и смотреть') > 0);
    });

    await test('окно пожеланий: у сериала есть сезон и серия', async () => {
        const env = makeEnv();
        env.card(SERIES).find('.lw-watch-btn').trigger('hover:enter');

        assert.strictEqual(env.row('Сезон').find('.lw-row__val').text(), 'Сезон 1');
        assert.strictEqual(env.row('Серия').find('.lw-row__val').text(), 'Выбрать в списке');
    });

    await test('короткие списки листаются по кругу: 4K, 1080p, 720p, любое', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');

        const seen = [env.row('Качество').find('.lw-row__val').text()];

        for (let i = 0; i < 4; i++) {
            env.row('Качество').trigger('hover:enter');
            seen.push(env.row('Качество').find('.lw-row__val').text());
        }

        assert.deepStrictEqual(seen, ['4K', '1080p', '720p', 'Любое', '4K']);
    });

    await test('язык озвучки: длинный список открывается меню, выбор записывается в строку', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Язык озвучки').trigger('hover:enter');

        const sel = env.calls.selects[0];
        assert.deepStrictEqual(Array.from(sel.items.map((i) => i.title)).slice(0, 4), ['Любой', 'Русский', 'Украинский', 'Английский']);

        sel.onSelect(sel.items[2]);
        assert.strictEqual(env.row('Язык озвучки').find('.lw-row__val').text(), 'Украинский');
    });

    await test('серия: меню серий берёт число серий выбранного сезона', async () => {
        const env = makeEnv();
        env.card(SERIES).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Серия').trigger('hover:enter');

        assert.strictEqual(env.calls.selects[0].items.length, 1 + 10);
    });

    await test('«Найти и смотреть»: парсер получает поисковый запрос как у самой Лампы, пожелания запоминаются', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter'); // 1080p
        env.press('Найти и смотреть');

        await waitFor(() => env.calls.parser.length === 1);

        const q = env.calls.parser[0];
        assert.strictEqual(q.search, 'Fight Club');
        assert.strictEqual(q.movie, MOVIE);
        assert.strictEqual(q.page, 1);
        assert.strictEqual(JSON.parse(env.store.lw_wishes).quality, '1080');
        assert.strictEqual(JSON.parse(env.store.lw_wishes).season, undefined);
    });

    await test('карточка результата: лучшая раздача, плашки, проверки, прогноз и статистика', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('HDR').trigger('hover:enter'); // нужен
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Лучшая раздача') >= 0 && env.text().indexOf('Запустить') >= 0);

        const t = env.text();
        assert.ok(t.indexOf('Fight Club / Бойцовский клуб (1999) UHD BDRemux') >= 0, 'выбран не 4K ремукс');
        assert.ok(t.indexOf('Dolby Vision') >= 0 && t.indexOf('HDR') >= 0);
        assert.ok(t.indexOf('Качество 4K') >= 0);
        assert.ok(/Прикидка/.test(t));
        assert.ok(/Найдено 4, подходит 3/.test(t), t);
        assert.ok(t.indexOf('Другие раздачи') >= 0);
    });

    await test('если пожелание не выполнить, карточка честно говорит, чего не нашлось', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [FIGHT[2]] }) }); // только 1080p
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        assert.ok(env.text().indexOf('Не нашлось: качество 4K') >= 0, env.text());
    });

    await test('«Другие раздачи»: меню со следующими по оценке, выбор показывает ту раздачу', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Другие раздачи') >= 0);
        env.press('Другие раздачи');

        const sel = env.calls.selects[0];
        assert.ok(sel.items.length >= 2);
        assert.ok(sel.items.every((i) => i.title.indexOf('CAMRip') < 0), 'CAM попал в список');

        sel.onSelect(sel.items[0]);
        assert.ok(env.text().indexOf(sel.items[0].title.slice(0, 20)) >= 0);
    });

    await test('запуск, быстрая скорость: торрент стартует, замер, потом сам нажимается главный файл', async () => {
        const env = makeEnv({ stat: () => ({ download_speed: 8e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e12 }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter'); // 1080p
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');

        assert.strictEqual(env.calls.torrent.length, 1);
        assert.ok(env.calls.torrent[0].Title.indexOf('BDRip 1080p') > 0);
        assert.strictEqual(env.calls.torrent[0].poster, 'poster.jpg');

        await waitFor(() => env.calls.played.length === 1);
        assert.strictEqual(env.calls.played[0].path, 'Fight.Club/Fight.Club.1999.mkv', 'нажат не главный файл');
        assert.ok(env.calls.stat.length >= 2);
        assert.ok(env.calls.stat[0].indexOf('&preload') > 0 && env.calls.stat[1].indexOf('&stat') > 0);
        assert.ok(env.calls.noty.some((n) => n.indexOf('пойдёт плавно') > 0), env.calls.noty.join('|'));
        assert.ok(parseFloat(env.store.lw_line_peak) >= 60, 'скорость линии не запомнилась');
    });

    await test('ссылка потока с «&play» тоже замеряется: меняется на «&preload»', async () => {
        const env = makeEnv({ playParam: 'play' });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.calls.stat.length > 0);
        assert.ok(env.calls.stat[0].indexOf('&preload') > 0 && env.calls.stat[0].indexOf('&play') < 0);
    });

    await test('медленно: вердикт «не рекомендую», подсказки и кнопка «версию полегче»', async () => {
        const env = makeEnv({ stat: () => ({ download_speed: 0.2e6, active_peers: 3, connected_seeders: 2, preloaded_bytes: 1, preload_size: 1e12 }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('HDR').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');

        await waitFor(() => env.text().indexOf('Не рекомендую') >= 0, 2500);

        const t = env.text();
        assert.ok(t.indexOf('Скорость 1.6 Мбит/с') >= 0, t);
        assert.ok(t.indexOf('Мало раздающих') >= 0, 'нет подсказки про раздающих');
        assert.ok(t.indexOf('версию полегче') >= 0);
        assert.ok(t.indexOf('Всё равно смотреть') >= 0);
        assert.strictEqual(env.calls.played.length, 0, 'запустился сам, хотя будет лагать');
    });

    await test('«Взять версию полегче»: закрывает список файлов Лампы и запускает более лёгкую раздачу', async () => {
        const env = makeEnv({ stat: () => ({ download_speed: 3e6, active_peers: 10, connected_seeders: 6, preloaded_bytes: 1, preload_size: 1e12 }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('HDR').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.text().indexOf('версию полегче') >= 0, 2500);

        const first = env.calls.torrent[0];
        env.press('версию полегче');

        await waitFor(() => env.calls.torrent.length === 2);
        assert.strictEqual(env.calls.back, 1, 'окно списка файлов не закрыто');
        assert.notStrictEqual(env.calls.torrent[1], first);
        assert.ok(env.calls.torrent[1].Title.indexOf('1080p') > 0, env.calls.torrent[1].Title);
    });

    await test('«Всё равно смотреть» запускает выбранный файл', async () => {
        const env = makeEnv({ stat: () => ({ download_speed: 0.3e6, active_peers: 3, connected_seeders: 2, preloaded_bytes: 1, preload_size: 1e12 }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.text().indexOf('Всё равно смотреть') >= 0, 2500);
        env.press('Всё равно смотреть');
        assert.strictEqual(env.calls.played.length, 1);
    });

    await test('замер не удался: уведомление и запуск как есть', async () => {
        const env = makeEnv({ stat: () => null });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.calls.played.length === 1, 2500);
        assert.ok(env.calls.noty.some((n) => n.indexOf('не удалось') > 0));
    });

    await test('кнопка «Пропустить и запустить» отменяет замер и запускает файл', async () => {
        const env = makeEnv({ stat: () => ({ download_speed: 1e6, preloaded_bytes: 1, preload_size: 1e12 }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.text().indexOf('Проверяю скорость') >= 0 || env.text().indexOf('TorrServer качает') >= 0);
        env.press('Пропустить');
        assert.strictEqual(env.calls.played.length, 1);
        await sleep(250);
        assert.strictEqual(env.calls.played.length, 1, 'запустилось повторно после замера');
    });

    await test('«Запускать сразу»: карточка результата пропускается, торрент стартует сам', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('После поиска').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.calls.torrent.length === 1);
        assert.ok(env.calls.noty[0].indexOf('Выбрано') === 0);
    });

    await test('сериал: выбранная серия сезона запускается сама, остальные не трогаются', async () => {
        const dark = [
            R('Тьма / Dark (2017-2020) (Сезон: 1-3) WEB-DL 1080p Rus', 90, 40),
            R('Тьма / Dark (2019) S02 WEB-DL 1080p Rus', 30, 60)
        ];
        const env = makeEnv({
            parser: (o, ok) => ok({ Results: dark }),
            files: () => [1, 2, 3, 4].map((n) => ({ id: n, path: 'Dark.S02/Dark.S02E0' + n + '.mkv', length: 3 * GB, season: 2, episode: n }))
        });

        env.card(SERIES).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Сезон').trigger('hover:enter'); // короткий список листается по кругу: сезон 2
        assert.strictEqual(env.row('Сезон').find('.lw-row__val').text(), 'Сезон 2');
        env.row('Серия').trigger('hover:enter');
        env.calls.selects[0].onSelect(env.calls.selects[0].items[3]); // серия 3
        env.row('После поиска').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.calls.torrent.length === 1);
        assert.ok(env.calls.parser[0].search.indexOf('S02') > 0, env.calls.parser[0].search);
        assert.ok(env.calls.torrent[0].Title.indexOf('S02') > 0, 'взят не второй сезон');

        await waitFor(() => env.calls.played.length === 1, 2500);
        assert.strictEqual(env.calls.played[0].episode, 3);
    });

    await test('смена сезона сбрасывает выбранную серию', async () => {
        const env = makeEnv();
        env.card(SERIES).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Серия').trigger('hover:enter');
        env.calls.selects[0].onSelect(env.calls.selects[0].items[5]);
        assert.strictEqual(env.row('Серия').find('.lw-row__val').text(), 'Серия 5');
        env.row('Сезон').trigger('hover:enter');
        assert.strictEqual(env.row('Серия').find('.lw-row__val').text(), 'Выбрать в списке');
    });

    await test('сериал без выбранной серии: список файлов остаётся Лампе, сами ничего не нажимаем', async () => {
        const env = makeEnv({
            parser: (o, ok) => ok({ Results: [R('Тьма / Dark (2017) S01 WEB-DL 1080p Rus', 30, 60)] }),
            files: () => [1, 2].map((n) => ({ id: n, path: 'Dark.S01E0' + n + '.mkv', length: 3 * GB, season: 1, episode: n }))
        });

        env.card(SERIES).find('.lw-watch-btn').trigger('hover:enter');
        env.row('После поиска').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.calls.torrent.length === 1);
        await sleep(300);
        assert.strictEqual(env.calls.played.length, 0);
        assert.ok(!env.text().includes('Проверяю скорость'));
    });

    await test('ничего не нашлось: окно с предложением поменять пожелания, уточнить поиск или открыть список', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [FIGHT[3]] }) }); // только CAM
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Ничего не нашлось') >= 0);
        assert.ok(env.text().indexOf('Пожелания') >= 0 && env.text().indexOf('Обычный список Лампы') >= 0 && env.text().indexOf('Уточнить поиск') >= 0);
        env.press('Обычный список Лампы');
        assert.strictEqual(env.calls.activity[0].component, 'torrents');
        assert.strictEqual(env.calls.activity[0].movie, MOVIE);
    });

    await test('парсер вернул ошибку: понятное сообщение, а не тишина', async () => {
        const env = makeEnv({ parser: (o, ok, fail) => fail('Не задана ссылка: Jackett'), store: { lw_parser_auto: false } });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Парсер не ответил') >= 0);
        assert.ok(env.text().indexOf('Не задана ссылка: Jackett') >= 0);
        assert.ok(env.top().el.find('.modal__button').first().text() === 'Подобрать парсер', 'первой кнопкой идёт «Подобрать парсер»');
    });

    await test('отмена поиска: поздний ответ парсера ничего не открывает', async () => {
        const env = makeEnv({ parser: (o, ok) => setTimeout(() => ok({ Results: FIGHT }), 60) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.calls.parser.length === 1);
        env.top().params.onBack();
        await sleep(150);

        assert.strictEqual(env.modals.length, 0);
        assert.ok(env.calls.parserCleared);
    });

    await test('если список файлов закрыли, не дождавшись, запуск не срабатывает позже сам', async () => {
        const env = makeEnv({
            files: () => []
        });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('После поиска').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.calls.torrent.length === 1);
        env.win.Lampa.Listener.send('torrent_file', { type: 'list_close' });

        // потом человек сам открывает другой торрент
        const item = env.$('<div></div>');
        const f = { id: 1, path: 'x.mkv', length: 1, url: 'http://ts/stream/x?link=h&index=1&preload' };
        item.on('hover:enter', () => env.calls.played.push(f));
        env.win.Lampa.Listener.send('torrent_file', { type: 'list_open', items: [f], params: { movie: MOVIE } });
        env.win.Lampa.Listener.send('torrent_file', { type: 'render', element: f, item, items: [f], params: { movie: MOVIE } });
        await sleep(100);
        assert.strictEqual(env.calls.played.length, 0);
    });

    await test('сбой модуля failover в общей сборке не мешает кнопке «Лучшая раздача»', async () => {
        if (!fs.existsSync(BUNDLE)) throw new Error('нет plugins/lampa_watch.js, сначала node build.js');

        const env = makeEnv({ bundle: true }); // у макета нет Torserver и SettingsApi: failover упадёт
        assert.strictEqual(env.card(MOVIE).find('.lw-watch-btn').length, 1);
    });


    // ----------------------------------------------------------- экран «Все раздачи»
    const MANY = (n) => Array.from({ length: n }, (x, i) => R('Fight Club (1999) BDRip 1080p AVC Rus #' + i, 8 + i * 0.1, 30 + i));
    const rowsOf = (env) => env.top().el.find('.lw-item');
    const toolOf = (env, label) => env.top().el.find('.lw-tool').filter((i, t) => env.$(t).text().indexOf(label) >= 0).first();
    const openList = async (env, movie) => {
        env.card(movie || MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Все раздачи');
        await waitFor(() => env.top().el.find('.lw-list').length === 1, 1500, 'список раздач');
    };
    const pickItem = (env, n, title) => {
        const sel = env.calls.selects[env.calls.selects.length - 1];
        const item = sel.items.filter((x) => x.title.indexOf(title) === 0)[0];
        if (!item) throw new Error('нет пункта «' + title + '», есть: ' + sel.items.map((x) => x.title).join(' | '));
        sel.onSelect(item);
    };

    await test('список: кнопка «Все раздачи» в пожеланиях ищет и открывает список со статистикой', async () => {
        const env = makeEnv();
        await openList(env);
        assert.strictEqual(rowsOf(env).length, 3); // камрип скрыт как мусор
        const text = env.text();
        assert.ok(text.indexOf('показано из 3') >= 0, text);
        assert.ok(text.indexOf('скрыто как мусор 1') >= 0);
        assert.ok(env.top().el.find('.lw-qrow').length >= 2); // полоски по качеству
        assert.ok(env.top().el.find('.lw-card').length === 4);
        assert.ok(env.top().el.find('.lw-badge--hot').filter((i, b) => env.$(b).text() === 'Лучшая').length === 1);
        assert.strictEqual(env.top().params.size, 'large');
        assert.strictEqual(env.calls.parser.length, 1);
    });

    await test('список: сортировка меняет порядок в том же окне и запоминается', async () => {
        const env = makeEnv();
        await openList(env);
        const modalsBefore = env.modals.length;

        toolOf(env, 'Сортировка').trigger('hover:enter');
        const sel = env.calls.selects[0];
        assert.strictEqual(sel.items.length, 7);
        assert.ok(sel.items.some((x) => x.title === 'По дате') && sel.items.some((x) => x.title === 'Просмотренные'));

        pickItem(env, 0, 'По раздающим');
        assert.strictEqual(env.modals.length, modalsBefore); // не открылось второе окно
        assert.strictEqual(env.calls.updates, 1);
        assert.ok(rowsOf(env).first().text().indexOf('BDRip') >= 0); // у раздачи 1080p больше всего раздающих (150)
        assert.strictEqual(env.store.lw_sort, 'seeds');
        assert.strictEqual(env.top().params.select, toolOf(env, 'Сортировка').get(0)); // фокус остался на кнопке

        pickItem(env, 0, 'По размеру');
        assert.ok(rowsOf(env).first().text().indexOf('Remux') >= 0 || rowsOf(env).first().text().indexOf('58') >= 0);
        assert.ok(toolOf(env, 'Сортировка').text().indexOf('По размеру') >= 0);
    });

    await test('список: сохранённая сортировка применяется при следующем открытии', async () => {
        const env = makeEnv();
        env.store.lw_sort = 'size';
        await openList(env);
        assert.ok(toolOf(env, 'Сортировка').text().indexOf('По размеру') >= 0);
        env.store.lw_sort = 'что-то левое';
        const env2 = makeEnv();
        env2.store.lw_sort = 'что-то левое';
        await openList(env2);
        assert.ok(toolOf(env2, 'Сортировка').text().indexOf('Лучшие по пожеланиям') >= 0);
    });

    await test('список: фильтр по качеству, счётчик на кнопке, сброс и показ мусора', async () => {
        const env = makeEnv();
        await openList(env);

        toolOf(env, 'Фильтры').trigger('hover:enter');
        const menu = env.calls.selects[0];
        const names = menu.items.map((x) => x.title);
        assert.ok(names.indexOf('Качество') >= 0 && names.indexOf('HDR') >= 0 && names.indexOf('Камрипы и чужие фильмы') >= 0);
        assert.ok(names.indexOf('Год') < 0); // у всех раздач один год: фильтр ничего не даст, в меню его нет
        assert.ok(names.indexOf('Сбросить фильтры') < 0); // пока ничего не выбрано

        pickItem(env, 0, 'Качество');
        const values = env.calls.selects[1].items.map((x) => x.title);
        assert.strictEqual(values[0], 'Любое');
        assert.ok(values.indexOf('4K · 2') >= 0 && values.indexOf('1080p · 1') >= 0, values.join('|'));

        pickItem(env, 1, '4K');
        assert.strictEqual(rowsOf(env).length, 2);
        assert.ok(toolOf(env, 'Фильтры').text().indexOf('· 1') >= 0);
        assert.strictEqual(env.top().params.select, toolOf(env, 'Фильтры').get(0));

        // второй фильтр сверху: HDR + 1080p ничего не даёт
        toolOf(env, 'Фильтры').trigger('hover:enter');
        pickItem(env, 2, 'Качество');
        pickItem(env, 3, '1080p');
        assert.strictEqual(rowsOf(env).length, 1);

        toolOf(env, 'Фильтры').trigger('hover:enter');
        assert.ok(env.calls.selects[4].items.some((x) => x.title === 'Сбросить фильтры'));
        pickItem(env, 4, 'Сбросить фильтры');
        assert.strictEqual(rowsOf(env).length, 3);
        assert.ok(toolOf(env, 'Фильтры').text().indexOf('·') < 0);

        toolOf(env, 'Фильтры').trigger('hover:enter');
        pickItem(env, 5, 'Камрипы и чужие фильмы');
        assert.strictEqual(rowsOf(env).length, 4);
        assert.ok(env.text().indexOf('скрыто как мусор') < 0);
    });

    await test('список: если под фильтры ничего нет, так и написано', async () => {
        const env = makeEnv();
        await openList(env);
        toolOf(env, 'Фильтры').trigger('hover:enter');
        pickItem(env, 0, 'HDR');
        pickItem(env, 1, 'Нет'); // без HDR остаётся только 1080p
        assert.strictEqual(rowsOf(env).length, 1);
        toolOf(env, 'Фильтры').trigger('hover:enter');
        pickItem(env, 2, 'Качество');
        pickItem(env, 3, '4K');
        assert.strictEqual(rowsOf(env).length, 0);
        assert.ok(env.top().el.find('.lw-empty').text().indexOf('ничего нет') >= 0);
        assert.strictEqual(env.top().el.find('.lw-tool').length, 4); // кнопки на месте, можно сбросить
    });

    await test('список: OK по раздаче открывает карточку, Назад возвращает на ту же строку', async () => {
        const env = makeEnv();
        await openList(env);
        const second = rowsOf(env).eq(1);
        const title = second.find('.lw-item__title').text();

        second.trigger('hover:enter');
        assert.ok(env.text().indexOf('Выбранная раздача') >= 0 && env.text().indexOf('Лучшая раздача') < 0 && env.text().indexOf(title.slice(0, 30)) >= 0, env.text());
        assert.strictEqual(env.modals.length, 1); // список закрыт, а не лежит под карточкой
        assert.ok(env.text().indexOf('Все раздачи') >= 0); // кнопка вернуться к списку

        env.top().params.onBack(); // Назад на пульте
        await waitFor(() => env.top().el.find('.lw-list').length === 1);
        assert.strictEqual(env.top().params.select, rowsOf(env).get(1));
        assert.strictEqual(env.modals.length, 1);

        // у лучшей раздачи подпись «Лучшая раздача»; «Все раздачи» из карточки возвращает в список
        rowsOf(env).eq(0).trigger('hover:enter');
        assert.ok(env.text().indexOf('Лучшая раздача') >= 0);
        env.press('Все раздачи');
        assert.ok(env.top().el.find('.lw-list').length === 1);
    });

    await test('список: из списка можно запустить раздачу и она запускается', async () => {
        const env = makeEnv();
        await openList(env);
        rowsOf(env).eq(0).trigger('hover:enter');
        env.press('Запустить');
        await waitFor(() => env.calls.torrent.length === 1, 1500, 'Torrent.start');
    });

    await test('список: больше 40 раздач показываются порциями по кнопке «Показать ещё»', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: MANY(65) }) });
        await openList(env);
        assert.strictEqual(rowsOf(env).length, 40);
        const more = env.top().el.find('.lw-more');
        assert.ok(more.text().indexOf('Показать ещё (25)') >= 0, more.text());

        more.trigger('hover:enter');
        assert.strictEqual(rowsOf(env).length, 65);
        assert.strictEqual(env.top().el.find('.lw-more').length, 0);
        assert.strictEqual(env.top().params.select, rowsOf(env).get(40)); // фокус на первой новой строке
    });

    await test('список: «Уточнить поиск» спрашивает запрос и ищет заново', async () => {
        const env = makeEnv();
        await openList(env);
        toolOf(env, 'Уточнить поиск').trigger('hover:enter');

        const ask = env.calls.inputs[0];
        assert.strictEqual(ask.free, true);
        assert.ok(ask.value.indexOf('Fight Club') >= 0);

        env.calls.inputCb('  Fight Club 2160p  ');
        await waitFor(() => env.calls.parser.length === 2 && env.top().el.find('.lw-list').length === 1);
        assert.strictEqual(env.calls.parser[1].search, 'Fight Club 2160p');
        assert.strictEqual(env.calls.parser[1].search_one, 'Fight Club 2160p');
        assert.ok(env.text().indexOf('Fight Club 2160p') >= 0); // запрос виден в шапке списка

        // следующее уточнение начинается с прошлого запроса
        toolOf(env, 'Уточнить поиск').trigger('hover:enter');
        assert.strictEqual(env.calls.inputs[1].value, 'Fight Club 2160p');

        // пустой ввод ничего не ломает: список на месте, поиск не запускался
        env.calls.inputCb('   ');
        assert.strictEqual(env.calls.parser.length, 2);
        assert.strictEqual(env.top().el.find('.lw-list').length, 1);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'modal');
    });

    await test('список: без ввода текста в Лампе «Уточнить поиск» сообщает об этом', async () => {
        const env = makeEnv({ noInput: true });
        await openList(env);
        toolOf(env, 'Уточнить поиск').trigger('hover:enter');
        assert.ok(env.calls.noty.some((t) => t.indexOf('нет ввода текста') >= 0));
        assert.strictEqual(env.top().el.find('.lw-list').length, 1);
    });

    await test('список: в Лампе без Modal.update окно пересоздаётся, а не дублируется', async () => {
        const env = makeEnv({ noUpdate: true });
        await openList(env);
        toolOf(env, 'Сортировка').trigger('hover:enter');
        pickItem(env, 0, 'По раздающим');
        assert.strictEqual(env.modals.length, 1);
        assert.strictEqual(env.calls.updates, 0);
        assert.ok(toolOf(env, 'Сортировка').text().indexOf('По раздающим') >= 0);
        assert.ok(rowsOf(env).first().text().indexOf('BDRip') >= 0);
    });

    await test('список: «Обычный список Лампы» открывает штатный экран торрентов', async () => {
        const env = makeEnv();
        await openList(env);
        toolOf(env, 'Обычный список Лампы').trigger('hover:enter');
        assert.strictEqual(env.calls.activity[0].component, 'torrents');
        assert.strictEqual(env.modals.length, 0);
    });

    await test('список: Назад из списка закрывает его и возвращает на карточку', async () => {
        const env = makeEnv();
        await openList(env);
        env.top().params.onBack();
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'content');
    });

    await test('список: если раздач нет совсем, сообщение «ничего не нашлось», а не пустой список', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [] }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Все раздачи');
        await waitFor(() => env.text().indexOf('Ничего не нашлось') >= 0);
        assert.ok(env.text().indexOf('Все раздачи (') < 0);
        assert.ok(env.text().indexOf('Уточнить поиск') >= 0);
    });

    await test('ничего подходящего, но раздачи есть: можно открыть «Все раздачи» с мусором и уточнить поиск', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [FIGHT[3]] }) }); // только камрип
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Ничего не нашлось') >= 0);
        assert.ok(env.text().indexOf('Все раздачи (1)') >= 0);

        env.press('Все раздачи (1)');
        assert.strictEqual(env.top().el.find('.lw-list').length, 1);
        assert.strictEqual(rowsOf(env).length, 1); // мусор показан, потому что больше ничего нет
        assert.strictEqual(env.modals.length, 1);
    });

    await test('уточнить поиск из окна «ничего не нашлось» запускает поиск по своему запросу', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: o.search === 'Fight Club 1999' ? FIGHT.slice(0, 3) : [] }) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Ничего не нашлось') >= 0);
        env.press('Уточнить поиск');
        env.calls.inputCb('Fight Club 1999');
        await waitFor(() => env.text().indexOf('Запустить') >= 0, 1500, 'карточка лучшей раздачи');
        assert.strictEqual(env.calls.parser[1].search, 'Fight Club 1999');
    });

    await test('карточка лучшей раздачи: «Назад» без списка возвращает на карточку фильма', async () => {
        const env = makeEnv();
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.top().params.onBack();
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'content');
    });


    // ----------------------------------------------------------- автоподбор парсера
    const TRACKERS = ['rutracker', 'kinozal', 'rutor', 'nnmclub', 'bitru', 'megapeer', 'toloka', 'mazepa'];
    const jackettJson = (trackers, n) => ({ Results: Array.from({ length: n }, (x, i) => ({ Title: 'Бойцовский клуб / Fight Club (1999) BDRip 1080p #' + i, Tracker: trackers[i % trackers.length], Seeders: 10 + i, Size: 1e10 })) });
    // живы только два публичных парсера, ваш http://mine:9117 молчит
    const goodNet = (url) => url.indexOf('https://jac.red/api/v2.0') === 0 ? jackettJson(TRACKERS, 40) : url.indexOf('https://jr.maxvol.pro/api/v2.0') === 0 ? jackettJson(TRACKERS.slice(2), 30) : null;
    const MINE = { parser_torrent_type: 'jackett', jackett_url: 'http://mine:9117', parser_use_link: 'one' };
    const param = (env, name) => env.calls.settings.params.filter((p) => p.param.name === name)[0];
    const startSearch = (env) => {
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
    };

    await test('настройки: раздел Lampa Watch, кнопки подбора и отката, переключатель автопочинки', async () => {
        const env = makeEnv({ store: MINE });
        const comp = env.calls.settings.components[0];

        assert.strictEqual(comp.component, 'lampa_watch');
        assert.deepStrictEqual(env.calls.settings.params.map((p) => p.param.name), ['lw_health_open', 'lw_parser_title', 'lw_parser_pick', 'lw_parser_rollback', 'lw_parser_auto', 'lw_prefetch', 'lw_tune_title', 'lw_tune_pick', 'lw_tune_rollback']);
        assert.strictEqual(param(env, 'lw_parser_pick').param.type, 'button');
        assert.strictEqual(param(env, 'lw_parser_auto').param.type, 'trigger');
        assert.strictEqual(param(env, 'lw_parser_auto').param.default, true);

        const item = env.$('<div><div class="settings-param__descr"></div></div>');

        param(env, 'lw_parser_pick').onRender(item);
        assert.strictEqual(item.find('.settings-param__descr').text(), 'Сейчас: Jackett: mine:9117');

        const back = env.$('<div><div class="settings-param__descr"></div></div>');

        param(env, 'lw_parser_rollback').onRender(back);
        assert.ok(back.find('.settings-param__descr').text().indexOf('Копии нет') === 0);
    });

    await test('парсер не отвечает: плагин сам подбирает другой, записывает его и повторяет поиск', async () => {
        let env;

        env = makeEnv({ store: MINE, net: goodNet, parser: (o, ok, fail) => (env.store.jackett_url === 'https://jac.red' ? ok({ Results: FIGHT }) : fail('Парсер не отвечает (http://mine:9117)')) });
        startSearch(env);

        await waitFor(() => env.text().indexOf('подбираю другой') >= 0, 1500, 'окно подбора');

        await waitFor(() => env.text().indexOf('Запустить') >= 0, 3000, 'карточка лучшей раздачи после повтора');

        assert.strictEqual(env.store.jackett_url, 'https://jac.red');
        assert.deepStrictEqual(env.calls.native.map((u) => u.split('/api')[0]).sort(), ['http://mine:9117', 'https://jac.red', 'https://jr.maxvol.pro'], 'проверены ваш и два публичных');
        assert.strictEqual(env.calls.parser.length, 2, 'поиск повторён один раз');
        assert.ok(env.calls.noty.some((t) => t.indexOf('Парсер переключён') === 0), env.calls.noty.join(' | '));
        assert.strictEqual(env.store.lw_parser_backup.values.jackett_url, 'http://mine:9117');
        assert.strictEqual(env.store.parser_use, 'true');
    });

    await test('автопочинка выключена: кнопка «Подобрать парсер» показывает проверку и результат, «Применить» повторяет поиск', async () => {
        let env;

        env = makeEnv({ store: Object.assign({ lw_parser_auto: false }, MINE), net: goodNet, parser: (o, ok, fail) => (env.store.jackett_url === 'https://jac.red' ? ok({ Results: FIGHT }) : fail('нет связи')) });
        startSearch(env);

        await waitFor(() => env.text().indexOf('нет связи') >= 0);
        assert.strictEqual(env.calls.native.length, 0, 'без разрешения ничего не проверяем');

        env.press('Подобрать парсер');
        await waitFor(() => env.text().indexOf('Применить') >= 0, 3000, 'результат проверки');

        const text = env.text();

        assert.ok(text.indexOf('Лучший вариант') >= 0 && text.indexOf('jac.red') >= 0 && text.indexOf('Что изменится') >= 0);
        assert.ok(text.indexOf('8 трекеров') >= 0, 'плашки: ' + text.slice(0, 200));
        assert.ok(env.top().el.find('.lw-prow--best').length >= 1);
        assert.ok(env.top().el.find('.lw-prow--bad').length >= 1, 'ваш парсер отмечен как не ответивший');
        assert.strictEqual(env.store.jackett_url, 'http://mine:9117', 'до «Применить» настройки целы');

        env.press('Применить');
        await waitFor(() => env.text().indexOf('Запустить') >= 0, 3000, 'карточка после повтора');
        assert.strictEqual(env.store.jackett_url, 'https://jac.red');
        assert.strictEqual(env.calls.parser.length, 2);
    });

    await test('парсер не нашёлся: советы, «Повторить» проверяет снова, «Закрыть» возвращает к кнопке подбора', async () => {
        const env = makeEnv({ store: MINE, net: () => null, parser: (o, ok, fail) => fail('нет связи') });
        startSearch(env);

        await waitFor(() => env.text().indexOf('Рабочий парсер не найден') >= 0, 3000, 'окно «не найден»');
        assert.ok(env.text().indexOf('Проверьте, что на устройстве есть интернет') >= 0);
        assert.ok(env.top().el.find('.lw-prow--bad').length >= 3);

        const before = env.calls.native.length;

        env.press('Повторить');
        await waitFor(() => env.text().indexOf('Рабочий парсер не найден') >= 0 && env.calls.native.length > before, 3000, 'повторная проверка');

        env.press('Закрыть');
        assert.ok(env.text().indexOf('Парсер не ответил') >= 0 && env.text().indexOf('нет связи') >= 0);
        assert.strictEqual(env.top().el.find('.modal__button').first().text(), 'Подобрать парсер');
        assert.strictEqual(env.calls.parser.length, 1, 'без рабочего парсера повторного поиска нет');
    });

    await test('отмена подбора: окно закрывается, фокус возвращается на карточку, поздние ответы молчат', async () => {
        const env = makeEnv({ store: MINE, net: goodNet, parser: (o, ok, fail) => fail('нет связи') });
        startSearch(env);

        await waitFor(() => env.text().indexOf('подбираю другой') >= 0);
        env.top().params.onBack();

        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'content');

        await sleep(150);
        assert.strictEqual(env.modals.length, 0, 'поздние ответы ничего не открыли');
        assert.strictEqual(env.store.jackett_url, 'http://mine:9117');
    });

    await test('из настроек: подбор, «Применить», потом «Откатить» возвращает прежние значения', async () => {
        const env = makeEnv({ store: Object.assign({ parser_use: true }, MINE), net: goodNet });
        const done = [];

        param(env, 'lw_parser_pick').onChange();
        await waitFor(() => env.text().indexOf('Применить') >= 0, 3000, 'результат проверки');
        env.press('Применить');

        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.store.jackett_url, 'https://jac.red');
        assert.ok(env.calls.noty.some((t) => t.indexOf('Парсер настроен') === 0));
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'settings_component', 'фокус вернулся в настройки');

        const back = env.$('<div><div class="settings-param__descr"></div></div>');

        param(env, 'lw_parser_rollback').onRender(back);
        assert.ok(back.find('.settings-param__descr').text().indexOf('Копия от') === 0, back.text());

        param(env, 'lw_parser_rollback').onChange();
        assert.strictEqual(env.store.jackett_url, 'http://mine:9117');
        assert.ok(env.calls.noty.indexOf('Настройки парсера возвращены') >= 0);

        param(env, 'lw_parser_rollback').onChange();
        assert.ok(env.calls.noty.indexOf('Откатывать нечего') >= 0);
    });

    await test('из настроек: если текущий парсер уже лучший, окно так и говорит и ничего не предлагает менять', async () => {
        const env = makeEnv({
            store: { parser_torrent_type: 'jackett', jackett_url: 'https://jac.red', parser_use_link: 'one', parser_use: true },
            net: (url) => (url.indexOf('https://jac.red/api/v2.0') === 0 ? jackettJson(TRACKERS, 40) : null)
        });

        param(env, 'lw_parser_pick').onChange();
        await waitFor(() => env.text().indexOf('Менять ничего не нужно') >= 0, 3000, 'окно «менять не нужно»');
        assert.ok(env.top().el.find('.modal__button').filter((i, b) => env.$(b).text() === 'Применить').length === 0);
        env.press('Закрыть');
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'settings_component');
        assert.ok(!env.store.lw_parser_backup, 'копия отката не создаётся без изменений');
    });


    // ----------------------------------------------------------- автонастройка TorrServer
    const TS_REAL = () => ({
        CacheSize: 6442450944, ReaderReadAHead: 95, PreloadCache: 20, UseDisk: false, RetrackersMode: 2, TrackersListURL: '', EnableRutorSearch: false,
        EnableTorznabSearch: false, DisableTCP: false, DisableUTP: false, DisableDHT: false, DisablePEX: false, DownloadRateLimit: 0, ConnectionsLimit: 150,
        TMDBSettings: { APIKey: '' }
    });
    const TS_STORE = { torrserver_url: 'http://ts:8090' };

    await test('настройка TorrServer: сервер читается, изменения объяснены, «Применить» пишет их, «Откатить» возвращает', async () => {
        const server = TS_REAL();
        const env = makeEnv({ store: TS_STORE, server });

        param(env, 'lw_tune_pick').onChange();
        await waitFor(() => env.text().indexOf('Предлагаю') >= 0, 2000, 'предложение изменений');

        const text = env.text();

        assert.ok(text.indexOf('Предлагаю 4 изменения') >= 0, text.slice(0, 120));
        ['Встроенный поиск Rutor', 'Трекеры в раздачах', 'Список открытых трекеров', 'Предзагрузка перед стартом'].forEach((n) => assert.ok(text.indexOf(n) >= 0, n));
        assert.ok(text.indexOf('удалять трекеры раздачи') >= 0 && text.indexOf('добавлять открытые трекеры') >= 0);
        assert.ok(text.indexOf('перезапускает торрент-клиент') >= 0 && text.indexOf('6 ГБ') >= 0);
        assert.strictEqual(server.RetrackersMode, 2, 'до «Применить» сервер не тронут');

        env.press('Применить');
        await waitFor(() => env.calls.noty.some((t) => t.indexOf('TorrServer настроен') === 0), 2000, 'уведомление о настройке');

        assert.strictEqual(server.RetrackersMode, 1);
        assert.strictEqual(server.EnableRutorSearch, true);
        assert.strictEqual(server.PreloadCache, 1);
        assert.deepStrictEqual(server.TMDBSettings, { APIKey: '' }, 'остальные поля целы');
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'settings_component');

        const item = env.$('<div><div class="settings-param__descr"></div></div>');

        param(env, 'lw_tune_rollback').onRender(item);
        assert.ok(item.find('.settings-param__descr').text().indexOf('Копия от') === 0);

        param(env, 'lw_tune_rollback').onChange();
        await waitFor(() => env.calls.noty.indexOf('Настройки TorrServer возвращены') >= 0, 2000, 'откат');
        assert.deepStrictEqual(server, TS_REAL());

        param(env, 'lw_tune_rollback').onChange();
        assert.ok(env.calls.noty.indexOf('Откатывать нечего') >= 0);
    });

    await test('настройка TorrServer: если всё уже хорошо, окно так и говорит и ничего не предлагает', async () => {
        const server = TS_REAL();

        Object.assign(server, { RetrackersMode: 1, TrackersListURL: 'https://x/list.txt', EnableRutorSearch: true, PreloadCache: 1 });

        const env = makeEnv({ store: TS_STORE, server });

        param(env, 'lw_tune_pick').onChange();
        await waitFor(() => env.text().indexOf('Сервер уже настроен хорошо') >= 0, 2000, 'окно «всё хорошо»');
        assert.ok(env.top().el.find('.modal__button').filter((i, b) => env.$(b).text() === 'Применить').length === 0);

        env.press('Закрыть');
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'settings_component');
        assert.ok(!env.store.lw_ts_backup);
    });

    await test('настройка TorrServer: сервер не отвечает, понятная ошибка с «Повторить»', async () => {
        const env = makeEnv({ store: TS_STORE, server: TS_REAL(), serverDown: true });

        param(env, 'lw_tune_pick').onChange();
        await waitFor(() => env.text().indexOf('Не удалось настроить TorrServer') >= 0, 2000, 'окно ошибки');
        assert.ok(env.text().indexOf('TorrServer не ответил') >= 0);

        const before = env.calls.stat.length;

        env.press('Повторить');
        await waitFor(() => env.text().indexOf('Не удалось настроить TorrServer') >= 0, 2000, 'повторная ошибка');

        env.press('Закрыть');
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'settings_component');
    });

    await test('настройка TorrServer: отмена во время чтения закрывает окно, поздний ответ молчит', async () => {
        const env = makeEnv({ store: TS_STORE, server: TS_REAL() });

        param(env, 'lw_tune_pick').onChange();
        assert.ok(env.text().indexOf('Читаю настройки TorrServer') >= 0);
        env.top().params.onBack();
        assert.strictEqual(env.modals.length, 0);

        await sleep(60);
        assert.strictEqual(env.modals.length, 0);
    });


    // ---------------------------------------------------------------- запас перед стартом

    const HEAVY = [R('Fight Club (1999) UHD BDRemux 2160p HEVC HDR10 Dolby Vision | Dub', 40, 40)];
    const heavyEnv = (extra) => makeEnv(Object.assign({ parser: (o, ok) => ok({ Results: HEAVY }) }, extra));
    const heavyStart = async (env) => {
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Нужен запас перед стартом') >= 0, 2000, 'окно результата с запасом');
    };

    await test('запас: у тяжёлой раздачи в результате «Нужен запас», объём и время, главная кнопка «Накопить запас и смотреть»', async () => {
        const env = heavyEnv();

        await heavyStart(env);

        const t = env.text();
        assert.ok(/около \d[\d,]* ГБ \(≈ \d+ мин\)/.test(t), t);
        const names = env.top().el.find('.modal__button').map((i, b) => env.$(b).text()).get();
        assert.deepStrictEqual(names.slice(0, 2), ['Накопить запас и смотреть', 'Запустить сразу']);
    });

    await test('запас: лёгкая раздача обычная кнопка «Запустить», блока про запас нет', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [FIGHT[2]] }) });

        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);

        assert.ok(env.text().indexOf('Нужен запас') < 0);
        assert.ok(env.text().indexOf('Накопить запас') < 0);
    });

    await test('запас: «Запустить сразу» запускает без замера скорости', async () => {
        const env = heavyEnv();

        await heavyStart(env);
        env.press('Запустить сразу');
        await waitFor(() => env.calls.played.length === 1, 2000, 'запуск без замера');
        assert.strictEqual(env.calls.stat.length, 0, 'замер всё же шёл');
    });

    await test('запас: «Накопить запас и смотреть» меряет скорость, показывает процент и сам запускает, когда запаса хватит', async () => {
        const st = { phase: 'measure', fill: 0 };
        const env = heavyEnv({ stat: () => ({ download_speed: 4e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: st.phase === 'measure' ? 1 : st.fill, preload_size: 1e12 }) });

        await heavyStart(env);
        env.press('Накопить запас и смотреть');
        await waitFor(() => env.text().indexOf('Копим запас') >= 0, 3000, 'экран запаса');

        assert.strictEqual(env.calls.played.length, 0);
        await waitFor(() => env.text().indexOf('Мбит/с') > 0, 1000, 'скорость на экране запаса');
        assert.ok(env.top().el.find('.lw-big').length === 1 && env.text().indexOf('накоплено') > 0);

        st.phase = 'half';
        st.fill = 3.6e9;
        await waitFor(() => parseInt(env.top().el.find('.lw-big__n').text(), 10) >= 40, 2000, 'процент вырос');

        const pct = parseInt(env.top().el.find('.lw-big__n').text(), 10);
        assert.ok(pct > 40 && pct < 60, 'процент ' + pct);
        assert.ok(/из \d[\d,]* ГБ/.test(env.text()), env.text());
        assert.strictEqual(env.calls.played.length, 0, 'запустилось раньше времени');

        st.fill = 9e9;
        await waitFor(() => env.calls.played.length === 1, 2000, 'автозапуск');
        assert.ok(env.calls.noty.some((n) => n.indexOf('Запас накоплен') === 0), env.calls.noty.join('|'));
        assert.strictEqual(env.modals.length, 0, 'экран запаса остался');
    });

    await test('запас: «Начать сейчас» запускает сразу и останавливает опрос', async () => {
        const env = heavyEnv({ stat: () => ({ download_speed: 4e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e12 }) });

        await heavyStart(env);
        env.press('Накопить запас и смотреть');
        await waitFor(() => env.text().indexOf('Копим запас') >= 0, 3000);
        env.press('Начать сейчас');
        assert.strictEqual(env.calls.played.length, 1);

        const n = env.calls.stat.length;
        await sleep(80);
        assert.strictEqual(env.calls.stat.length, n, 'опрос не остановился');
    });

    await test('запас: «Отмена» не запускает фильм и закрывает окно файлов у Лампы', async () => {
        const env = heavyEnv({ stat: () => ({ download_speed: 4e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e12 }) });

        await heavyStart(env);
        env.press('Накопить запас и смотреть');
        await waitFor(() => env.text().indexOf('Копим запас') >= 0, 3000);

        const back = env.calls.back;
        env.press('Отмена');
        await sleep(300);
        assert.strictEqual(env.calls.played.length, 0);
        assert.strictEqual(env.calls.back, back + 1);
        assert.strictEqual(env.modals.length, 0);
    });

    await test('запас: если запас перестал расти, фильм всё равно запускается и об этом сказано', async () => {
        const st = { stall: false };
        const env = heavyEnv({ stat: () => ({ download_speed: 4e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: st.stall ? 5e8 : 1, preload_size: 1e12 }) });

        await heavyStart(env);
        env.press('Накопить запас и смотреть');
        await waitFor(() => env.text().indexOf('Копим запас') >= 0, 3000, 'экран запаса');
        st.stall = true;
        await waitFor(() => env.calls.played.length === 1, 4000, 'запуск после застоя');
        assert.ok(env.calls.noty.some((n) => n.indexOf('Запас перестал расти') === 0), env.calls.noty.join('|'));
    });

    await test('запас: сервер копит меньше нужного: честный совет вместо экрана накопления', async () => {
        const env = heavyEnv({ stat: () => ({ download_speed: 4e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e9 }) });

        await heavyStart(env);
        env.press('Накопить запас и смотреть');
        await waitFor(() => env.text().indexOf('копит запас только до') >= 0, 3000, 'совет про предел сервера');

        assert.ok(env.text().indexOf('Копим запас') < 0);
        const names = env.top().el.find('.modal__button').map((i, b) => env.$(b).text()).get();
        assert.ok(names.every((n) => n.indexOf('Накопить запас') < 0), names.join('|'));
    });

    await test('запас: после замера «Накопить запас» есть и в окне вердикта, если запускали обычной кнопкой', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [R('Fight Club (1999) BDRip 1080p AVC Дубляж', 9, 150)] }), stat: () => ({ download_speed: 0.9e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e12 }) });

        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.text().indexOf('Накопить запас и смотреть') >= 0, 3000, 'вердикт с запасом');
        assert.ok(env.text().indexOf('Нужен запас перед стартом') >= 0);
        assert.ok(env.text().indexOf('Если запустить и подождать') < 0, 'совет «подождать» должен уступить блоку про запас');
    });

    // ---------------------------------------------------------------- сериал: следующая серия

    const DARK = [R('Тьма / Dark (2019) S02 WEB-DL 1080p Rus Дубляж', 30, 60)];
    const darkFiles = (upTo) => () => Array.from({ length: upTo }, (x, i) => ({ id: i + 1, path: 'Dark.S02/Dark.S02E' + (i + 1) + '.mkv', length: 3 * GB, season: 2, episode: i + 1 }));
    const watchEpisode = async (env, n) => {
        env.card(SERIES).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Сезон').trigger('hover:enter'); // сезон 2
        env.row('Серия').trigger('hover:enter');
        env.calls.selects[env.calls.selects.length - 1].onSelect(env.calls.selects[env.calls.selects.length - 1].items[n]);
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0, 2000, 'результат сериала');
        env.press('Запустить');
        await waitFor(() => env.calls.played.length === 1, 3000, 'серия ' + n);
    };

    await test('сериал: без запомненной раздачи кнопки «следующая серия» нет', async () => {
        const env = makeEnv();
        const root = env.card(SERIES);

        assert.strictEqual(root.find('.lw-next-btn').length, 0);
        assert.strictEqual(root.find('.lw-watch-btn span').text(), 'Лучшая раздача');
    });

    await test('сериал: серия не досмотрена: «Серия 6 · продолжить · та же раздача», рядом «Другая раздача»', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: DARK }), files: darkFiles(10) });

        await watchEpisode(env, 6);

        const root = env.card(SERIES);
        assert.strictEqual(root.find('.lw-next-btn span').text(), 'Серия 6 · продолжить · та же раздача');
        assert.strictEqual(root.find('.lw-watch-btn span').text(), 'Другая раздача');
        assert.ok(root.find('.button--play').next().hasClass('lw-next-btn') && root.find('.lw-next-btn').next().hasClass('lw-watch-btn'), 'порядок кнопок');
    });

    await test('сериал: серия 6 досмотрена: главная кнопка предлагает серию 7 из той же раздачи, без поиска и замера', async () => {
        const state = { upTo: 0 };
        const env = makeEnv({ parser: (o, ok) => ok({ Results: DARK }), files: darkFiles(10), watched: (s, e) => (e <= state.upTo ? 95 : 0) });

        await watchEpisode(env, 6);
        state.upTo = 6;

        const root = env.card(SERIES);
        assert.strictEqual(root.find('.lw-next-btn span').text(), 'Серия 7 · та же раздача');

        const parserCalls = env.calls.parser.length;
        const statCalls = env.calls.stat.length;
        const title = env.calls.torrent[0].Title;

        root.find('.lw-next-btn').trigger('hover:enter');
        await waitFor(() => env.calls.played.length === 2, 3000, 'серия 7');

        assert.strictEqual(env.calls.parser.length, parserCalls, 'искали заново');
        assert.strictEqual(env.calls.stat.length, statCalls, 'мерили скорость заново');
        assert.strictEqual(env.calls.torrent[1].Title, title, 'раздача другая');
        assert.strictEqual(env.calls.played[1].episode, 7);
        assert.ok(env.calls.noty.some((n) => n.indexOf('Серия 7') === 0), env.calls.noty.join('|'));

        const next = env.card(SERIES).find('.lw-next-btn span').text();
        assert.strictEqual(next, 'Серия 7 · продолжить · та же раздача', 'запись должна сместиться на серию 7: ' + next);
    });

    await test('сериал: конец сезона: следующей серии нет, кнопка снова «Лучшая раздача»', async () => {
        const state = { pct: 0 };
        const env = makeEnv({ parser: (o, ok) => ok({ Results: DARK }), files: darkFiles(10), watched: () => state.pct });

        await watchEpisode(env, 8); // во втором сезоне 8 серий
        state.pct = 99;

        const root = env.card(SERIES);
        assert.strictEqual(root.find('.lw-next-btn').length, 0);
        assert.strictEqual(root.find('.lw-watch-btn span').text(), 'Лучшая раздача');
    });

    await test('сериал: в раздаче нет нужной серии: сказано об этом, раздача забыта', async () => {
        const state = { pct: 0 };
        const env = makeEnv({ parser: (o, ok) => ok({ Results: DARK }), files: darkFiles(6), watched: () => state.pct });

        await watchEpisode(env, 6);
        state.pct = 95;
        env.card(SERIES).find('.lw-next-btn').trigger('hover:enter');
        await waitFor(() => env.calls.noty.some((n) => n.indexOf('В этой раздаче нет серии 7') === 0), 2000, 'сообщение об отсутствии серии');

        assert.strictEqual(env.card(SERIES).find('.lw-next-btn').length, 0);
    });

    await test('сериал: фильмы раздачу не запоминают', async () => {
        const env = makeEnv({ stat: () => ({ download_speed: 8e6, active_peers: 20, connected_seeders: 9, preloaded_bytes: 1, preload_size: 1e12 }) });

        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter'); // 1080p
        env.press('Найти и смотреть');
        await waitFor(() => env.text().indexOf('Запустить') >= 0);
        env.press('Запустить');
        await waitFor(() => env.calls.played.length === 1, 3000);
        assert.ok(!env.store.lw_series || env.store.lw_series === '{}', env.store.lw_series);
    });

    // ---------------------------------------------------------------- быстрый поиск заранее

    const quick = { config: { prefetchDelay: 10 } };

    await test('поиск заранее: карточка открыта, парсер спрошен сам, а «Найти и смотреть» открывает результат без экрана поиска', async () => {
        const env = makeEnv(quick);
        const root = env.card(MOVIE);

        await waitFor(() => env.calls.parser.length === 1, 1000, 'поиск заранее');
        await sleep(20);

        root.find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        assert.ok(env.text().indexOf('Ищу раздачи') < 0, 'экран поиска показан');
        assert.ok(env.text().indexOf('Раздачи найдены заранее') >= 0, env.text());
        assert.strictEqual(env.calls.parser.length, 1, 'парсер спросили второй раз');
    });

    await test('поиск заранее: пожелания можно менять, найденное пересчитывается без нового запроса', async () => {
        const env = makeEnv(quick);
        const root = env.card(MOVIE);

        await waitFor(() => env.calls.parser.length === 1, 1000);
        await sleep(20);
        root.find('.lw-watch-btn').trigger('hover:enter');
        env.row('Качество').trigger('hover:enter'); // 1080p
        env.press('Найти и смотреть');

        assert.ok(env.text().indexOf('BDRip 1080p') >= 0, 'выбор не пересчитался под 1080p');
        assert.strictEqual(env.calls.parser.length, 1);
    });

    await test('поиск заранее: нажали «Найти» пока поиск ещё идёт: присоединяемся к нему, парсер спрошен один раз', async () => {
        const env = makeEnv({ config: { prefetchDelay: 5 }, parser: (o, ok) => setTimeout(() => ok({ Results: FIGHT }), 60) });
        const root = env.card(MOVIE);

        await waitFor(() => env.calls.parser.length === 1, 1000);
        root.find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        assert.ok(env.text().indexOf('Ищу раздачи') >= 0, 'экран поиска должен быть, пока ответа нет');

        await waitFor(() => env.text().indexOf('Запустить') >= 0, 2000, 'результат');
        assert.strictEqual(env.calls.parser.length, 1, 'парсер гоняли дважды');
    });

    await test('поиск заранее: выключено в настройках, парсер без просьбы не трогаем', async () => {
        const env = makeEnv({ config: { prefetchDelay: 5 }, store: { lw_prefetch: false } });

        env.card(MOVIE);
        await sleep(60);
        assert.strictEqual(env.calls.parser.length, 0);
        assert.strictEqual(env.win.__LW.watch.prefetchOn(), false);
    });

    await test('поиск заранее: «Уточнить поиск» своим запросом идёт заново, а не из найденного', async () => {
        const env = makeEnv(quick);
        const root = env.card(MOVIE);

        await waitFor(() => env.calls.parser.length === 1, 1000);
        await sleep(20);
        root.find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        env.press('Все раздачи');
        env.top().el.find('.lw-tool').filter((i, t) => env.$(t).text().indexOf('Уточнить поиск') >= 0).trigger('hover:enter');
        env.calls.inputCb('Fight Club 1999');
        await waitFor(() => env.calls.parser.length === 2, 1000, 'новый запрос');
        assert.strictEqual(env.calls.parser[1].search, 'Fight Club 1999');
    });

    await test('поиск заранее: пустой ответ не запоминается, нажатие кнопки ищет заново', async () => {
        const env = makeEnv({ config: { prefetchDelay: 5 }, parser: (o, ok) => ok({ Results: [] }) });
        const root = env.card(MOVIE);

        await waitFor(() => env.calls.parser.length === 1, 1000);
        await sleep(20);
        root.find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.calls.parser.length === 2, 1000, 'второй запрос');
    });

    await test('поиск заранее: найденное запоминается по фильму, сезону и запросу', async () => {
        const env = makeEnv(quick);

        env.card(MOVIE);
        await waitFor(() => env.calls.parser.length === 1, 1000);
        await sleep(20);

        const W = env.win.__LW.watch;
        assert.ok(W.cachedResults(MOVIE, 0, ''), 'найденное должно запомниться');
        assert.strictEqual(W.cachedResults(MOVIE, 0, 'Fight Club 1999'), null, 'другой запрос не должен брать чужое');
        assert.strictEqual(W.cachedResults({ id: 1 }, 0, ''), null, 'другой фильм не должен брать чужое');
    });

    // ---------------------------------------------------------------- диагностика

    const MANIFEST = (v) => ({ plugins: [{ id: 'lampa_watch', version: v }] });
    const diagNet = (version) => (url) => (/manifest\.json/.test(url) ? MANIFEST(version) : goodNet(url));
    const openDiag = async (env) => {
        env.win.__LW.version = '1.3.4';
        param(env, 'lw_health_open').onChange();
        await waitFor(() => env.top().el.find('.lw-dgc[data-level=run]').length === 0, 4000, 'все проверки завершены');
    };
    const card = (env, key) => env.top().el.find('.lw-dgc[data-key=' + key + ']');

    await test('диагностика: в настройках строка первой, у неё описание с версией до проверки', async () => {
        const env = makeEnv({ store: MINE });
        env.win.__LW.version = '1.3.4';

        assert.strictEqual(env.calls.settings.params[0].param.name, 'lw_health_open');

        const item = env.$('<div><div class="settings-param__descr"></div></div>');
        param(env, 'lw_health_open').onRender(item);
        assert.strictEqual(item.find('.settings-param__descr').text(), '1.3.4 · нажмите, чтобы проверить');
    });

    await test('диагностика: шесть плиток, у каждой значок, слово и значение; всё хорошо', async () => {
        const env = makeEnv({ store: Object.assign({ torrserver_url: 'http://ts:8090', parser_torrent_type: 'jackett', jackett_url: 'https://jac.red', parser_use_link: 'one' }), net: diagNet('1.3.4'), server: { CacheSize: 4e9, PreloadCache: 1 } });

        await openDiag(env);

        ['Версия плагина', 'Откуда загружен', 'Парсер', 'TorrServer', 'Плавность интерфейса', 'Последние ошибки'].forEach((n) => assert.ok(env.text().indexOf(n) >= 0, n));
        assert.strictEqual(env.top().el.find('.lw-dgc').length, 6);
        assert.ok(env.top().el.find('.lw-dgc').toArray().every((c) => env.$(c).find('.lw-hdot').text().length === 1 && env.$(c).find('.lw-dgc__w').text().length > 0), 'у плитки нет значка или слова');
        assert.strictEqual(card(env, 'version').attr('data-level'), 'ok');
        assert.ok(card(env, 'version').text().indexOf('Обновление не нужно') >= 0, card(env, 'version').text());
        assert.strictEqual(card(env, 'parser').attr('data-level'), 'ok');
        assert.ok(card(env, 'parser').text().indexOf('jac.red') >= 0 && /за \d[\d,]* с · \d+ раздач/.test(card(env, 'parser').text()), card(env, 'parser').text());
        assert.strictEqual(card(env, 'server').attr('data-level'), 'ok');
        assert.ok(card(env, 'server').text().indexOf('Предзагрузка 1%') >= 0 && card(env, 'server').text().indexOf('ts:8090') >= 0, card(env, 'server').text());
        assert.strictEqual(card(env, 'errors').attr('data-level'), 'ok');
        assert.ok(card(env, 'errors').text().indexOf('Ошибок нет') >= 0);
        assert.ok(/\d+ кадров\/с/.test(card(env, 'perf').text()), card(env, 'perf').text());
    });

    await test('диагностика: вышла новая версия: «Внимание», сказано, что делать', async () => {
        const env = makeEnv({ store: MINE, net: diagNet('1.9.0') });

        await openDiag(env);
        assert.strictEqual(card(env, 'version').attr('data-level'), 'warn');
        assert.ok(card(env, 'version').text().indexOf('Вышла версия 1.9.0') >= 0 && card(env, 'version').text().indexOf('Перезапустите Лампу') >= 0);
    });

    await test('диагностика: сайт обновлений недоступен: «Внимание», а не ошибка', async () => {
        const env = makeEnv({ store: MINE, net: () => null });

        await openDiag(env);
        assert.strictEqual(card(env, 'version').attr('data-level'), 'warn');
        assert.ok(card(env, 'version').text().indexOf('нет связи с сайтом обновлений') >= 0);
    });

    await test('диагностика: парсер молчит, TorrServer не задан: «Проблема» и «Внимание» с советами', async () => {
        const env = makeEnv({ store: MINE, net: () => null });

        await openDiag(env);
        assert.strictEqual(card(env, 'parser').attr('data-level'), 'bad');
        assert.ok(card(env, 'parser').text().indexOf('Подобрать парсер') >= 0);
        assert.strictEqual(card(env, 'server').attr('data-level'), 'warn');
        assert.ok(card(env, 'server').text().indexOf('Адрес не задан') >= 0);
    });

    await test('диагностика: TorrServer не отвечает: «Проблема» с причиной', async () => {
        const env = makeEnv({ store: Object.assign({ torrserver_url: 'http://ts:8090' }, MINE), net: () => null, server: { CacheSize: 1 }, serverDown: true });

        await openDiag(env);
        assert.strictEqual(card(env, 'server').attr('data-level'), 'bad');
        assert.ok(card(env, 'server').text().indexOf('TorrServer не ответил') >= 0, card(env, 'server').text());
    });

    await test('диагностика: сбой поиска попадает в журнал, а автоподбор парсера дописывает «что плагин сделал сам»', async () => {
        let env;

        env = makeEnv({ store: MINE, net: goodNet, parser: (o, ok, fail) => (env.store.jackett_url === 'https://jac.red' ? ok({ Results: FIGHT }) : fail('Парсер не отвечает (http://mine:9117)')) });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');
        await waitFor(() => env.win.__LW.health.errors().length >= 1, 3000, 'запись в журнале');

        const list = env.win.__LW.health.errors();
        assert.ok(list.length >= 1 && list[0].kind === 'parser' && list[0].text.indexOf('Парсер не ответил') >= 0, JSON.stringify(list));
    });

    await test('диагностика: журнал: плитка показывает последнюю запись, повтор подряд не плодит строки', async () => {
        const env = makeEnv({ store: MINE, net: diagNet('1.3.4') });
        const H = env.win.__LW.health;

        H.note('parser', 'Парсер не ответил', 'Плагин сам переключился на jac.red');
        H.note('parser', 'Парсер не ответил');
        assert.strictEqual(H.errors().length, 1);

        await openDiag(env);
        assert.strictEqual(card(env, 'errors').attr('data-level'), 'warn');
        assert.ok(card(env, 'errors').text().indexOf('Парсер не ответил') >= 0 && card(env, 'errors').text().indexOf('Плагин сам переключился на jac.red') >= 0, card(env, 'errors').text());
    });

    await test('диагностика: журнал хранит не больше 12 записей, новые сверху', async () => {
        const env = makeEnv();
        const H = env.win.__LW.health;

        for (let i = 0; i < 20; i++) H.note('watch', 'ошибка ' + i);
        assert.strictEqual(H.errors().length, 12);
        assert.strictEqual(H.errors()[0].text, 'ошибка 19');
    });

    await test('диагностика: «Откуда загружен»: короткая ссылка, полная, прямая и старая jsDelivr', async () => {
        const env = makeEnv();
        const C = env.win.__LW.health.classify;

        assert.strictEqual(C(['https://snowymay111.github.io/l.js'], '', true).value, 'Короткая ссылка');
        assert.strictEqual(C(['https://snowymay111.github.io/lampa-plugins/loader.js'], '', true).value, 'Полная ссылка');
        assert.strictEqual(C([], 'https://x.y/plugins/lampa_watch.js?v=1', false).level, 'warn');

        const old = C(['https://snowymay111.github.io/l.js', 'https://cdn.jsdelivr.net/gh/SnowyMay111/lampa-torrserver-failover@v1.0.0/torrserver_failover.js'], '', true);
        assert.strictEqual(old.level, 'warn');
        assert.strictEqual(old.old, 1);
        assert.ok(old.sub.indexOf('старая ссылка') >= 0);
    });

    await test('диагностика: версии сравниваются по числам: 1.3.10 новее 1.3.9', async () => {
        const env = makeEnv();
        const V = env.win.__LW.health.cmpVer;

        assert.strictEqual(V('1.3.10', '1.3.9'), 1);
        assert.strictEqual(V('1.3.3', '1.3.3'), 0);
        assert.strictEqual(V('1.2.9', '1.3.0'), -1);
        assert.strictEqual(V('2', '1.9.9'), 1);
    });

    await test('диагностика: плавность: 60 кадров/с хорошо, 20 плохо, мало кадров не выдумываем', async () => {
        const env = makeEnv();
        const F = env.win.__LW.health.summarizeFrames;
        const at = (step, n) => Array.from({ length: n }, (x, i) => i * step);

        assert.strictEqual(F(at(16.7, 60), 0).level, 'ok');
        assert.strictEqual(F(at(50, 30), 0).level, 'bad');
        assert.strictEqual(F(at(25, 40), 2).level, 'warn');
        assert.strictEqual(F([0, 16], 0).level, 'warn');
        assert.ok(F(at(16.7, 60), 3).sub.indexOf('долгих задач 3') >= 0);
    });

    await test('диагностика: итог проверки запоминается и показывается в строке настроек', async () => {
        const env = makeEnv({ store: MINE, net: diagNet('1.3.4') });

        await openDiag(env);

        const item = env.$('<div><div class="settings-param__descr"></div></div>');
        param(env, 'lw_health_open').onRender(item);
        assert.ok(/^1\.3\.4 · (всё в порядке|есть замечания|есть проблемы)$/.test(item.find('.settings-param__descr').text()), item.text());
    });

    await test('диагностика: «Проверить заново» и «Закрыть» работают, возврат фокуса в настройки', async () => {
        const env = makeEnv({ store: MINE, net: diagNet('1.3.4') });

        await openDiag(env);
        env.press('Проверить заново');
        assert.strictEqual(env.top().el.find('.lw-dgc[data-level=run]').length > 0, true);
        await waitFor(() => env.top().el.find('.lw-dgc[data-level=run]').length === 0, 4000, 'повторная проверка');
        env.press('Закрыть');
        assert.strictEqual(env.modals.length, 0);
        assert.strictEqual(env.calls.toggles[env.calls.toggles.length - 1], 'settings_component');
    });

    results.forEach(([ok, name]) => console.log((ok ? 'PASS  ' : 'FAIL  ') + name));
    const failed = results.filter((r) => !r[0]).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
