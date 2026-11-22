// Проверка автоподбора парсера на макете сети и хранилища. Запуск: node test/parser.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Макет Лампы: хранилище и сеть, ответы которой задаёт тест
function makeEnv(initial) {
    const data = Object.assign({}, initial || {});
    const calls = [];
    const env = { routes: [], data, calls };

    const Storage = {
        get(k, def) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : def; },
        set(k, v) { data[k] = v; }
    };

    function Reguest() {
        let dead = false;

        this.timeout = () => {};
        this.clear = () => { dead = true; };

        const go = (url, ok, fail) => {
            calls.push(url);

            const route = env.routes.find((r) => url.indexOf(r.match) === 0);

            if (!route || route.fail) return setTimeout(() => { if (!dead) fail(); }, (route && route.delay) || 5);
            if (route.hang) return;

            setTimeout(() => { if (!dead) ok(route.json); }, route.delay || 5);
        };

        this.native = go;
        this.silent = go;
    }

    const window = { Lampa: { Storage, Reguest }, lampa_watch_config: { probeMs: 300 } };
    const ctx = vm.createContext({ LW: {}, window, console, setTimeout, clearTimeout, Date, Math, JSON, parseInt, isNaN, RegExp, Object, encodeURIComponent });

    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'parser.js'), 'utf8'), ctx, { filename: 'parser.js' });

    env.P = ctx.LW.parser;

    return env;
}

// Ответ Jackett: n раздач «Fight Club» от перечисленных трекеров
function jackett(trackers, n, seeders) {
    const out = [];

    for (let i = 0; i < n; i++) {
        out.push({ Title: 'Бойцовский клуб / Fight Club (1999) BDRip 1080p #' + i, Tracker: trackers[i % trackers.length], Seeders: seeders === undefined ? 10 + i : seeders, Size: 1e10 });
    }

    return { Results: out };
}

const MANY = ['rutracker', 'kinozal', 'rutor', 'nnmclub', 'bitru', 'megapeer', 'toloka', 'mazepa'];

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name + '\n      ' + e.message]); }
}

