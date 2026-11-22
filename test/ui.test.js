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

    const calls = { noty: [], parser: [], torrent: [], played: [], back: 0, stat: [], selects: [], activity: [], toggles: [] };
    const store = {};
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
        close() { modals.pop().el.remove(); },
        opened: () => modals.length > 0
    };

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
        Lang: { translate: (k) => k },
        Activity: { push: (o) => calls.activity.push(o) },
        Controller: { toggle: (n) => calls.toggles.push(n), back: () => { calls.back++; } },
        Select: { show: (p) => calls.selects.push(p) },
        Parser: {
            get: (obj, ok, fail) => { calls.parser.push(obj); setTimeout(() => parserFn(obj, ok, fail), 2); },
            clear: () => { calls.parserCleared = true; }
        },
        Reguest: function () {
            this.timeout = () => {};
            this.clear = () => {};
            this.silent = (url, ok, fail) => {
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
    win.lampa_watch_config = { measureMs: 150, warmup: 20, interval: 15, settle: 5 };

    // Модули собираются так же, как в build.js
    const parts = opts.bundle ? [fs.readFileSync(BUNDLE, 'utf8')] : ['speed', 'score', 'watch'].map((name) =>
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

    await test('ничего не нашлось: окно с предложением поменять пожелания или открыть список', async () => {
        const env = makeEnv({ parser: (o, ok) => ok({ Results: [FIGHT[3]] }) }); // только CAM
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Ничего не нашлось') >= 0);
        assert.ok(env.text().indexOf('Пожелания') >= 0 && env.text().indexOf('Показать список') >= 0);
        env.press('Показать список');
        assert.strictEqual(env.calls.activity[0].component, 'torrents');
        assert.strictEqual(env.calls.activity[0].movie, MOVIE);
    });

    await test('парсер вернул ошибку: понятное сообщение, а не тишина', async () => {
        const env = makeEnv({ parser: (o, ok, fail) => fail('Не задана ссылка: Jackett') });
        env.card(MOVIE).find('.lw-watch-btn').trigger('hover:enter');
        env.press('Найти и смотреть');

        await waitFor(() => env.text().indexOf('Парсер не ответил') >= 0);
        assert.ok(env.text().indexOf('Не задана ссылка: Jackett') >= 0);
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

    results.forEach(([ok, name]) => console.log((ok ? 'PASS  ' : 'FAIL  ') + name));
    const failed = results.filter((r) => !r[0]).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
