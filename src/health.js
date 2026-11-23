/*
 * Диагностика и обновление.
 *
 * Окно в Настройки → Lampa Watch → «Диагностика и обновление»: версия плагина и есть ли новее,
 * откуда он загружен, отвечает ли парсер, жив ли TorrServer, последние ошибки и плавность интерфейса.
 * Каждый пункт показан значком, словом и цветом: цвет один не должен быть единственным признаком.
 *
 * Журнал ошибок (note) живёт здесь же: остальные модули пишут в него одной строкой.
 * Окно собирается из LW.ui, которое появляется позже (watch.js), поэтому берём его в момент открытия.
 */
LW.health = (function () {
    var STORE_ERRORS = 'lw_diag_errors';
    var STORE_LAST = 'lw_diag_last';
    var MAX_ERRORS = 12;
    var DAY = 24 * 3600 * 1000;
    var MANIFEST_URL = 'https://snowymay111.github.io/lampa-plugins/manifest.json';
    var CFG = window.lampa_watch_config || {};
    var FPS_MS = CFG.fpsMs || 2000;
    var NET_MS = CFG.healthNetMs || 8000;

    var RANK = { ok: 0, warn: 1, bad: 2 };
    var MARK = { ok: '✓', warn: '!', bad: '✕', run: '…' };
    var WORD = { ok: 'Работает', warn: 'Внимание', bad: 'Проблема', run: 'Проверяю' };

    var TXT = {
        title: 'Диагностика',
        kicker: 'Настройки · Lampa Watch',
        recheck: 'Проверить заново',
        close: 'Закрыть',
        setting: 'Диагностика и обновление',
        settingHint: 'Версия плагина, парсер, TorrServer, последние ошибки и плавность интерфейса.',
        allGood: 'всё в порядке',
        someWarn: 'есть замечания',
        someBad: 'есть проблемы',
        notChecked: 'нажмите, чтобы проверить',
        version: 'Версия плагина',
        source: 'Откуда загружен',
        parser: 'Парсер',
        server: 'TorrServer',
        perf: 'Плавность интерфейса',
        errors: 'Последние ошибки',
        noErrors: 'Ошибок нет',
        noErrorsSub: 'Если что-то сломается, причина появится здесь, вместе с тем, что плагин сделал сам.'
    };

    // ---------------------------------------------------------------- вспомогательное

    function L() {
        return window.Lampa;
    }

    function now() {
        return new Date().getTime();
    }

    function store(key, value) {
        try { L().Storage.set(key, value); } catch (e) {}
    }

    function readStore(key, def) {
        try { return L().Storage.get(key, def); } catch (e) { return def; }
    }

    function plural(n, one, few, many) {
        var a = Math.abs(n) % 100;
        var b = a % 10;

        if (a > 10 && a < 20) return many;
        if (b > 1 && b < 5) return few;

        return b === 1 ? one : many;
    }

    function comma(x) {
        return String(x).replace('.', ',');
    }

    function p2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // «21:40», «вчера, 21:40», «12.11, 09:05»
    function whenText(ts, at) {
        var cur = at || now();
        var d = new Date(ts);
        var t = p2(d.getHours()) + ':' + p2(d.getMinutes());
        var a = new Date(cur);
        var today = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();

        if (ts >= today) return 'сегодня, ' + t;
        if (ts >= today - DAY) return 'вчера, ' + t;

        return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + ', ' + t;
    }

    // 1.3.10 новее, чем 1.3.9; нечисловые хвосты отбрасываем
    function cmpVer(a, b) {
        var x = String(a || '0').split('.');
        var y = String(b || '0').split('.');
        var n = Math.max(x.length, y.length);

        for (var i = 0; i < n; i++) {
            var p = parseInt(x[i], 10) || 0;
            var q = parseInt(y[i], 10) || 0;

            if (p !== q) return p > q ? 1 : -1;
        }

        return 0;
    }

    function worst(levels) {
        var out = 'ok';

        levels.forEach(function (l) {
            if (RANK[l] > RANK[out]) out = l;
        });

        return out;
    }

    // ---------------------------------------------------------------- журнал ошибок

    function errors() {
        var list = readStore(STORE_ERRORS, []);

        return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    }

    // kind: откуда (parser, speed, tune, module), text: что случилось, fix: что плагин сделал сам (необязательно)
    function note(kind, text, fix) {
        try {
            var list = errors();
            var last = list[0];
            var t = now();

            text = String(text || '').slice(0, 200);

            if (!text) return;

            if (last && last.kind === kind && last.text === text && t - last.at < 600000) {
                if (fix && !last.fix) last.fix = String(fix).slice(0, 200);
                else return;
            } else {
                list.unshift({ at: t, kind: kind, text: text, fix: fix ? String(fix).slice(0, 200) : '' });
            }

            store(STORE_ERRORS, list.slice(0, MAX_ERRORS));
        } catch (e) {}
    }

    function clearErrors() {
        store(STORE_ERRORS, []);
    }

    function errorsCard(at) {
        var list = errors();
        var t = at || now();

        if (!list.length) return { level: 'ok', value: TXT.noErrors, sub: TXT.noErrorsSub };

        var e = list[0];
        var recent = list.filter(function (x) { return t - x.at < DAY; }).length;

        return {
            level: t - e.at < DAY ? 'warn' : 'ok',
            value: e.text + ' (' + whenText(e.at, t) + ')',
            sub: (e.fix || 'Сделать ничего не нужно, если сейчас всё работает') + (recent > 1 ? '. За сутки таких записей: ' + recent : '')
        };
    }

    // ---------------------------------------------------------------- откуда загружен плагин

    var RE_SHORT = /snowymay111\.github\.io\/l\.js(?:[?#]|$)/i;
    var RE_FULL = /snowymay111\.github\.io\/lampa-plugins\/loader\.js(?:[?#]|$)/i;
    var RE_OLD = /jsdelivr[^ ]*(?:lampa-torrserver-failover|torrserver[_-]failover)|torrserver[_-]failover[^/]*\.js/i;

    // urls: ссылки из списка расширений Лампы, src: адрес самого файла плагина, loader: сработал ли загрузчик
    function classify(urls, src, loader) {
        var list = (urls || []).map(String);
        var old = list.filter(function (u) { return RE_OLD.test(u); });
        var kind = list.some(function (u) { return RE_SHORT.test(u); }) ? 'short'
            : list.some(function (u) { return RE_FULL.test(u); }) ? 'full'
            : (loader ? 'loader' : (/lampa_watch\.js/.test(src || '') ? 'direct' : 'unknown'));
        var NAME = { short: 'Короткая ссылка', full: 'Полная ссылка', loader: 'Загрузчик', direct: 'Прямая ссылка на файл', unknown: 'Не удалось определить' };
        var SUB = {
            short: 'snowymay111.github.io/l.js · обновляется само',
            full: 'lampa-plugins/loader.js · обновляется само',
            loader: 'Загрузчик подключён · обновляется само',
            direct: 'Файл подключён напрямую: сам он не обновится. Лучше добавить короткую ссылку из README',
            unknown: 'Плагин работает, но откуда он взят, определить не вышло'
        };
        var level = kind === 'direct' || kind === 'unknown' ? 'warn' : 'ok';
        var sub = SUB[kind];

        if (old.length) {
            level = 'warn';
            sub += '. Есть старая ссылка (' + old.length + '): удалите её в Расширениях, иначе заработает старая версия';
        }

        return { level: level, kind: kind, old: old.length, value: NAME[kind], sub: sub };
    }

    function pluginUrls() {
        var out = [];

        try {
            var list = L().Storage.get('plugins', '[]');

            if (typeof list === 'string') list = JSON.parse(list);

            (list || []).forEach(function (p) {
                if (p && p.url) out.push(p.url);
            });
        } catch (e) {}

        return out;
    }

    function sourceCard() {
        return classify(pluginUrls(), LW.src || '', !!window.lampa_plugins_loader);
    }

    // ---------------------------------------------------------------- версия

    function versionResult(local, remote) {
        if (!remote) return { level: 'warn', value: local, sub: 'Проверить, есть ли новая версия, не вышло: нет связи с сайтом обновлений' };

        var c = cmpVer(remote, local);

        if (c > 0) return { level: 'warn', value: local, sub: 'Вышла версия ' + remote + '. Перезапустите Лампу, обновление подхватится само', latest: remote };
        if (c < 0) return { level: 'ok', value: local, sub: 'Это версия новее опубликованной (' + remote + ')', latest: remote };

        return { level: 'ok', value: local, sub: 'Последняя: ' + remote + '. Обновление не нужно', latest: remote };
    }

    function fetchLatest(done) {
        var net;
        var finished = false;
        var timer;

        function end(v) {
            if (finished) return;

            finished = true;
            clearTimeout(timer);
            done(v);
        }

        try {
            net = new (L().Reguest)();
            net.timeout(NET_MS);
        } catch (e) {
            return end('');
        }

        timer = setTimeout(function () {
            try { net.clear(); } catch (e) {}
            end('');
        }, NET_MS + 1500);

        try {
            net.native(MANIFEST_URL + '?t=' + now(), function (json) {
                var list = (json && json.plugins) || [];
                var me = list.filter(function (p) { return p && p.id === 'lampa_watch'; })[0];

                end(me && me.version ? String(me.version) : '');
            }, function () { end(''); });
        } catch (e) {
            end('');
        }
    }

    // ---------------------------------------------------------------- парсер и TorrServer

    function parserCheck(done) {
        var P = LW.parser;

        if (!P) return done({ level: 'warn', value: 'Модуль не загружен', sub: '' });

        var label = P.currentLabel();
        var cands = [];

        try { cands = P.candidates(P.readCurrent(), P.torrUrl(), []).filter(function (c) { return c.current; }); } catch (e) {}

        if (!cands.length) return done({ level: 'bad', value: label, sub: 'Парсер не настроен. В настройках есть кнопка «Подобрать парсер»: она всё сделает сама' });

        P.probe(cands[0], P.PROBE_QUERY, function (res) {
            var sec = comma(Math.round(res.ms / 100) / 10);

            if (!res.ok) return done({ level: 'bad', value: label, sub: 'Не ответил (' + (res.error || 'нет ответа') + '). Кнопка «Подобрать парсер» найдёт рабочий' });

            var n = res.ev && res.ev.relevant ? res.ev.relevant : 0;

            if (res.rating < 15) return done({ level: 'warn', value: label, sub: 'Ответил за ' + sec + ' с, но по пробному запросу пусто' });

            done({
                level: res.ms > 5000 ? 'warn' : 'ok',
                value: label,
                sub: 'Ответил за ' + sec + ' с · ' + n + ' ' + plural(n, 'раздача', 'раздачи', 'раздач') + ' в пробном поиске'
            });
        });
    }

    function serverCheck(done) {
        var T = LW.tune;

        if (!T) return done({ level: 'warn', value: 'Модуль не загружен', sub: '' });

        var addr = T.baseUrl();

        if (!addr) return done({ level: 'warn', value: 'Адрес не задан', sub: 'Укажите TorrServer в настройках Лампы, без него торренты не запустятся' });

        var host = LW.parser ? LW.parser.hostOf(addr) : addr;
        var t0 = now();

        T.load(function (err, cur) {
            var ms = now() - t0;

            if (err) return done({ level: 'bad', value: host, sub: err });

            var pre = cur.PreloadCache !== undefined ? 'Предзагрузка ' + cur.PreloadCache + '%' : '';
            var cache = cur.CacheSize ? 'кеш ' + T.size(cur.CacheSize) : '';

            done({ level: ms > 2500 ? 'warn' : 'ok', value: host + ' · ' + ms + ' мс', sub: [pre, cache].filter(function (x) { return x; }).join(', ') || 'Отвечает' });
        });
    }

    // ---------------------------------------------------------------- плавность

    // Считаем кадры за FPS_MS миллисекунд и долгие задачи (дольше 50 мс). Только по просьбе человека: постоянно считать незачем.
    function summarizeFrames(stamps, longTasks) {
        if (stamps.length < 3) return { level: 'warn', value: 'Не удалось измерить', sub: 'Окно было закрыто слишком быстро' };

        var span = stamps[stamps.length - 1] - stamps[0];
        var fps = span > 0 ? Math.round((stamps.length - 1) * 1000 / span) : 0;
        var worstMs = 0;

        for (var i = 1; i < stamps.length; i++) worstMs = Math.max(worstMs, stamps[i] - stamps[i - 1]);

        worstMs = Math.round(worstMs);

        var level = fps >= 50 && worstMs < 80 ? 'ok' : fps >= 30 ? 'warn' : 'bad';
        var tasks = longTasks === null ? '' : ' · долгих задач ' + longTasks;

        return {
            level: level,
            fps: fps,
            worst: worstMs,
            value: fps + ' кадров/с',
            sub: 'Самый долгий кадр ' + worstMs + ' мс' + tasks + (level === 'ok' ? '' : '. Если интерфейс тормозит, выключите «Оформление» или поставьте «Минимум» анимаций')
        };
    }

    function frameCheck(done) {
        var raf = window.requestAnimationFrame;
        var stamps = [];
        var tasks = 0;
        var observer = null;
        var started = now();

        if (!raf) return done({ level: 'warn', value: 'Недоступно', sub: 'Браузер не умеет считать кадры' });

        try {
            if (window.PerformanceObserver) {
                observer = new window.PerformanceObserver(function (list) { tasks += list.getEntries().length; });
                observer.observe({ entryTypes: ['longtask'] });
            }
        } catch (e) { observer = null; }

        function frame(ts) {
            stamps.push(typeof ts === 'number' ? ts : now());

            if (now() - started >= FPS_MS) {
                if (observer) { try { observer.disconnect(); } catch (e) {} }

                return done(summarizeFrames(stamps, observer ? tasks : null));
            }

            raf.call(window, frame);
        }

        raf.call(window, frame);
    }

    // ---------------------------------------------------------------- итог для строки настроек

    function summaryText(level, version) {
        return version + ' · ' + (level === 'bad' ? TXT.someBad : level === 'warn' ? TXT.someWarn : TXT.allGood);
    }

    function lastSummary() {
        var last = readStore(STORE_LAST, null);

        if (!last || !last.level) return LW.version + ' · ' + TXT.notChecked;

        return summaryText(last.level, LW.version);
    }

    // ---------------------------------------------------------------- окно

    var token = 0;

    function addStyle() {
        if (document.getElementById('lw-health-style')) return;

        var css = [
            '.lw-dg{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.6em;margin-top:.9em}',
            '.lw-dgc{padding:.7em .9em;border-radius:.6em;background:rgba(255,255,255,.07);min-width:0}',
            '.lw-dgc--wide{grid-column:1 / 3}',
            '.lw-dgc__l{display:flex;align-items:center;font-size:.8em;letter-spacing:.06em;text-transform:uppercase;opacity:.75}',
            '.lw-dgc__v{margin-top:.35em;font-size:1.15em;font-weight:600;word-break:break-word}',
            '.lw-dgc__s{margin-top:.25em;font-size:.85em;line-height:1.35;opacity:.7}',
            '.lw-hdot{display:inline-block;flex:none;width:1.35em;height:1.35em;margin-right:.55em;border-radius:50%;text-align:center;line-height:1.35em;font-size:.85em;font-style:normal;text-transform:none;letter-spacing:0;color:#000;background:#9aa0a6}',
            '.lw-hdot--ok{background:var(--ok,#5fe39a)}',
            '.lw-hdot--warn{background:var(--warn,#ffd25a)}',
            '.lw-hdot--bad{background:var(--bad,#ff6b6b)}',
            '.lw-dgc__w{margin-left:.6em;text-transform:none;letter-spacing:0;opacity:.9}'
        ].join('\n');

        var el = document.createElement('style');

        el.id = 'lw-health-style';
        el.appendChild(document.createTextNode(css));
        document.head.appendChild(el);
    }

    function cardDom(key, label, wide) {
        var c = $('<div class="lw-dgc"></div>').attr('data-key', key);

        if (wide) c.addClass('lw-dgc--wide');

        c.append($('<div class="lw-dgc__l"></div>')
            .append($('<i class="lw-hdot lw-hdot--run"></i>').text(MARK.run))
            .append(document.createTextNode(label))
            .append($('<span class="lw-dgc__w"></span>').text(WORD.run)));
        c.append($('<div class="lw-dgc__v"></div>').text('…'));
        c.append($('<div class="lw-dgc__s"></div>'));

        return c;
    }

    function paint(card, r) {
        var dot = card.find('.lw-hdot');

        dot.attr('class', 'lw-hdot lw-hdot--' + r.level).text(MARK[r.level]);
        card.find('.lw-dgc__w').text(WORD[r.level]);
        card.find('.lw-dgc__v').text(r.value || '');
        card.find('.lw-dgc__s').text(r.sub || '');
        card.attr('data-level', r.level);
    }

    // opts: { back: контроллер для возврата, onDone(level) }
    function openDiag(opts) {
        opts = opts || {};
        addStyle();

        var U = LW.ui;

        if (!U) return;

        var box = U.h('div', 'lw-box lw-box--diag');
        var grid = $('<div class="lw-dg"></div>');
        var cards = {};
        var results = {};
        var left = 0;
        var closed = false;

        box.append(U.h('div', 'lw-kicker', TXT.kicker));
        box.append(U.h('div', 'lw-title', TXT.title));

        [['version', TXT.version], ['source', TXT.source], ['parser', TXT.parser], ['server', TXT.server], ['perf', TXT.perf], ['errors', TXT.errors, true]].forEach(function (c) {
            cards[c[0]] = cardDom(c[0], c[1], c[2]);
            grid.append(cards[c[0]]);
        });

        box.append(grid);

        function close() {
            closed = true;
            U.closeModal();

            if (opts.back) {
                try { L().Controller.toggle(opts.back); } catch (e) {}
            }
        }

        function finishOne(key, r, my) {
            if (closed || my !== token) return;

            results[key] = r;
            paint(cards[key], r);

            if (--left > 0) return;

            var level = worst(Object.keys(results).map(function (k) { return results[k].level; }));

            store(STORE_LAST, { at: now(), level: level });

            if (opts.onDone) opts.onDone(level);
        }

        function run() {
            var my = ++token;

            left = 6;
            results = {};

            Object.keys(cards).forEach(function (k) {
                cards[k].attr('data-level', 'run').find('.lw-hdot').attr('class', 'lw-hdot lw-hdot--run').text(MARK.run);
                cards[k].find('.lw-dgc__w').text(WORD.run);
            });

            var local = LW.version;

            finishOne('errors', errorsCard(), my);
            finishOne('source', sourceCard(), my);

            fetchLatest(function (remote) { finishOne('version', versionResult(local, remote), my); });
            parserCheck(function (r) { finishOne('parser', r, my); });
            serverCheck(function (r) { finishOne('server', r, my); });
            frameCheck(function (r) { finishOne('perf', r, my); });
        }

        U.openModal({
            title: '',
            html: box,
            size: 'large',
            buttons: [
                { name: TXT.recheck, onSelect: function () { run(); } },
                { name: TXT.close, onSelect: close }
            ],
            onBack: close
        });

        run();
    }

    // ---------------------------------------------------------------- строка в настройках

    var rowItem = null;

    function refreshRow() {
        if (rowItem) rowItem.find('.settings-param__descr').text(lastSummary());
    }

    function addSettings(api) {
        api.addParam({
            component: 'lampa_watch',
            param: { name: 'lw_health_open', type: 'button' },
            field: { name: TXT.setting, description: TXT.settingHint },
            onRender: function (item) { rowItem = item; refreshRow(); },
            onChange: function () { openDiag({ back: 'settings_component', onDone: refreshRow }); }
        });
    }

    return {
        TXT: TXT,
        note: note,
        errors: errors,
        clearErrors: clearErrors,
        errorsCard: errorsCard,
        classify: classify,
        sourceCard: sourceCard,
        cmpVer: cmpVer,
        versionResult: versionResult,
        fetchLatest: fetchLatest,
        parserCheck: parserCheck,
        serverCheck: serverCheck,
        summarizeFrames: summarizeFrames,
        frameCheck: frameCheck,
        whenText: whenText,
        summaryText: summaryText,
        lastSummary: lastSummary,
        worst: worst,
        openDiag: openDiag,
        addSettings: addSettings
    };
})();
