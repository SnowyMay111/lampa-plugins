// Проверка автонастройки TorrServer на макете сервера. Запуск: node test/tune.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const plain = (x) => JSON.parse(JSON.stringify(x));
const MB = 1048576;

// Настройки реального TorrServer MatriX.145.1, снятые с компьютера пользователя (без личных данных)
const REAL = {
    CacheSize: 6442450944, ReaderReadAHead: 95, PreloadCache: 20, UseDisk: false, TorrentsSavePath: '', RemoveCacheOnDrop: false, ForceEncrypt: false,
    RetrackersMode: 2, TrackersListURL: '', DefaultTrackers: 'udp://tracker.opentrackr.org:1337/announce', TorrentDisconnectTimeout: 30, EnableDebug: false,
    EnableDLNA: false, EnableBonjour: true, FriendlyName: '', EnableRutorSearch: false, EnableTorznabSearch: false, TorznabUrls: null,
    TMDBSettings: { APIKey: '', APIURL: 'https://api.themoviedb.org', ImageURL: 'https://image.tmdb.org', ImageURLRu: 'https://imagetmdb.com' },
    EnableIPv6: true, DisableTCP: false, DisableUTP: false, DisableUPNP: false, DisableDHT: false, DisablePEX: false, DisableUpload: false,
    DownloadRateLimit: 0, UploadRateLimit: 0, ConnectionsLimit: 150, PeersListenPort: 51413, EnableLPD: true, LPDIPv6: false, SslPort: 0, SslCert: '', SslKey: '',
    ResponsiveMode: true, ShowFSActiveTorr: true, StoreSettingsInJson: true, StoreViewedInJson: false, TrackTimecode: false, MergeAllM3U: false
};

// Макет Лампы и сервера: как настоящий TorrServer, при записи заменяет настройки целиком
function makeEnv(server, opts) {
    opts = opts || {};

    const data = Object.assign({ torrserver_url: 'http://ts:8090' }, opts.store);
    const env = { server: plain(server), data, requests: [] };

    const Storage = {
        get(k, def) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : def; },
        set(k, v) { data[k] = v; }
    };

    function Reguest() {
        let dead = false;

        this.timeout = () => {};
        this.clear = () => { dead = true; };
        this.silent = (url, ok, fail, body, params) => {
            const req = body ? JSON.parse(body) : {};

            env.requests.push({ url, req, params });

            if (opts.hang) return;
            if (opts.down) return setTimeout(() => { if (!dead) fail(); }, 2);

            setTimeout(() => {
                if (dead) return;

                if (req.action === 'get') return ok(opts.notTorr ? { hello: 1 } : plain(env.server));

                if (req.action === 'set') {
                    Object.keys(req.sets).forEach((k) => { if (!(opts.ignore || []).includes(k)) env.server[k] = req.sets[k]; });

                    // у настоящего сервера пустой ответ; при dataType json это была бы ошибка разбора
                    return params && params.dataType === 'text' ? ok('') : fail();
                }

                fail();
            }, 2);
        };
    }

    const window = { Lampa: { Storage, Reguest, Torserver: { url: () => data.torrserver_url } }, lampa_watch_config: { verifyDelay: 5, tuneMs: 150 } };
    const ctx = vm.createContext({ LW: {}, window, console, setTimeout, clearTimeout, Date, Math, JSON, parseInt, parseFloat, isNaN, RegExp, Object });

    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'tune.js'), 'utf8'), ctx, { filename: 'tune.js' });

    env.T = ctx.LW.tune;

    return env;
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name + '\n      ' + e.message]); }
}

const keysOf = (p) => plain(p.changes.map((c) => c.key));
const call = (fn, ...args) => new Promise((ok) => fn(...args, (err, data) => ok({ err, data })));

