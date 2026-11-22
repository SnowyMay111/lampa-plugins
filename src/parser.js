/*
 * Автоподбор парсера. Проверяет на самом устройстве, какие парсеры отвечают (ваш Jackett или Prowlarr,
 * поиск, встроенный в TorrServer, публичные Jackett-совместимые), оценивает их по тестовому запросу
 * и записывает лучшие в настройки Лампы. Перед записью делает копию, чтобы всё можно было откатить.
 *
 * Здесь только логика и запросы. Окна и пункты настроек: setup.js.
 */
LW.parser = (function () {
    var PARSERS_URL = 'https://snowymay111.github.io/lampa-plugins/parsers.json';
    var PROBE_QUERY = 'Fight Club';
    var PROBE_MATCH = /fight[ ._\-]?club|бойцовск/i;
    var CFG = window.lampa_watch_config || {}; // для тестов: сокращает ожидание
    var PROBE_MS = CFG.probeMs || 10000;   // сколько ждём один парсер
    var POOL = 6;           // сколько парсеров проверяем одновременно
    var USEFUL = 15;        // ниже этой оценки парсер считаем бесполезным
    var KEEP_RATIO = 0.8;   // если ваш текущий парсер не хуже 80% от лучшего, оставляем его

    var STORE_BACKUP = 'lw_parser_backup';
    var STORE_REMOTE = 'lw_parser_remote';
    var REMOTE_TTL = 6 * 3600 * 1000;

    // Настройки Лампы, которые мы читаем и можем менять. Только они попадают в копию для отката.
    var KEYS = [
        'parser_torrent_type', 'parser_use', 'parser_use_link',
        'jackett_url', 'jackett_key', 'jackett_url_two', 'jackett_key_two',
        'prowlarr_url', 'prowlarr_key', 'prowlarr_url_two', 'prowlarr_key_two',
        'torrserver_search_type'
    ];

    // Публичные парсеры, проверенные вручную. Остальные подтягиваются из parsers.json на сайте плагина.
    var BUILTIN = [
        { type: 'jackett', url: 'https://jac.red', name: 'jac.red', key: '' },
        { type: 'jackett', url: 'https://jr.maxvol.pro', name: 'jr.maxvol.pro', key: '' }
    ];

    var TYPE_NAME = { jackett: 'Jackett', prowlarr: 'Prowlarr', torrserver: 'Поиск TorrServer' };
    var TYPE_ORDER = { jackett: 0, prowlarr: 1, torrserver: 2 };

    var active = 0; // номер текущей проверки: отменённая молча затихает
    var nets = [];  // запросы текущей проверки: их можно оборвать

    // ---------------------------------------------------------------- мелочи

    function L() {
        return window.Lampa;
    }

    function trim(s) {
        return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
    }

    // Приводит ссылку к виду, с которым работает парсер Лампы: схема есть, косой черты в конце нет
    function cleanUrl(u) {
        u = trim(u);

        if (!u) return '';

        u = u.replace(/jacred\.xyz/i, 'jac.red'); // Лампа делает то же самое

        if (!/^https?:\/\//i.test(u)) u = 'http://' + u;

        return u.replace(/\/+$/, '');
    }

    function hostOf(u) {
        return String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/[\/?#].*$/, '');
    }

    function splitTrackers(s) {
        return String(s || '').toLowerCase().split(/[,;|]/).map(trim).filter(function (t) { return !!t; });
    }

    function num(v) {
        var n = parseInt(v, 10);

        return isNaN(n) ? 0 : n;
    }

    function store() {
        return L().Storage;
    }

    function getSetting(key) {
        try {
            var v = store().get(key, '');

            return v === undefined || v === null ? '' : v;
        } catch (e) {
            return '';
        }
    }

    function sameValue(a, b) {
        return trim(a) === trim(b);
    }

    // ---------------------------------------------------------------- кандидаты

    function makeCand(type, url, key, extra) {
        var c = { type: type, url: cleanUrl(url), key: trim(key), path: '', name: '', origin: 'seed', current: false, slot: 0 };
        var k;

        for (k in extra) c[k] = extra[k];

        if (!c.name) c.name = hostOf(c.url);
        c.id = type + '|' + c.url + c.path;

        return c;
    }

    // Что сейчас стоит в Лампе и какие ссылки реально используются
    function readCurrent() {
        var type = trim(getSetting('parser_torrent_type')) || 'jackett';
        var use = trim(getSetting('parser_use_link')) || 'one';
        var out = {
            type: type, use: use, search: trim(getSetting('torrserver_search_type')) || 'both',
            parser_use: getSetting('parser_use'),
            jackett: [{ url: cleanUrl(getSetting('jackett_url')), key: trim(getSetting('jackett_key')) }, { url: cleanUrl(getSetting('jackett_url_two')), key: trim(getSetting('jackett_key_two')) }],
            prowlarr: [{ url: cleanUrl(getSetting('prowlarr_url')), key: trim(getSetting('prowlarr_key')) }, { url: cleanUrl(getSetting('prowlarr_url_two')), key: trim(getSetting('prowlarr_key_two')) }]
        };

        // какие из двух ссылок включены, как в parser.js Лампы
        out.used = use === 'two' ? [1] : use === 'both' ? [0, 1] : [0];

        return out;
    }

    // Список для проверки: ваши ссылки, встроенный поиск TorrServer, публичные из seeds.
    // torrUrl: адрес TorrServer (может быть пустым), seeds: [{type,url,key,name}].
    function candidates(cur, torrUrl, seeds) {
        var out = [];
        var seen = {};

        function add(c) {
            if (!c.url || seen[c.id]) return;

            seen[c.id] = true;
            out.push(c);
        }

        ['jackett', 'prowlarr'].forEach(function (type) {
            cur[type].forEach(function (link, i) {
                if (!link.url) return;

                add(makeCand(type, link.url, link.key, {
                    origin: 'current', slot: i + 1,
                    current: cur.type === type && cur.used.indexOf(i) >= 0
                }));
            });
        });

        torrUrl = cleanUrl(torrUrl);

        if (torrUrl) {
            add(makeCand('torrserver', torrUrl, '', { path: '/search/', origin: 'torrserver', name: 'Rutor в TorrServer', current: cur.type === 'torrserver' && cur.search !== 'torznab' }));
            add(makeCand('torrserver', torrUrl, '', { path: '/torznab/search/', origin: 'torrserver', name: 'Torznab в TorrServer', current: cur.type === 'torrserver' && cur.search !== 'rutor' }));
        }

        (seeds || []).forEach(function (s) {
            if (s && s.url) add(makeCand(s.type === 'prowlarr' ? 'prowlarr' : 'jackett', s.url, s.key, { name: s.name || '' }));
        });

        return out;
    }

    // ---------------------------------------------------------------- запрос и разбор ответа

    function probeUrl(c, query) {
        var q = encodeURIComponent(query || PROBE_QUERY);

        if (c.type === 'jackett') return c.url + '/api/v2.0/indexers/all/results?apikey=' + encodeURIComponent(c.key) + '&Query=' + q;
        if (c.type === 'prowlarr') return c.url + '/api/v1/search?apikey=' + encodeURIComponent(c.key) + '&query=' + q;

        return c.url + c.path + '?query=' + q;
    }

    // Приводит ответ любого парсера к одному виду. null значит «это не ответ парсера».
    function normalize(c, json) {
        var rows;

        if (c.type === 'jackett') {
            if (!json || !Array.isArray(json.Results)) return null;

            return json.Results.map(function (r) {
                return { title: String(r.Title || ''), tracker: r.Tracker, seeders: num(r.Seeders) };
            });
        }

        if (!Array.isArray(json)) return null;

        rows = json;

        if (c.type === 'prowlarr') {
            return rows.filter(function (r) { return !r.protocol || r.protocol === 'torrent'; }).map(function (r) {
                return { title: String(r.title || ''), tracker: r.indexer, seeders: num(r.seeders) };
            });
        }

        return rows.map(function (r) {
            return { title: String(r.Title || ''), tracker: r.Tracker, seeders: num(r.Seed) };
        });
    }

    function evaluate(items, ms) {
        var ev = { count: items.length, relevant: 0, trackers: [], seeded: 0, ms: ms };
        var seen = {};

        items.forEach(function (it) {
            if (it.seeders > 0) ev.seeded++;

            if (!PROBE_MATCH.test(it.title)) return;

            ev.relevant++;

            splitTrackers(it.tracker).forEach(function (t) {
                if (seen[t]) return;

                seen[t] = true;
                ev.trackers.push(t);
            });
        });

        return ev;
    }

    // Оценка 0..100: сколько нашлось (до 30), сколько разных трекеров (до 40), живые ли раздачи (до 10), как быстро (до 20)
    function rate(ev) {
        var s;

        if (!ev || !ev.count) return 0;
        if (!ev.relevant) return 3; // отвечает, но по тестовому запросу пусто

        s = Math.min(ev.relevant, 60) / 2;
        s += Math.min(ev.trackers.length, 10) * 4;
        s += 10 * ev.seeded / ev.count;
        s += ev.ms < 2000 ? 20 : ev.ms < 4000 ? 14 : ev.ms < 8000 ? 6 : 0;

        return Math.round(s);
    }

    function now() {
        return new Date().getTime();
    }

    // Проверяет один парсер. Всегда вызывает done(result) ровно один раз.
    function probe(c, query, done) {
        var started = now();
        var finished = false;
        var net = null;
        var timer = null;

        function finish(res) {
            if (finished) return;

            finished = true;

            if (timer) clearTimeout(timer);

            res.cand = c;
            res.ms = now() - started;
            done(res);
        }

        function fail(text) {
            finish({ ok: false, error: text, ev: null, rating: 0 });
        }

        try {
            net = new (L().Reguest)();
            net.timeout(PROBE_MS);
            nets.push(net);
        } catch (e) {
            return fail('нет сетевого модуля');
        }

        // свой таймер: на старых ТВ запрос иногда зависает дольше заявленного таймаута
        timer = setTimeout(function () {
            try { net.clear(); } catch (e) {}
            fail('не ответил за ' + Math.round(PROBE_MS / 1000) + ' с');
        }, PROBE_MS + 1500);

        try {
            net.native(probeUrl(c, query), function (json) {
                var items = normalize(c, json);
                var ms = now() - started;
                var ev;

                if (!items) return fail('ответ не похож на парсер');

                ev = evaluate(items, ms);

                finish({ ok: true, ev: ev, rating: rate(ev), error: '' });
            }, function () {
                fail('нет ответа');
            });
        } catch (e) {
            fail('' + e);
        }
    }

    // Проверяет всех с ограничением по числу одновременных запросов.
    // opts.onResult(res) вызывается по мере готовности, done(results) в конце.
    function probeAll(list, opts, done) {
        var mine = ++active;
        var results = [];
        var next = 0;
        var running = 0;
        var left = list.length;

        nets = [];

        function finishAll() {
            if (mine !== active) return;

            results.sort(function (a, b) { return b.rating - a.rating; });
            done(results);
        }

        function pump() {
            while (running < POOL && next < list.length) {
                (function (c) {
                    running++;

                    if (opts.onStart) opts.onStart(c);

                    probe(c, opts.query, function (res) {
                        running--;
                        left--;

                        if (mine !== active) return;

                        results.push(res);

                        if (opts.onResult) opts.onResult(res, list.length - left, list.length);

                        if (!left) finishAll();
                        else pump();
                    });
                })(list[next++]);
            }
        }

        if (!list.length) return finishAll();

        pump();
    }

    function cancel() {
        active++;

        nets.forEach(function (n) { try { n.clear(); } catch (e) {} });
        nets = [];
    }

    // ---------------------------------------------------------------- выбор лучших

    function newTrackers(a, b) {
        var have = {};
        var n = 0;

        a.ev.trackers.forEach(function (t) { have[t] = true; });
        b.ev.trackers.forEach(function (t) { if (!have[t]) n++; });

        return n;
    }

    // Оценка с поправкой: то, что у вас уже включено, получает бонус, чтобы без причины не менять настройки
    function adjusted(r) {
        return r.rating + (r.cand.current ? 8 : 0);
    }

    function pickSecond(group, primary) {
        var i;
        var r;

        for (i = 0; i < group.length; i++) {
            r = group[i];

            if (r === primary || r.rating < 35) continue;
            if (newTrackers(primary, r) < 3) continue;
            if (r.ms > Math.max(6000, primary.ms * 2.5)) continue; // медленный второй тормозил бы каждый поиск

            return r;
        }

        return null;
    }

    function setting(plan, key, value) {
        plan.settings[key] = value;
    }

    // Из результатов проверки собирает план: что записать в настройки. null, если рабочего парсера нет.
    function choose(results, cur) {
        var alive = results.filter(function (r) { return r.ok && r.rating >= USEFUL; });
        var plan;
        var top;
        var group;
        var primary;
        var second;
        var searchModes;
        var keep;

        if (!alive.length) return null;

        alive.sort(function (a, b) {
            return adjusted(b) - adjusted(a) || TYPE_ORDER[a.cand.type] - TYPE_ORDER[b.cand.type] || a.ms - b.ms;
        });

        top = alive[0];

        // свой парсер того же типа, который и так хорошо работает, не трогаем
        keep = null;

        alive.forEach(function (r) {
            if (r.cand.current && r.cand.type === top.cand.type && r.rating >= KEEP_RATIO * top.rating && (!keep || adjusted(r) > adjusted(keep))) keep = r;
        });

        if (keep) top = keep;

        plan = { type: top.cand.type, settings: {}, primary: top, secondary: null, mode: 'one', results: results, changes: [] };

        if (plan.type === 'torrserver') {
            group = alive.filter(function (r) { return r.cand.type === 'torrserver'; });
            searchModes = { rutor: false, torznab: false };

            group.forEach(function (r) { searchModes[r.cand.path === '/search/' ? 'rutor' : 'torznab'] = true; });

            plan.mode = searchModes.rutor && searchModes.torznab ? 'both' : searchModes.torznab ? 'torznab' : 'rutor';
            plan.group = group;

            setting(plan, 'parser_torrent_type', 'torrserver');
            setting(plan, 'torrserver_search_type', plan.mode);
        } else {
            group = alive.filter(function (r) { return r.cand.type === plan.type; });
            primary = top;
            second = pickSecond(group, primary);

            plan.group = group;
            plan.secondary = second;
            plan.mode = second ? 'both' : 'one';

            setting(plan, 'parser_torrent_type', plan.type);
            setting(plan, plan.type + '_url', primary.cand.url);
            setting(plan, plan.type + '_key', primary.cand.key);
            setting(plan, 'parser_use_link', second ? 'both' : 'one');

            if (second) {
                setting(plan, plan.type + '_url_two', second.cand.url);
                setting(plan, plan.type + '_key_two', second.cand.key);
            }
        }

        if (!cur.parser_use || String(cur.parser_use) === 'false') setting(plan, 'parser_use', 'true');

        plan.changes = diff(plan.settings);
        plan.changed = plan.changes.length > 0;

        return plan;
    }

    // Что изменится в настройках: [{key, from, to}]
    function diff(settings) {
        var out = [];

        Object.keys(settings).forEach(function (k) {
            var from = getSetting(k);

            if (!sameValue(from, settings[k])) out.push({ key: k, from: from, to: settings[k] });
        });

        return out;
    }

    // ---------------------------------------------------------------- запись и откат

    function readAll() {
        var out = {};

        KEYS.forEach(function (k) { out[k] = getSetting(k); });

        return out;
    }

    function loadBackup() {
        try {
            var b = store().get(STORE_BACKUP, '');

            return b && typeof b === 'object' && b.values ? b : null;
        } catch (e) {
            return null;
        }
    }

    function hasBackup() {
        return !!loadBackup();
    }

    // Записывает план в настройки Лампы. Прежние значения сохраняются для отката.
    function apply(plan) {
        var changes = diff(plan.settings);
        var before;

        if (!changes.length) return changes;

        before = readAll();

        store().set(STORE_BACKUP, { at: now(), values: before, summary: describe(plan) });

        changes.forEach(function (c) { store().set(c.key, c.to); });

        return changes;
    }

    // Возвращает настройки, какими они были до последнего подбора. true, если откатили.
    function rollback() {
        var b = loadBackup();

        if (!b) return false;

        KEYS.forEach(function (k) {
            if (b.values.hasOwnProperty(k)) store().set(k, b.values[k]);
        });

        store().set(STORE_BACKUP, { at: 0, values: null });

        return true;
    }

    // ---------------------------------------------------------------- текст

    function labelOf(c) {
        if (c.type === 'torrserver') return c.name;

        return c.name || hostOf(c.url);
    }

    function describe(plan) {
        if (!plan) return '';

        if (plan.type === 'torrserver') return TYPE_NAME.torrserver + ' (' + plan.mode + ')';

        return TYPE_NAME[plan.type] + ': ' + labelOf(plan.primary.cand) + (plan.secondary ? ' + ' + labelOf(plan.secondary.cand) : '');
    }

    // Что сейчас стоит: для строки в настройках
    function currentLabel() {
        var cur = readCurrent();
        var urls;

        if (cur.type === 'torrserver') return TYPE_NAME.torrserver;

        urls = cur.used.map(function (i) { return cur[cur.type][i].url; }).filter(function (u) { return !!u; }).map(hostOf);

        return TYPE_NAME[cur.type] + (urls.length ? ': ' + urls.join(' + ') : ': не задан');
    }

    // ---------------------------------------------------------------- список публичных парсеров

    function validSeeds(list) {
        return (list || []).filter(function (s) { return s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url); }).map(function (s) {
            return { type: s.type === 'prowlarr' ? 'prowlarr' : 'jackett', url: s.url, key: s.key || '', name: s.name || '' };
        });
    }

    // Свежий список с сайта плагина, при неудаче последний сохранённый, иначе встроенный
    function loadSeeds(done) {
        var cached = null;
        var net;
        var called = false;

        function finish(list) {
            if (called) return;

            called = true;
            done(list);
        }

        try {
            cached = store().get(STORE_REMOTE, '');
        } catch (e) {}

        if (cached && cached.list && cached.at && now() - cached.at < REMOTE_TTL) return finish(validSeeds(cached.list).concat(BUILTIN));

        try {
            net = new (L().Reguest)();
            net.timeout(4000);

            net.silent(PARSERS_URL + '?t=' + Math.floor(now() / 60000), function (json) {
                var list = validSeeds(json && json.parsers);

                if (list.length) {
                    try { store().set(STORE_REMOTE, { at: now(), list: list }); } catch (e) {}
                }

                finish(list.concat(BUILTIN));
            }, function () {
                finish(validSeeds(cached && cached.list).concat(BUILTIN));
            });
        } catch (e) {
            finish(BUILTIN.slice());
        }
    }

    // Адрес TorrServer, который сейчас используется (с учётом выбранной в Лампе основной или дополнительной ссылки)
    function torrUrl() {
        var two = trim(getSetting('torrserver_use_link')) === 'two';

        return cleanUrl(getSetting(two ? 'torrserver_url_two' : 'torrserver_url'));
    }

    // ---------------------------------------------------------------- всё вместе

    // opts: { torrUrl, query, onList(list), onStart(c), onResult(res, n, total) }. done({ results, plan, cur, total }).
    function run(opts, done) {
        loadSeeds(function (seeds) {
            var cur = readCurrent();
            var list = candidates(cur, opts.torrUrl === undefined ? torrUrl() : opts.torrUrl, seeds);

            if (opts.onList) opts.onList(list);

            probeAll(list, opts, function (results) {
                done({ results: results, plan: choose(results, cur), cur: cur, total: list.length });
            });
        });
    }

    return {
        KEYS: KEYS,
        TYPE_NAME: TYPE_NAME,
        PROBE_QUERY: PROBE_QUERY,
        cleanUrl: cleanUrl,
        hostOf: hostOf,
        readCurrent: readCurrent,
        torrUrl: torrUrl,
        candidates: candidates,
        probeUrl: probeUrl,
        normalize: normalize,
        evaluate: evaluate,
        rate: rate,
        probe: probe,
        probeAll: probeAll,
        cancel: cancel,
        choose: choose,
        diff: diff,
        apply: apply,
        rollback: rollback,
        hasBackup: hasBackup,
        loadBackup: loadBackup,
        describe: describe,
        labelOf: labelOf,
        currentLabel: currentLabel,
        loadSeeds: loadSeeds,
        run: run
    };
})();