(async () => {
    // ----------------------------------------------------------- адреса и разбор
    await test('адрес: схема, косая черта, jacred.xyz превращается в jac.red', () => {
        const { P } = makeEnv();

        assert.strictEqual(P.cleanUrl('  jac.red/ '), 'http://jac.red');
        assert.strictEqual(P.cleanUrl('https://jacred.xyz//'), 'https://jac.red');
        assert.strictEqual(P.cleanUrl('192.168.1.5:9117'), 'http://192.168.1.5:9117');
        assert.strictEqual(P.cleanUrl(''), '');
        assert.strictEqual(P.hostOf('https://jr.maxvol.pro/api?x=1'), 'jr.maxvol.pro');
    });

    await test('запрос: у каждого типа парсера свой адрес, как у парсера Лампы', () => {
        const { P } = makeEnv();
        const cands = P.candidates({ type: 'jackett', used: [0], search: 'both', jackett: [{ url: 'http://j:9117', key: 'k 1' }, { url: '', key: '' }], prowlarr: [{ url: 'http://p:9696', key: 'pk' }, { url: '', key: '' }] }, 'http://ts:8090', []);
        const by = (type, p) => cands.find((c) => c.type === type && c.path === (p || ''));

        assert.strictEqual(P.probeUrl(by('jackett'), 'Fight Club'), 'http://j:9117/api/v2.0/indexers/all/results?apikey=k%201&Query=Fight%20Club');
        assert.strictEqual(P.probeUrl(by('prowlarr'), 'Fight Club'), 'http://p:9696/api/v1/search?apikey=pk&query=Fight%20Club');
        assert.strictEqual(P.probeUrl(by('torrserver', '/search/'), 'Fight Club'), 'http://ts:8090/search/?query=Fight%20Club');
        assert.strictEqual(P.probeUrl(by('torrserver', '/torznab/search/'), 'Fight Club'), 'http://ts:8090/torznab/search/?query=Fight%20Club');
    });

    await test('ответ: Jackett, Prowlarr и TorrServer приводятся к одному виду, чужое отвергается', () => {
        const { P } = makeEnv();
        const j = { type: 'jackett' }, pr = { type: 'prowlarr' }, ts = { type: 'torrserver' };

        assert.deepStrictEqual(plain(P.normalize(j, { Results: [{ Title: 'A', Tracker: 'rutor', Seeders: 5 }] })), [{ title: 'A', tracker: 'rutor', seeders: 5 }]);
        assert.deepStrictEqual(plain(P.normalize(pr, [{ title: 'B', indexer: 'x', seeders: '7', protocol: 'torrent' }, { title: 'N', indexer: 'u', seeders: 9, protocol: 'usenet' }])), [{ title: 'B', tracker: 'x', seeders: 7 }]);
        assert.deepStrictEqual(plain(P.normalize(ts, [{ Title: 'C', Tracker: 'rutor', Seed: 3 }])), [{ title: 'C', tracker: 'rutor', seeders: 3 }]);
        assert.deepStrictEqual(plain(P.normalize(j, { Results: [] })), []);
        assert.strictEqual(P.normalize(j, null), null);
        assert.strictEqual(P.normalize(j, { error: 'x' }), null);
        assert.strictEqual(P.normalize(ts, { Results: [] }), null);
        assert.strictEqual(P.normalize(pr, 'html'), null);
    });

    await test('оценка: много раздач и трекеров и быстрый ответ выше, пусто и «не по теме» ниже', () => {
        const { P } = makeEnv();
        const ev = (items, ms) => P.evaluate(P.normalize({ type: 'jackett' }, items), ms);
        const rich = P.rate(ev(jackett(MANY, 60), 900));
        const poor = P.rate(ev(jackett(['rutor'], 8), 900));
        const slow = P.rate(ev(jackett(MANY, 60), 9000));

        assert.ok(rich >= 85, 'богатый ' + rich);
        assert.ok(poor < rich / 2, 'бедный ' + poor);
        assert.ok(slow < rich && slow >= rich - 25, 'медленный ' + slow);
        assert.strictEqual(P.rate(ev({ Results: [] }.Results ? { Results: [] } : null, 100)), 0);
        assert.strictEqual(P.rate(ev({ Results: [{ Title: 'Другое кино', Tracker: 'x', Seeders: 5 }] }, 100)), 3);
        assert.strictEqual(P.evaluate([{ title: 'Fight Club', tracker: 'rutracker, rutor', seeders: 1 }], 1).trackers.length, 2);
    });

    await test('кандидаты: ваши ссылки отмечены, встроенный поиск TorrServer добавлен, повторы убраны', () => {
        const { P } = makeEnv();
        const cur = { type: 'jackett', used: [0, 1], search: 'both', jackett: [{ url: 'http://my:9117', key: 'a' }, { url: 'https://jac.red', key: '' }], prowlarr: [{ url: '', key: '' }, { url: '', key: '' }] };
        const cands = P.candidates(cur, 'http://ts:8090/', [{ type: 'jackett', url: 'https://jac.red/', name: 'jac.red' }, { type: 'jackett', url: 'https://jr.maxvol.pro', name: 'maxvol' }, { url: '' }]);

        assert.deepStrictEqual(plain(cands.map((c) => c.type + ' ' + c.url + c.path)), ['jackett http://my:9117', 'jackett https://jac.red', 'torrserver http://ts:8090/search/', 'torrserver http://ts:8090/torznab/search/', 'jackett https://jr.maxvol.pro']);
        assert.ok(cands[0].current && cands[1].current && !cands[4].current);
        assert.strictEqual(cands[1].origin, 'current');
    });

    // ----------------------------------------------------------- проверка по сети
    await test('проверка: живой парсер получает оценку, мёртвый и не-парсер отмечаются', async () => {
        const env = makeEnv();
        const { P } = env;

        env.routes = [
            { match: 'http://live', json: jackett(MANY, 40) },
            { match: 'http://down', fail: true },
            { match: 'http://html', json: { not: 'a parser' } },
            { match: 'http://hang', hang: true }
        ];

        const one = (url) => new Promise((ok) => P.probe({ type: 'jackett', url, key: '', path: '', name: url, id: url }, 'Fight Club', ok));
        const live = await one('http://live');
        const down = await one('http://down');
        const html = await one('http://html');
        const hang = await one('http://hang');

        assert.ok(live.ok && live.rating >= 80 && live.ev.trackers.length === 8);
        assert.ok(!down.ok && down.error === 'нет ответа' && down.rating === 0);
        assert.ok(!html.ok && /не похож/.test(html.error));
        assert.ok(!hang.ok && /не ответил/.test(hang.error), hang.error);
        assert.ok(env.calls[0].indexOf('Query=Fight%20Club') > 0);
    });

    await test('проверка всех: результаты идут по мере готовности и сортируются по оценке', async () => {
        const env = makeEnv();
        const { P } = env;
        const seen = [];

        env.routes = [
            { match: 'http://slow', json: jackett(MANY, 40), delay: 80 },
            { match: 'http://fast', json: jackett(['rutor'], 5), delay: 5 },
            { match: 'http://dead', fail: true }
        ];

        const list = ['slow', 'fast', 'dead'].map((n) => ({ type: 'jackett', url: 'http://' + n, key: '', path: '', name: n, id: n }));
        const res = await new Promise((ok) => P.probeAll(list, { onResult: (r, n, total) => seen.push(r.cand.name + ':' + n + '/' + total) }, ok));

        assert.deepStrictEqual(plain(res.map((r) => r.cand.name)), ['slow', 'fast', 'dead']);
        assert.strictEqual(seen.length, 3);
        assert.ok(seen[2].indexOf('slow') === 0, seen.join(','));
    });

    await test('отмена: после cancel прежняя проверка ничего не сообщает', async () => {
        const env = makeEnv();
        const { P } = env;
        let called = 0;

        env.routes = [{ match: 'http://x', json: jackett(MANY, 40), delay: 30 }];

        P.probeAll([{ type: 'jackett', url: 'http://x', key: '', path: '', name: 'x', id: 'x' }], { onResult: () => called++ }, () => called++);
        P.cancel();
        await sleep(100);

        assert.strictEqual(called, 0);
    });

    // ----------------------------------------------------------- выбор
    function fake(type, name, rating, ms, trackers, extra) {
        const c = Object.assign({ type, url: 'http://' + name, key: '', path: '', name, origin: 'seed', current: false, id: name }, extra || {});

        return { ok: rating > 0, cand: c, rating, ms, ev: { count: 50, relevant: 40, trackers, seeded: 40, ms }, error: '' };
    }

    await test('выбор: ваш парсер не отвечает, берётся лучший публичный и пишется в настройки', () => {
        const env = makeEnv({ jackett_url: 'http://mine', parser_torrent_type: 'jackett', parser_use_link: 'one' });
        const { P } = env;
        const cur = P.readCurrent();
        const mine = Object.assign(fake('jackett', 'mine', 0, 100, []), { ok: false });
        const a = fake('jackett', 'jac.red', 95, 900, MANY);
        const plan = P.choose([a, mine], cur);

        assert.strictEqual(plan.type, 'jackett');
        assert.strictEqual(plan.primary, a);
        assert.strictEqual(plan.settings.jackett_url, 'http://jac.red');
        assert.strictEqual(plan.settings.parser_torrent_type, 'jackett');
        assert.strictEqual(plan.settings.parser_use_link, 'one');
        assert.ok(plan.changed);
        assert.ok(plan.changes.some((c) => c.key === 'jackett_url' && c.from === 'http://mine'));
    });

    await test('выбор: свой хороший парсер остаётся, если он не сильно хуже лучшего', () => {
        const env = makeEnv({ jackett_url: 'http://mine', parser_torrent_type: 'jackett', parser_use_link: 'one', parser_use: true });
        const { P } = env;
        const mine = fake('jackett', 'mine', 85, 900, MANY.slice(0, 6), { origin: 'current', current: true, slot: 1 });
        const pub = fake('jackett', 'jac.red', 95, 900, MANY);
        const plan = P.choose([pub, mine], P.readCurrent());

        assert.strictEqual(plan.primary, mine);
        assert.strictEqual(plan.settings.jackett_url, 'http://mine');
        assert.ok(!plan.changed, 'менять нечего: ' + JSON.stringify(plan.changes));
    });

    await test('выбор: свой слабый парсер заменяется на сильно лучший', () => {
        const env = makeEnv({ jackett_url: 'http://mine', parser_torrent_type: 'jackett', parser_use: true });
        const { P } = env;
        const mine = fake('jackett', 'mine', 40, 900, ['rutor'], { origin: 'current', current: true, slot: 1 });
        const pub = fake('jackett', 'jac.red', 95, 900, MANY);
        const plan = P.choose([pub, mine], P.readCurrent());

        assert.strictEqual(plan.primary, pub);
    });

    await test('выбор: второй парсер включается, если даёт новые трекеры и не тормозит', () => {
        const env = makeEnv({ parser_torrent_type: 'jackett', parser_use: true });
        const { P } = env;
        const a = fake('jackett', 'a', 95, 900, MANY.slice(0, 5));
        const b = fake('jackett', 'b', 70, 1500, MANY.slice(3, 8));
        const plan = P.choose([a, b], P.readCurrent());

        assert.strictEqual(plan.mode, 'both');
        assert.strictEqual(plan.secondary, b);
        assert.strictEqual(plan.settings.parser_use_link, 'both');
        assert.strictEqual(plan.settings.jackett_url_two, 'http://b');
    });

    await test('выбор: второй не берётся, если нового почти нет или он слишком медленный', () => {
        const { P } = makeEnv({ parser_use: true });
        const a = fake('jackett', 'a', 95, 900, MANY.slice(0, 5));
        const same = fake('jackett', 'same', 90, 900, MANY.slice(0, 5));
        const slow = fake('jackett', 'slow', 70, 9000, MANY.slice(3, 8));

        assert.strictEqual(P.choose([a, same], P.readCurrent()).mode, 'one');
        assert.strictEqual(P.choose([a, slow], P.readCurrent()).mode, 'one');
    });

    await test('выбор: нет Jackett, но отвечает поиск TorrServer: переключаемся на него', () => {
        const { P } = makeEnv({ parser_torrent_type: 'jackett', parser_use: true });
        const rutor = fake('torrserver', 'ts', 35, 800, ['rutor'], { path: '/search/' });
        const torznab = fake('torrserver', 'ts', 30, 900, ['x'], { path: '/torznab/search/' });
        const dead = Object.assign(fake('jackett', 'd', 0, 5, []), { ok: false });

        const both = P.choose([rutor, torznab, dead], P.readCurrent());

        assert.strictEqual(both.type, 'torrserver');
        assert.strictEqual(both.settings.parser_torrent_type, 'torrserver');
        assert.strictEqual(both.settings.torrserver_search_type, 'both');
        assert.strictEqual(P.choose([rutor, dead], P.readCurrent()).settings.torrserver_search_type, 'rutor');
        assert.strictEqual(P.choose([torznab, dead], P.readCurrent()).settings.torrserver_search_type, 'torznab');
    });

    await test('выбор: ничего не отвечает, плана нет; бесполезный ответ не считается', () => {
        const { P } = makeEnv();
        const dead = Object.assign(fake('jackett', 'd', 0, 5, []), { ok: false });
        const empty = fake('jackett', 'e', 3, 100, []);

        assert.strictEqual(P.choose([dead, empty], P.readCurrent()), null);
        assert.strictEqual(P.choose([], P.readCurrent()), null);
    });

    await test('выбор: если «Использовать парсер» выключено, план его включает', () => {
        const { P } = makeEnv({ parser_use: false });
        const plan = P.choose([fake('jackett', 'a', 95, 900, MANY)], P.readCurrent());

        assert.strictEqual(plan.settings.parser_use, 'true');
    });

    await test('выбор: Prowlarr работает, Jackett нет: пишутся поля Prowlarr', () => {
        const { P } = makeEnv({ parser_torrent_type: 'jackett', parser_use: true });
        const pr = fake('prowlarr', 'prowl', 90, 900, MANY, { key: 'abc' });
        const plan = P.choose([pr], P.readCurrent());

        assert.strictEqual(plan.settings.parser_torrent_type, 'prowlarr');
        assert.strictEqual(plan.settings.prowlarr_url, 'http://prowl');
        assert.strictEqual(plan.settings.prowlarr_key, 'abc');
    });

    // ----------------------------------------------------------- запись и откат
    await test('запись: настройки меняются, прежние сохраняются, откат возвращает всё', () => {
        const env = makeEnv({ jackett_url: 'http://old', jackett_key: 'oldkey', parser_torrent_type: 'prowlarr', parser_use_link: 'two', parser_use: true });
        const { P, data } = env;
        const plan = P.choose([fake('jackett', 'jac.red', 95, 900, MANY.slice(0, 5)), fake('jackett', 'b', 70, 1500, MANY.slice(3, 8))], P.readCurrent());

        assert.ok(!P.hasBackup());

        const changes = P.apply(plan);

        assert.ok(changes.length >= 4);
        assert.strictEqual(data.jackett_url, 'http://jac.red');
        assert.strictEqual(data.parser_torrent_type, 'jackett');
        assert.strictEqual(data.parser_use_link, 'both');
        assert.ok(P.hasBackup());
        assert.strictEqual(P.loadBackup().values.jackett_url, 'http://old');

        assert.ok(P.rollback());
        assert.strictEqual(data.jackett_url, 'http://old');
        assert.strictEqual(data.jackett_key, 'oldkey');
        assert.strictEqual(data.parser_torrent_type, 'prowlarr');
        assert.strictEqual(data.parser_use_link, 'two');
        assert.ok(!P.hasBackup());
        assert.strictEqual(P.rollback(), false);
    });

    await test('запись: если менять нечего, копия отката не затирается', () => {
        const env = makeEnv({ parser_torrent_type: 'jackett', parser_use: true, jackett_url: 'http://a', parser_use_link: 'one' });
        const { P } = env;
        const first = P.choose([fake('jackett', 'b', 95, 900, MANY)], P.readCurrent());

        P.apply(first);

        const backupBefore = JSON.stringify(P.loadBackup());
        const again = P.choose([fake('jackett', 'b', 95, 900, MANY)], P.readCurrent());

        assert.ok(!again.changed);
        assert.deepStrictEqual(plain(P.apply(again)), []);
        assert.strictEqual(JSON.stringify(P.loadBackup()), backupBefore);
    });

    await test('текущая настройка: подпись для строки в настройках', () => {
        assert.strictEqual(makeEnv({ parser_torrent_type: 'jackett', jackett_url: 'https://jac.red/' }).P.currentLabel(), 'Jackett: jac.red');
        assert.strictEqual(makeEnv({ parser_torrent_type: 'jackett', parser_use_link: 'both', jackett_url: 'http://a:1', jackett_url_two: 'http://b' }).P.currentLabel(), 'Jackett: a:1 + b');
        assert.strictEqual(makeEnv({ parser_torrent_type: 'prowlarr' }).P.currentLabel(), 'Prowlarr: не задан');
        assert.strictEqual(makeEnv({ parser_torrent_type: 'torrserver' }).P.currentLabel(), 'Поиск TorrServer');
    });

    // ----------------------------------------------------------- список из сети
    await test('публичные парсеры: список с сайта плагина читается, кешируется и дополняет встроенный', async () => {
        const env = makeEnv();
        const { P } = env;

        env.routes = [{ match: 'https://snowymay111.github.io/lampa-plugins/parsers.json', json: { parsers: [{ url: 'https://jacred.pro', name: 'jacred.pro' }, { url: 'ftp://bad' }, { type: 'prowlarr', url: 'http://p' }] } }];

        const first = await new Promise((ok) => P.loadSeeds(ok));

        assert.deepStrictEqual(plain(first.map((s) => s.url)), ['https://jacred.pro', 'http://p', 'https://jac.red', 'https://jr.maxvol.pro']);

        const before = env.calls.length;
        const second = await new Promise((ok) => P.loadSeeds(ok));

        assert.strictEqual(env.calls.length, before, 'свежий кеш: в сеть не ходим');
        assert.strictEqual(second.length, 4);
    });

    await test('публичные парсеры: сайт недоступен, берётся встроенный список', async () => {
        const env = makeEnv();

        env.routes = [{ match: 'https://snowymay111.github.io', fail: true }];

        const seeds = await new Promise((ok) => env.P.loadSeeds(ok));

        assert.deepStrictEqual(plain(seeds.map((s) => s.url)), ['https://jac.red', 'https://jr.maxvol.pro']);
    });

    await test('целиком: ваш Jackett мёртв, публичный и TorrServer живы, итог записывается', async () => {
        const env = makeEnv({ parser_torrent_type: 'jackett', jackett_url: 'http://mine:9117', parser_use_link: 'one', torrserver_url: 'http://ts:8090' });
        const { P, data } = env;
        const seen = [];

        env.routes = [
            { match: 'https://snowymay111.github.io', fail: true },
            { match: 'http://mine:9117', fail: true },
            { match: 'https://jac.red', json: jackett(MANY, 60), delay: 20 },
            { match: 'https://jr.maxvol.pro', json: jackett(MANY.slice(2), 50), delay: 40 },
            { match: 'http://ts:8090/search/', json: [{ Title: 'Fight Club 1999', Tracker: 'rutor', Seed: 5 }], delay: 10 },
            { match: 'http://ts:8090/torznab/search/', fail: true }
        ];

        const out = await new Promise((ok) => P.run({ onResult: (r) => seen.push(r.cand.name) }, ok));

        assert.strictEqual(out.total, 5);
        assert.strictEqual(seen.length, 5);
        assert.strictEqual(out.plan.primary.cand.name, 'jac.red');
        assert.ok(out.plan.settings.jackett_url === 'https://jac.red');

        P.apply(out.plan);

        assert.strictEqual(data.jackett_url, 'https://jac.red');
        assert.strictEqual(data.parser_use, 'true');
        assert.ok(P.rollback());
        assert.strictEqual(data.jackett_url, 'http://mine:9117');
    });

    results.forEach(([ok, name]) => console.log((ok ? 'PASS  ' : 'FAIL  ') + name));
    const failed = results.filter((r) => !r[0]).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