(async () => {
    await test('план для настоящего сервера: поиск, трекеры и предзагрузка; кеш, лимиты и соединения не трогаем', () => {
        const { T } = makeEnv(REAL);
        const p = T.plan(plain(REAL), { line: 0 });

        assert.deepStrictEqual(keysOf(p), ['EnableRutorSearch', 'RetrackersMode', 'TrackersListURL', 'PreloadCache']);
        assert.strictEqual(p.next.EnableRutorSearch, true);
        assert.strictEqual(p.next.RetrackersMode, 1);
        assert.ok(/trackers_best\.txt$/.test(p.next.TrackersListURL));
        assert.strictEqual(p.next.CacheSize, REAL.CacheSize);
        assert.strictEqual(p.next.ConnectionsLimit, 150);
        assert.strictEqual(p.next.PreloadCache, 1);

        const pre = p.changes.filter((c) => c.key === 'PreloadCache')[0];

        assert.ok(pre.fromText.indexOf('20% кеша') === 0 && /1,?\d* ГБ|1\.2 ГБ/.test(pre.fromText), pre.fromText);
        assert.ok(pre.toText.indexOf('1% кеша ≈ 61 МБ') === 0, pre.toText);
        assert.ok(p.notes.some((n) => n.indexOf('6 ГБ') >= 0), 'предупреждение про 6 ГБ памяти');
        assert.ok(p.changes.every((c) => c.label && c.why && c.fromText && c.toText));
    });

    await test('предзагрузка зависит от скорости сети: быстрая сеть получает больше, но не больше 192 МБ', () => {
        const { T } = makeEnv(REAL);

        assert.strictEqual(T.plan(plain(REAL), { line: 400 }).next.PreloadCache, 3);  // 192 МБ из 6 ГБ
        assert.strictEqual(T.plan(plain(REAL), { line: 8 }).next.PreloadCache, 1);    // не меньше 32 МБ, при 1% и так 61 МБ
        const mid = plain(REAL);

        mid.CacheSize = 512 * MB;
        mid.PreloadCache = 50; // 256 МБ перед стартом

        const p = T.plan(mid, { line: 80 }); // 10 МБ/с * 8 с = 80 МБ

        assert.strictEqual(p.next.PreloadCache, 16);
    });

    await test('слишком маленькая предзагрузка поднимается до 32 МБ', () => {
        const { T } = makeEnv(REAL);
        const s = plain(REAL);

        s.CacheSize = 256 * MB;
        s.PreloadCache = 5; // 12,8 МБ

        const p = T.plan(s, { line: 40 });

        assert.strictEqual(p.next.PreloadCache, 13);
        assert.ok(/слишком мала/.test(p.changes.filter((c) => c.key === 'PreloadCache')[0].why));
    });

    await test('слабый сервер: всё лучшее включается, лимиты снимаются, кеш растёт', () => {
        const { T } = makeEnv(REAL);
        const s = plain(REAL);

        Object.assign(s, { CacheSize: 64 * MB, ReaderReadAHead: 30, ConnectionsLimit: 20, DownloadRateLimit: 2000, DisableDHT: true, DisablePEX: true, DisableTCP: true, DisableUTP: true, RetrackersMode: 0, PreloadCache: 50 });

        const p = T.plan(s, { line: 40 });

        assert.ok(['CacheSize', 'ReaderReadAHead', 'ConnectionsLimit', 'DownloadRateLimit', 'DisableDHT', 'DisablePEX', 'DisableTCP', 'DisableUTP', 'RetrackersMode'].every((k) => keysOf(p).indexOf(k) >= 0), keysOf(p).join());
        assert.strictEqual(p.next.CacheSize, 256 * MB);
        assert.strictEqual(p.next.ReaderReadAHead, 95);
        assert.strictEqual(p.next.ConnectionsLimit, 80);
        assert.strictEqual(p.next.DownloadRateLimit, 0);
        assert.strictEqual(p.next.DisableDHT, false);
        assert.strictEqual(p.next.RetrackersMode, 1);
    });

    await test('уже настроенный сервер: изменений нет, повторный план после применения пуст', () => {
        const { T } = makeEnv(REAL);
        const first = T.plan(plain(REAL), { line: 0 });
        const again = T.plan(first.next, { line: 0 });

        assert.strictEqual(again.changes.length, 0);
        assert.ok(first.changes.length > 0);
    });

    await test('поля, которых сервер не показал (другая версия), не добавляются', () => {
        const { T } = makeEnv(REAL);
        const old = { CacheSize: 64 * MB, ReaderReadAHead: 95, PreloadCache: 50 };
        const p = T.plan(old, { line: 40 });

        assert.ok(!('EnableRutorSearch' in p.next) && !('RetrackersMode' in p.next) && !('TrackersListURL' in p.next));
        assert.deepStrictEqual(keysOf(p).sort(), ['CacheSize', 'PreloadCache']);
    });

    await test('чтение: адрес берётся из Лампы, ошибки объясняются', async () => {
        const ok = makeEnv(REAL);
        const r = await call(ok.T.load);

        assert.ok(!r.err && r.data.CacheSize === REAL.CacheSize);
        assert.strictEqual(ok.requests[0].url, 'http://ts:8090/settings');
        assert.deepStrictEqual(plain(ok.requests[0].req), { action: 'get' });

        assert.ok(/не ответил/.test((await call(makeEnv(REAL, { down: true }).T.load)).err));
        assert.ok(/не ответил/.test((await call(makeEnv(REAL, { hang: true }).T.load)).err));
        assert.ok(/MatriX/.test((await call(makeEnv(REAL, { notTorr: true }).T.load)).err));
        assert.ok(/Адрес TorrServer не задан/.test((await call(makeEnv(REAL, { store: { torrserver_url: '' } }).T.load)).err));
    });

    await test('применение: настройки уходят целиком, копия сохраняется, сервер принимает, откат возвращает всё', async () => {
        const env = makeEnv(REAL);
        const { T } = env;
        const cur = (await call(T.load)).data;
        const p = T.plan(cur, { line: 0 });

        assert.ok(!T.hasBackup());

        const done = await call(T.apply, p, cur);

        assert.strictEqual(done.err, null);
        assert.strictEqual(env.server.EnableRutorSearch, true);
        assert.strictEqual(env.server.RetrackersMode, 1);
        assert.strictEqual(env.server.PreloadCache, 1);

        const sent = env.requests.filter((r) => r.req.action === 'set')[0];

        assert.strictEqual(Object.keys(sent.req.sets).length, Object.keys(REAL).length, 'отправлены все поля, а не только изменённые');
        assert.deepStrictEqual(plain(sent.req.sets.TMDBSettings), REAL.TMDBSettings);
        assert.strictEqual(sent.params.dataType, 'text', 'ответ пустой: разбирать как JSON нельзя');
        assert.ok(T.hasBackup());
        assert.strictEqual(T.loadBackup().settings.RetrackersMode, 2);

        const back = await call(T.rollback);

        assert.strictEqual(back.err, null);
        assert.deepStrictEqual(env.server, plain(REAL));
        assert.ok(!T.hasBackup());
        assert.strictEqual((await call(T.rollback)).err, 'Копии нет');
    });

    await test('применение: если сервер не принял поле, об этом сообщается', async () => {
        const env = makeEnv(REAL, { ignore: ['RetrackersMode'] });
        const cur = (await call(env.T.load)).data;
        const r = await call(env.T.apply, env.T.plan(cur, { line: 0 }), cur);

        assert.ok(/Сервер не принял: RetrackersMode/.test(r.err), r.err);
    });

    await test('применение: сервер упал во время записи, понятная ошибка и копия остаётся для отката', async () => {
        const env = makeEnv(REAL);
        const cur = (await call(env.T.load)).data;
        const p = env.T.plan(cur, { line: 0 });

        // сервер «падает» после чтения: запись не проходит
        const down = makeEnv(REAL, { down: true });
        const r = await call(down.T.apply, p, cur);

        assert.ok(/не ответил/.test(r.err));
        assert.ok(down.T.hasBackup(), 'копия сделана до записи');
    });

    await test('скорость сети берётся из замеров плагина', () => {
        assert.strictEqual(makeEnv(REAL, { store: { lw_line_peak: 92.5 } }).T.lineMbps(), 92.5);
        assert.strictEqual(makeEnv(REAL).T.lineMbps(), 0);
    });

    results.forEach(([ok, name]) => console.log((ok ? 'PASS  ' : 'FAIL  ') + name));
    const failed = results.filter((r) => !r[0]).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
