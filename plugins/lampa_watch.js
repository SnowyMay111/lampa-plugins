/*
 * Lampa Watch 1.6.0
 * Подбор лучшей раздачи, прогноз «будет ли лагать», автопереключение TorrServer.
 * Файл собран из src/ командой node build.js. Править нужно исходники, а не этот файл.
 */
(function () {
    'use strict';

    if (window.lampa_watch_bundle) return;
    window.lampa_watch_bundle = true;

    var LW = { version: '1.6.0' };
    // адрес, с которого загружен файл: диагностика показывает его человеку (currentScript есть только пока файл выполняется)
    try { LW.src = (document.currentScript && document.currentScript.src) || ''; } catch (e) { LW.src = ''; }

    // Каждый модуль в своей оболочке: сбой одного не мешает остальным
    function run(name, fn) {
        try { fn(LW); } catch (e) {
            if (window.console) console.log("[lampa-watch] модуль " + name + ": " + e);
            if (LW.health) LW.health.note("module", "Модуль " + name + " не запустился: " + e);
        }
    }

    run('health', function (LW) {
        'use strict';

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
    });

    run('speed', function (LW) {
        'use strict';

        /*
         * Прогноз: хватит ли скорости раздачи, чтобы фильм шёл без подвисаний.
         *
         * Два способа:
         *   1. Прикидка до запуска. По числу раздающих и размеру файла: сколько Мбит/с нужно
         *      фильму и сколько примерно даст раздача. Грубо, но позволяет сразу не выбирать заведомо тяжёлое.
         *   2. Замер при запуске. TorrServer начинает загрузку начала файла, мы 10-15 секунд
         *      смотрим реальную скорость и говорим вердикт: плавно, на грани, будет лагать, не рекомендую.
         *
         * Правило плавности простое. Если скорость загрузки не ниже битрейта фильма, всё идёт без пауз.
         * Если ниже, нужно сначала накопить запас: ждать (1/отношение - 1) от длины фильма.
         */
        LW.speed = (function () {
            // Типичный битрейт, Мбит/с, если по размеру и длине его не посчитать
            var TYPICAL = { 2160: 25, 1080: 9, 720: 4.5, 480: 1.8, 0: 6 };

            var DEFAULT_LINE = 100; // предел скорости, пока мы ни разу её не измеряли, Мбит/с

            var VERDICT_ORDER = ['smooth', 'edge', 'lag', 'bad'];

            function round1(x) {
                return Math.round(x * 10) / 10;
            }

            // Длина фильма или серии, минут
            function runtimeMin(movie) {
                var r = movie && (movie.runtime || (movie.episode_run_time && movie.episode_run_time[0]));

                r = parseInt(r, 10);

                return r > 0 ? r : 0;
            }

            function isTv(movie) {
                return !!(movie && (movie.name || movie.number_of_seasons));
            }

            // Какой скорости нужно для плавного просмотра, Мбит/с. Для сезона целиком считаем по типичному битрейту:
            // размер одной серии из названия раздачи не вытащить.
            function need(gb, quality, movie) {
                var runtime = runtimeMin(movie);

                if (!isTv(movie) && gb > 0 && runtime > 0) return round1(gb * 8000 / (runtime * 60));

                return TYPICAL[quality] || TYPICAL[0];
            }

            // Прикидка скорости раздачи без замера, Мбит/с. Пример: 10 раздающих дадут около 8 Мбит/с,
            // 100 и больше упрутся в предел вашей линии.
            function estimate(seeds, lineMbps) {
                var cap = lineMbps > 0 ? lineMbps : DEFAULT_LINE;

                return round1(Math.min(cap, 0.8 * (seeds || 0)));
            }

            // Вердикт по отношению скорости к нужному битрейту.
            // durationMin нужен, чтобы сказать, сколько ждать накопления запаса.
            function verdict(haveMbps, needMbps, durationMin) {
                if (!(haveMbps >= 0) || !(needMbps > 0)) return { level: 'unknown', ratio: 0, waitMin: 0 };

                var ratio = haveMbps / needMbps;
                var level = ratio >= 1.5 ? 'smooth' : ratio >= 1 ? 'edge' : ratio >= 0.6 ? 'lag' : 'bad';
                var wait = 0;

                if (ratio < 1 && ratio > 0 && durationMin > 0) wait = Math.ceil(durationMin * (1 / ratio - 1));

                return { level: level, ratio: round1(ratio), waitMin: wait, have: round1(haveMbps), need: round1(needMbps) };
            }

            // Что может помочь. Возвращает ключи подсказок: тексты подставляет интерфейс.
            // ctx: { peers, seeders, need, have, level, wifiRisk }
            function tips(v, ctx) {
                var out = [];
                var c = ctx || {};

                if (v.level === 'smooth' || v.level === 'unknown') return out;

                if (c.seeders !== undefined && c.seeders < 5) out.push('fewSeeds');
                if (c.peers !== undefined && c.peers < 8) out.push('fewPeers');

                if (v.level === 'bad' || v.level === 'lag') out.push('lighter');

                if (v.waitMin > 0 && v.waitMin <= 60) out.push('wait');

                if (v.level === 'edge' || v.level === 'lag') out.push('cache');

                if (c.need > 40) out.push('wired');

                out.push('otherDownloads');

                return out;
            }

            // Лёгкая раздача: самая высокая по оценке из тех, что потянет замеренная скорость с запасом 1,3.
            // ranked: упорядоченный список из LW.score.rank, current: выбранная сейчас запись.
            function lighter(ranked, haveMbps, current) {
                var i;

                for (i = 0; i < ranked.length; i++) {
                    var e = ranked[i];

                    if (e === current || !e.playable || e.relevance <= 0) continue;
                    if (current && e.need >= current.need) continue;
                    if (e.need * 1.3 <= haveMbps) return e;
                }

                // ничего с запасом: берём самую лёгкую из играбельных
                var best = null;

                for (i = 0; i < ranked.length; i++) {
                    var x = ranked[i];

                    if (x === current || !x.playable || x.relevance <= 0) continue;
                    if (current && x.need >= current.need) continue;
                    if (!best || x.need < best.need) best = x;
                }

                return best;
            }

            // Реальный замер. Все обращения к сети приходят снаружи (opts.get), чтобы это можно было проверить в тестах.
            // opts: { url, get(url, ok, fail), duration, interval, warmup, now() }
            // done(result), progress(sample)
            function measure(opts, done, progress) {
                var duration = opts.duration || 12000;
                var interval = opts.interval || 1000;
                var warmup = opts.warmup === undefined ? 3000 : opts.warmup;
                var now = opts.now || function () { return new Date().getTime(); };
                var statUrl = opts.url.replace('&preload', '&stat');
                var started = now();
                var samples = [];
                var last = {};
                var stopped = false;
                var timer = null;
                var first = true;

                function finish(reason) {
                    if (stopped) return;

                    stopped = true;
                    clearTimeout(timer);

                    var speeds = samples.map(function (s) { return s.mbps; });
                    var sum = 0;
                    var max = 0;

                    speeds.forEach(function (x) {
                        sum += x;
                        if (x > max) max = x;
                    });

                    var avg = speeds.length ? sum / speeds.length : 0;
                    var elapsed = Math.max(1, now() - started) / 1000;

                    // Если начало файла загрузилось быстрее, чем мы успели насемплировать, берём скорость по объёму
                    var byBytes = last.preloaded > 0 ? last.preloaded * 8 / 1e6 / elapsed : 0;

                    done({
                        ok: speeds.length >= 2 || byBytes > 0,
                        avgMbps: round1(Math.max(avg, byBytes)),
                        maxMbps: round1(max),
                        peers: last.peers || 0,
                        seeders: last.seeders || 0,
                        preloaded: last.preloaded || 0,
                        preloadSize: last.preloadSize || 0,
                        seconds: Math.round(elapsed),
                        reason: reason
                    });
                }

                function tick() {
                    if (stopped) return;

                    var url = first ? opts.url : statUrl;

                    first = false;

                    opts.get(url, function (res) {
                        if (stopped) return;

                        res = res || {};

                        var elapsed = now() - started;
                        var mbps = (res.download_speed || 0) * 8 / 1e6;

                        last = {
                            preloaded: res.preloaded_bytes || 0,
                            preloadSize: res.preload_size || 0,
                            peers: res.active_peers || 0,
                            seeders: res.connected_seeders || 0
                        };

                        if (elapsed >= warmup) samples.push({ mbps: mbps, t: elapsed });

                        if (progress) progress({ mbps: round1(mbps), elapsed: elapsed, preloaded: last.preloaded, preloadSize: last.preloadSize, peers: last.peers });

                        var preloadDone = last.preloadSize > 0 && last.preloaded >= last.preloadSize * 0.95;

                        if (preloadDone) return finish('preloaded');
                        if (elapsed >= duration) return finish('time');

                        timer = setTimeout(tick, interval);
                    }, function () {
                        if (stopped) return;

                        if (now() - started >= duration) return finish('error');

                        timer = setTimeout(tick, interval);
                    });
                }

                tick();

                return function cancel() { finish('cancel'); };
            }


            // Запас перед стартом. Если раздача качается медленнее, чем нужно фильму, плеер упрётся в конец накопленного.
            // Чтобы досмотреть без пауз, начало надо накопить заранее: весь недобор за фильм (нужно - есть) * длительность,
            // плюс 10% на колебания скорости. Один Мбит/с это 125 000 байт в секунду.
            // Возвращает { needed, bytes, waitSec, waitMin, feasible }: feasible = ждать не дольше часа.
            var RESERVE_MARGIN = 1.1;
            var RESERVE_MAX_MIN = 60;

            function reserve(haveMbps, needMbps, durationMin) {
                var out = { needed: false, bytes: 0, waitSec: 0, waitMin: 0, feasible: false };

                if (!(haveMbps > 0) || !(needMbps > 0) || !(durationMin > 0) || haveMbps >= needMbps) return out;

                var bytes = Math.round((needMbps - haveMbps) * durationMin * 60 * 125000 * RESERVE_MARGIN);
                var sec = Math.ceil(bytes / (haveMbps * 125000));

                out.needed = true;
                out.bytes = bytes;
                out.waitSec = sec;
                out.waitMin = Math.max(1, Math.round(sec / 60));
                out.feasible = sec <= RESERVE_MAX_MIN * 60;

                return out;
            }

            // Сколько реально накопит сервер: предзагрузка TorrServer ограничена своей настройкой (preload_size).
            // Если она известна и меньше нужного, копим до неё и говорим об этом честно.
            function reserveTarget(bytes, preloadSize) {
                if (preloadSize > 0 && preloadSize < bytes) return { bytes: preloadSize, capped: true };

                return { bytes: bytes, capped: false };
            }

            // Копим запас: опрашиваем состояние торрента, пока не накопится нужное, не упрёмся в предел сервера,
            // не застоимся или не выйдет время. opts: { url (адрес предзагрузки), get(url, ok, fail), targetBytes, maxMs, interval, stallMs, now() }
            // done({ reason: 'ready' | 'stalled' | 'time' | 'cancel', preloaded, target, capped, mbps, peers, seconds }), progress({ preloaded, target, pct, mbps, etaSec, peers, elapsed, capped })
            function accumulate(opts, done, progress) {
                var interval = opts.interval || 1000;
                var maxMs = opts.maxMs || 30 * 60000;
                var stallMs = opts.stallMs || 25000;
                var now = opts.now || function () { return new Date().getTime(); };
                var statUrl = opts.url.replace('&preload', '&stat');
                var started = now();
                var grew = started;
                var best = 0;
                var target = opts.targetBytes;
                var capped = false;
                var speeds = [];
                var last = {};
                var stopped = false;
                var timer = null;

                function avgSpeed() {
                    if (!speeds.length) return 0;

                    var sum = 0;

                    speeds.forEach(function (x) { sum += x; });

                    return sum / speeds.length;
                }

                function finish(reason) {
                    if (stopped) return;

                    stopped = true;
                    clearTimeout(timer);

                    done({
                        reason: reason, preloaded: best, target: target, capped: capped,
                        mbps: round1(avgSpeed()), peers: last.peers || 0,
                        seconds: Math.round(Math.max(1, now() - started) / 1000)
                    });
                }

                function tick() {
                    if (stopped) return;

                    opts.get(statUrl, function (res) {
                        if (stopped) return;

                        res = res || {};

                        var t = now();
                        var bytes = res.preloaded_bytes || 0;
                        var mbps = (res.download_speed || 0) * 8 / 1e6;
                        var cut = reserveTarget(opts.targetBytes, res.preload_size || 0);

                        target = cut.bytes;
                        capped = cut.capped;

                        if (bytes > best) {
                            best = bytes;
                            grew = t;
                        }

                        speeds.push(mbps);

                        if (speeds.length > 6) speeds.shift();

                        last = { peers: res.active_peers || 0 };

                        var avg = avgSpeed();

                        if (progress) {
                            progress({
                                preloaded: best, target: target, capped: capped,
                                pct: target > 0 ? Math.min(100, Math.floor(best / target * 100)) : 0,
                                mbps: round1(avg),
                                etaSec: avg > 0 && best < target ? Math.ceil((target - best) / (avg * 125000)) : 0,
                                peers: last.peers, elapsed: t - started
                            });
                        }

                        if (target > 0 && best >= target * 0.95) return finish('ready');
                        if (t - grew >= stallMs) return finish('stalled');
                        if (t - started >= maxMs) return finish('time');

                        timer = setTimeout(tick, interval);
                    }, function () {
                        if (stopped) return;

                        if (now() - started >= maxMs) return finish('time');

                        timer = setTimeout(tick, interval);
                    });
                }

                tick();

                return function cancel() { finish('cancel'); };
            }

            return {
                TYPICAL: TYPICAL,
                DEFAULT_LINE: DEFAULT_LINE,
                VERDICT_ORDER: VERDICT_ORDER,
                runtimeMin: runtimeMin,
                isTv: isTv,
                need: need,
                estimate: estimate,
                verdict: verdict,
                tips: tips,
                lighter: lighter,
                measure: measure,
                reserve: reserve,
                reserveTarget: reserveTarget,
                accumulate: accumulate
            };
        })();
    });

    run('score', function (LW) {
        'use strict';

        /*
         * Разбор названий раздач и подбор лучшей под пожелания.
         * Чистая логика без обращений к Лампе: её можно прогонять в тестах.
         *
         * Каждой раздаче ставится оценка из трёх частей.
         *   1. Насколько она подходит под пожелания (качество, HDR, Dolby Vision, язык и тип озвучки, субтитры, сезон).
         *   2. Насколько она живая и быстрая (раздающие, источник, кодек, разумный размер, прогноз скорости).
         *   3. Штрафы за мусор (CAM, 3D, не тот фильм, не тот год, сериал вместо фильма).
         * Если какое-то пожелание выполнить нельзя, оценка не обнуляется: просто выигрывает
         * лучшая из оставшихся. «4K + HDR» без таких раздач даст лучший 4K, а без 4K лучшую 1080p.
         */
        LW.score = (function () {
            var LADDER = [480, 720, 1080, 2160]; // от худшего к лучшему

            var QUALITY_LABEL = { 2160: '4K', 1080: '1080p', 720: '720p', 480: 'SD', 0: '?' };

            var DEFAULT_WISHES = {
                quality: '2160', // '2160' | '1080' | '720' | 'any'
                hdr: 'any',      // 'yes' | 'any' | 'no'
                dv: 'any',       // 'yes' | 'any' | 'no'
                lang: 'any',     // язык озвучки: 'any' | 'ru' | 'uk' | 'en' | 'orig' | 'de' | 'fr' | 'es' | 'it' | 'pl' | 'ja' | 'ko'
                voice: 'any',    // тип озвучки: 'any' | 'dub' (дубляж) | 'mvo' (многоголосая, закадровая)
                subs: 'any',     // 'yes' | 'any'
                seeds: 3,        // раздающих не меньше
                season: 0,       // только для сериалов: нужный сезон (0 = не важно)
                episode: 0,      // только для сериалов: нужная серия (0 = выбрать в списке)
                instant: false,  // запускать сразу, без показа выбора
                line: 0          // известная скорость линии, Мбит/с (0 = не знаем)
            };

            // Языки озвучки, которые можно выбрать. Порядок = порядок в меню.
            var LANGS = ['any', 'ru', 'uk', 'en', 'orig', 'de', 'fr', 'es', 'it', 'pl', 'ja', 'ko'];

            // Небольшая добавка за репутацию источника. Это не главный фактор, а подстраховка при равных оценках.
            var TRACKER_TRUST = {
                rutracker: 3, kinozal: 3, nnmclub: 2, 'nnm-club': 2, rutor: 2, toloka: 2,
                bitru: 1, megapeer: 1, torrentby: 1, rustorka: 1, lostfilm: 2, hdclub: 2
            };

            // ---------------------------------------------------------------- вспомогательное

            function log2(x) {
                return Math.log(x) / Math.LN2;
            }

            // \b в JS не понимает кириллицу, поэтому границы слов задаём явно
            function word(re) {
                return new RegExp('(^|[^a-z0-9а-яе])(?:' + re + ')(?=$|[^a-z0-9а-яе])', 'i');
            }

            var RE = {
                q2160: word('2160[pi]?|4k|uhd|ultra ?hd|ultrahd'),
                q1080: word('1080[pi]?|full ?hd|fhd'),
                q720: word('720[pi]?|hd ?720'),
                q480: word('480[pi]?|576[pi]?|dvdrip|dvd5|dvd9|sdtv|dvdscr'),
                hdr: word('hdr(?:10\\+|10plus|10|\\+)?|hlg'),
                dv: word('dolby ?vision|dovi|dv'),
                d3: word('3d|sbs|h-?sbs|half-?sbs|half-?ou|h-?ou'),
                cam: word('cam(?:rip)?|hdcam|ts|hdts|telesync|tc|telecine|scr|screener|hdtc'),
                serial: word('s\\d{1,2} ?e\\d{1,3}|\\d{1,2}x\\d{2}|сезон[а-я]*|серии|серия|season'),
                remux: word('remux|bdremux'),
                bluray: word('blu-?ray|bdrip|brrip|bd-?rip|bd'),
                webdl: word('web-?dl|webdl(?:rip)?'),
                webrip: word('web-?rip'),
                hdtv: word('hdtv|hdtvrip|tvrip'),
                hdrip: word('hdrip'),
                hevc: word('hevc|x265|h\\.?265|h265'),
                avc: word('avc|x264|h\\.?264|h264'),
                av1: word('av1'),
                atmos: word('atmos|truehd|dts-?hd|dts-?x'),
                subs: word('subs?|subtitles?|суб[а-я]*|srt|forced'),
                mvo: word('многоголос[а-я]*|mvo|dvo|avo|двухголос[а-я]*|одноголос[а-я]*|закадров[а-я]*|lostfilm|hdrezka|jaskier|кубик в кубе|новамедиа|baibako'),
                // язык озвучки
                ru: word('rus(?:sian)?|рус[а-я]*|lostfilm|hdrezka|jaskier|кубик в кубе|baibako'),
                uk: word('укр[а-я]*|ukr(?:ainian)?|ua|українськ[а-я]*|украинск[а-я]*'),
                en: word('eng(?:lish)?|англ[а-я]*'),
                orig: word('original|оригинал[а-я]*|orig'),
                de: word('ger(?:man)?|deu|немецк[а-я]*'),
                fr: word('fra|french|французск[а-я]*'),
                es: word('spa(?:nish)?|испанск[а-я]*'),
                it: word('ita(?:lian)?|итальянск[а-я]*'),
                pl: word('pol(?:ish)?|польск[а-я]*'),
                ja: word('jpn|jap(?:anese)?|японск[а-я]*'),
                ko: word('kor(?:ean)?|корейск[а-я]*')
            };

            // «D» как дубляж слишком коротко и даёт ложные срабатывания: берём только слова и запись в скобках
            RE.dub = new RegExp('(?:дублир|дубляж|\\bdub(?:bed)?\\b|(?:^|[\\[\\(, ])d(?:[\\]\\), ]|$))', 'i');

            // ---------------------------------------------------------------- разбор названия

            function langsOf(t, info, movie) {
                var out = [];
                var code;

                ['uk', 'en', 'de', 'fr', 'es', 'it', 'pl', 'ja', 'ko'].forEach(function (c) {
                    if (RE[c].test(t)) out.push(c);
                });

                // «Дубляж» или «MVO» без пометки языка почти всегда русские: так подписывают раздачи русскоязычные трекеры
                if (RE.ru.test(t) || ((info.dub || info.mvo) && out.indexOf('uk') < 0)) out.push('ru');

                // «Оригинал» = язык оригинала фильма (из TMDB), по умолчанию английский
                if (RE.orig.test(t)) {
                    code = (movie && movie.original_language) || 'en';

                    if (out.indexOf(code) < 0) out.push(code);

                    info.orig = true;
                }

                return out;
            }

            function seasonsOf(t) {
                var m;

                m = t.match(/(?:сезон[ыа]?|season|seasons)\s*[:№#]?\s*(\d{1,2})(?!\d)(?:\s*[-–—]\s*(\d{1,2})(?!\d))?/);
                if (!m) m = t.match(/(?:^|[^0-9])(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?\s*(?:сезон|season)/);
                if (!m) m = t.match(/(?:^|[^a-z0-9])s(\d{1,2})(?!\d)(?:\s*[-–—]\s*s?(\d{1,2})(?!\d))?(?=$|[^a-z0-9])/);
                if (!m) m = t.match(/(?:^|[^a-z0-9])s(\d{1,2})e\d{1,3}/);

                if (!m) return null;

                var from = parseInt(m[1], 10);
                var to = m[2] ? parseInt(m[2], 10) : from;

                return { from: Math.min(from, to), to: Math.max(from, to) };
            }

            // Все ли серии сезона в раздаче: «Серии: 1-8 из 8»
            function packOf(t) {
                var m = t.match(/(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*(?:из|of)\s*(\d{1,3})/);

                if (!m) return null;

                return { from: parseInt(m[1], 10), to: parseInt(m[2], 10), total: parseInt(m[3], 10), complete: parseInt(m[2], 10) >= parseInt(m[3], 10) };
            }

            function parse(title, movie) {
                var t = ((title || '') + '').toLowerCase().replace(/ё/g, 'е');
                var info = {
                    quality: 0, hdr: false, dv: false, d3: false, cam: false, serial: false,
                    source: '', codec: '', atmos: false, subs: false, dub: false, mvo: false, orig: false,
                    years: [], langs: [], seasons: null, pack: null
                };

                if (RE.q2160.test(t)) info.quality = 2160;
                else if (RE.q1080.test(t)) info.quality = 1080;
                else if (RE.q720.test(t)) info.quality = 720;
                else if (RE.q480.test(t)) info.quality = 480;

                info.hdr = RE.hdr.test(t);
                info.dv = RE.dv.test(t);
                info.d3 = RE.d3.test(t);
                info.cam = RE.cam.test(t);
                info.serial = RE.serial.test(t);

                if (RE.remux.test(t)) info.source = 'remux';
                else if (RE.bluray.test(t)) info.source = 'bluray';
                else if (RE.webdl.test(t)) info.source = 'webdl';
                else if (RE.webrip.test(t)) info.source = 'webrip';
                else if (RE.hdtv.test(t)) info.source = 'hdtv';
                else if (RE.hdrip.test(t)) info.source = 'hdrip';

                if (RE.hevc.test(t)) info.codec = 'hevc';
                else if (RE.av1.test(t)) info.codec = 'av1';
                else if (RE.avc.test(t)) info.codec = 'avc';

                info.atmos = RE.atmos.test(t);
                info.subs = RE.subs.test(t);
                info.dub = RE.dub.test(t);
                info.mvo = RE.mvo.test(t);
                info.langs = langsOf(t, info, movie);
                info.seasons = seasonsOf(t);
                info.pack = packOf(t);

                var years = t.match(/(?:^|[^0-9])((?:19|20)\d{2})(?=$|[^0-9])/g) || [];

                info.years = years.map(function (y) { return parseInt(y.replace(/\D/g, ''), 10); });

                return info;
            }

            function normalize(s) {
                return ((s || '') + '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-я]+/g, '');
            }

            function movieYear(movie) {
                var d = (movie && (movie.release_date || movie.first_air_date)) || '';
                var y = parseInt((d + '').slice(0, 4), 10);

                return isNaN(y) ? 0 : y;
            }

            function isTv(movie) {
                return !!(movie && (movie.name || movie.number_of_seasons));
            }

            // Раздача про то же кино? 1 = совпало название и год, 0.7 = только название, 0 = мимо
            function relevance(title, info, movie) {
                var names = [movie && movie.original_title, movie && movie.title, movie && movie.name, movie && movie.original_name];
                var t = normalize(title);
                var matched = false;
                var i;

                for (i = 0; i < names.length; i++) {
                    var n = normalize(names[i]);

                    if (n.length >= 2 && t.indexOf(n) >= 0) matched = true;
                }

                if (!matched) return 0;

                // у сериала годы в названиях раздач разные (на каждый сезон свой), поэтому год не сверяем
                if (isTv(movie)) return 1;

                var year = movieYear(movie);

                if (year && info.years.length) {
                    var near = false;

                    for (i = 0; i < info.years.length; i++) {
                        if (Math.abs(info.years[i] - year) <= 1) near = true;
                    }

                    return near ? 1 : 0.2;
                }

                return 0.7;
            }

            // ---------------------------------------------------------------- оценка

            function qualityPoints(have, want) {
                var base = { 2160: 36, 1080: 30, 720: 20, 480: 8, 0: 12 };

                if (!want || want === 'any') return base[have] || 0;

                var w = LADDER.indexOf(parseInt(want, 10));
                var h = LADDER.indexOf(have);

                if (h < 0) return 10;
                if (h === w) return 40;
                if (h > w) return 30 - 4 * (h - w - 1); // выше пожелания: годится, но тяжелее

                return w - h === 1 ? 20 : w - h === 2 ? 8 : 0; // ниже пожелания: чем дальше, тем хуже
            }

            function sizeBounds(quality) {
                if (quality === 2160) return { min: 8, max: 70 };
                if (quality === 1080) return { min: 1.2, max: 30 };
                if (quality === 720) return { min: 0.5, max: 12 };

                return { min: 0.2, max: 8 };
            }

            function num(x) {
                var n = parseFloat(x);

                return isNaN(n) ? 0 : n;
            }

            function trustOf(item) {
                var name = ((item && item.Tracker) || '').toLowerCase().replace(/\s+/g, '');
                var key;

                for (key in TRACKER_TRUST) {
                    if (TRACKER_TRUST.hasOwnProperty(key) && name.indexOf(key) >= 0) return TRACKER_TRUST[key];
                }

                return 0;
            }

            function merge(a, b) {
                var out = {};
                var k;

                for (k in a) if (a.hasOwnProperty(k)) out[k] = a[k];
                for (k in (b || {})) if (b.hasOwnProperty(k) && b[k] !== undefined && b[k] !== null) out[k] = b[k];

                return out;
            }

            // Язык озвучки подходит? «orig» — язык оригинала фильма
            function langOk(info, want, movie) {
                if (want === 'any') return true;
                if (want === 'orig') return info.orig || info.langs.indexOf((movie && movie.original_language) || 'en') >= 0;

                return info.langs.indexOf(want) >= 0;
            }

            // Оценка одной раздачи
            function evaluate(item, wishes, movie) {
                var w = merge(DEFAULT_WISHES, wishes);
                var info = parse(item && item.Title, movie);
                var seeds = parseInt(item && item.Seeders, 10) || 0;
                var peers = parseInt(item && item.Peers, 10) || 0;
                var gb = num(item && item.Size) / 1e9;
                var rel = relevance(item && item.Title, info, movie);
                var tv = isTv(movie);
                var parts = [];
                var checks = [];
                var playable = seeds > 0;

                function add(key, points) {
                    if (points) parts.push({ key: key, points: Math.round(points * 10) / 10 });
                }

                // 1. Пожелания
                add('quality', qualityPoints(info.quality, w.quality));

                checks.push({
                    key: 'quality', wanted: w.quality === 'any' ? '' : QUALITY_LABEL[parseInt(w.quality, 10)],
                    got: QUALITY_LABEL[info.quality],
                    ok: w.quality === 'any' || info.quality === parseInt(w.quality, 10),
                    better: w.quality !== 'any' && info.quality > parseInt(w.quality, 10)
                });

                if (w.hdr === 'yes') add('hdr', info.hdr ? 14 : 0);
                if (w.hdr === 'no') add('hdr', info.hdr ? -10 : 2);
                if (w.hdr !== 'any') checks.push({ key: 'hdr', wanted: w.hdr === 'yes' ? 'HDR' : 'без HDR', got: info.hdr ? 'HDR' : 'нет', ok: (w.hdr === 'yes') === info.hdr });

                if (w.dv === 'yes') add('dv', info.dv ? 10 : 0);
                if (w.dv === 'no') add('dv', info.dv ? -10 : 1);
                if (w.dv !== 'any') checks.push({ key: 'dv', wanted: w.dv === 'yes' ? 'Dolby Vision' : 'без Dolby Vision', got: info.dv ? 'DV' : 'нет', ok: (w.dv === 'yes') === info.dv });

                if (w.lang !== 'any') {
                    var lok = langOk(info, w.lang, movie);

                    // выбранный язык важнее одной ступени качества: тому, кто просит украинскую озвучку, русская не нужна
                    add('lang', lok ? 30 : -15);
                    checks.push({ key: 'lang', wanted: w.lang, got: info.langs.join('/'), ok: lok });
                }

                if (w.voice !== 'any') {
                    var vok = w.voice === 'dub' ? info.dub : (info.mvo || info.dub);

                    add('voice', vok ? 6 : (w.voice === 'mvo' && info.dub ? 3 : 0));
                    checks.push({ key: 'voice', wanted: w.voice, got: info.dub ? 'dub' : info.mvo ? 'mvo' : '', ok: vok });
                }

                if (w.subs === 'yes') {
                    add('subs', info.subs ? 6 : 0);
                    checks.push({ key: 'subs', wanted: 'subs', got: info.subs ? 'subs' : '', ok: info.subs });
                }

                // Сезон: нужный сезон внутри раздачи сильно важнее всего остального
                if (tv && w.season > 0) {
                    var s = info.seasons;
                    var sok = !!(s && s.from <= w.season && w.season <= s.to);

                    if (s) add('season', sok ? 20 : -70);
                    else add('season', -8);

                    if (info.pack && sok && info.pack.complete) add('packFull', 4);

                    checks.push({ key: 'season', wanted: String(w.season), got: s ? (s.from === s.to ? String(s.from) : s.from + '-' + s.to) : '?', ok: sok });
                }

                // 2. Живость, скорость, размер
                add('seeds', Math.min(25, 5 * log2(1 + seeds)));
                add('peers', Math.min(3, log2(1 + Math.max(0, peers - seeds)) / 2));

                if (seeds < w.seeds) add('weak', seeds === 0 ? -100 : -30);

                var src = { remux: 6, bluray: 5, webdl: 5, webrip: 3, hdtv: 1, hdrip: -2 }[info.source];

                add('source', src || 0);
                add('codec', { hevc: 3, avc: 1, av1: -2 }[info.codec] || 0);
                add('audio', info.atmos ? 2 : 0);
                add('tracker', trustOf(item));

                if (gb > 0 && !tv) {
                    var b = sizeBounds(info.quality);

                    if (gb > b.max) add('heavy', -Math.min(15, (gb - b.max) / b.max * 15));
                    else if (gb < b.min) add('tiny', -8);
                    else if (gb >= b.max * 0.2 && gb <= b.max * 0.7) add('size', 4);
                }

                // Прогноз лагов по прикидке. Замер при запуске точнее, но заведомо тяжёлое лучше не выбирать
                var need = LW.speed.need(gb, info.quality, movie);
                var est = LW.speed.estimate(seeds, w.line);
                var forecast = LW.speed.verdict(est, need, LW.speed.runtimeMin(movie));

                if (forecast.ratio < 1) add('lag', -Math.min(20, (1 - forecast.ratio) * 25));

                // 3. Мусор
                if (info.cam) add('cam', -80);
                if (info.d3) add('d3', -50);
                if (info.serial && !tv) add('serial', -40);

                if (rel === 0) add('mismatch', -60);
                else if (rel < 0.5) add('year', -40);

                var score = 0;

                parts.forEach(function (p) { score += p.points; });

                return {
                    item: item, info: info, score: Math.round(score * 10) / 10, parts: parts, checks: checks,
                    playable: playable && !info.cam, relevance: rel, seeds: seeds, peers: peers, gb: gb,
                    need: need, est: est, forecast: forecast
                };
            }

            // ---------------------------------------------------------------- ранжирование

            function rank(results, wishes, movie) {
                var w = merge(DEFAULT_WISHES, wishes);
                var list = (results || []).map(function (item) { return evaluate(item, w, movie); });

                list.sort(function (a, b) {
                    if (b.score !== a.score) return b.score - a.score;

                    return b.seeds - a.seeds;
                });

                list.forEach(function (entry, i) { entry.place = i + 1; });

                return list;
            }

            // Лучшая раздача и объяснение, почему выбрана именно она
            function pick(results, wishes, movie) {
                var w = merge(DEFAULT_WISHES, wishes);
                var ranked = rank(results, w, movie);
                var playable = ranked.filter(function (e) { return e.playable && e.relevance > 0; });
                var best = playable[0] || null;

                return {
                    wishes: w,
                    ranked: ranked,
                    playable: playable,
                    best: best,
                    missed: best ? best.checks.filter(function (c) { return !c.ok && !c.better; }) : [],
                    stats: stats(ranked, playable)
                };
            }

            function stats(ranked, playable) {
                var out = { total: ranked.length, usable: playable.length, quality: {}, tracker: {}, hdr: 0, dv: 0, maxSeeds: 0 };

                playable.forEach(function (e) {
                    var q = QUALITY_LABEL[e.info.quality];
                    var tr = (e.item && e.item.Tracker) || '?';

                    out.quality[q] = (out.quality[q] || 0) + 1;
                    out.tracker[tr] = (out.tracker[tr] || 0) + 1;

                    if (e.info.hdr) out.hdr++;
                    if (e.info.dv) out.dv++;
                    if (e.seeds > out.maxSeeds) out.maxSeeds = e.seeds;
                });

                return out;
            }

            function formatSize(bytes) {
                var gb = bytes / 1e9;

                if (!bytes) return '';
                if (gb >= 1) return (gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)).replace('.', ',') + ' ГБ';

                return Math.round(bytes / 1e6) + ' МБ';
            }

            return {
                DEFAULT_WISHES: DEFAULT_WISHES,
                LANGS: LANGS,
                LADDER: LADDER,
                QUALITY_LABEL: QUALITY_LABEL,
                parse: parse,
                relevance: relevance,
                evaluate: evaluate,
                rank: rank,
                pick: pick,
                formatSize: formatSize,
                merge: merge
            };
        })();
    });

    run('series', function (LW) {
        'use strict';

        /*
         * Сериалы: следующая серия из той же раздачи.
         *
         * Плагин запоминает, какую раздачу человек выбрал для сериала и какую серию запустил. Когда серия
         * досмотрена (Лампа ведёт учёт просмотра, мы только читаем процент), главная кнопка на карточке
         * предлагает следующую серию из той же раздачи, без нового поиска и без выбора озвучки заново.
         * Рядом остаётся «Другая раздача».
         *
         * Здесь только данные и решения без интерфейса, чтобы это можно было проверить тестами.
         */
        LW.series = (function () {
            var STORE = 'lw_series';
            var MAX = 40;          // сколько сериалов помним, старые вытесняются
            var DONE_PERCENT = 90; // с какого процента просмотра серия считается досмотренной, как в самой Лампе

            function L() {
                return window.Lampa;
            }

            function readAll() {
                var all = null;

                try { all = L().Storage.get(STORE, ''); } catch (e) {}

                if (typeof all === 'string') {
                    try { all = JSON.parse(all); } catch (e2) { all = null; }
                }

                return all && typeof all === 'object' && !all.length ? all : {};
            }

            function writeAll(all) {
                var ids = Object.keys(all);

                if (ids.length > MAX) {
                    ids.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
                    ids.slice(0, ids.length - MAX).forEach(function (id) { delete all[id]; });
                }

                try { L().Storage.set(STORE, JSON.stringify(all)); } catch (e) {}
            }

            // Из записи парсера оставляем только простые поля: так её можно положить в хранилище и потом отдать Лампе как есть
            function slim(item) {
                var out = {};

                Object.keys(item || {}).forEach(function (k) {
                    var v = item[k];
                    var t = typeof v;

                    if (t === 'string' || t === 'number' || t === 'boolean') out[k] = v;
                });

                return out;
            }

            function key(movie) {
                return movie && movie.id ? String(movie.id) : '';
            }

            // Запомнить: сериал, сезон, серия и сама раздача
            function remember(movie, wishes, item) {
                var id = key(movie);

                if (!id || !item || !wishes || !(wishes.episode > 0)) return null;

                var all = readAll();
                var rec = { id: id, season: wishes.season || 0, episode: wishes.episode, at: new Date().getTime(), item: slim(item) };

                all[id] = rec;
                writeAll(all);

                return rec;
            }

            function get(movie) {
                var id = key(movie);
                var rec = id ? readAll()[id] : null;

                return rec && rec.item && rec.episode > 0 ? rec : null;
            }

            function forget(movie) {
                var id = key(movie);
                var all = readAll();

                if (id && all[id]) {
                    delete all[id];
                    writeAll(all);
                }
            }

            // Процент просмотра серии по учёту Лампы (0, если серию не смотрели или учёта нет)
            function watchedPercent(movie, season, episode) {
                try {
                    var T = L().Timeline;

                    if (T && T.watchedEpisode) return parseInt(T.watchedEpisode(movie, season || 1, episode), 10) || 0;
                } catch (e) {}

                return 0;
            }

            // Что предложить дальше. episodes: сколько серий в сезоне, если известно (0 — неизвестно).
            // { season, episode, resume } или null, если дальше предлагать нечего (сезон закончился).
            function step(rec, percent, episodes) {
                if (!rec || !(rec.episode > 0)) return null;

                if (percent < DONE_PERCENT) return { season: rec.season, episode: rec.episode, resume: true };

                var n = rec.episode + 1;

                if (episodes > 0 && n > episodes) return null;

                return { season: rec.season, episode: n, resume: false };
            }

            // Надпись на кнопке
            function label(s) {
                return 'Серия ' + s.episode + (s.resume ? ' · продолжить' : '') + ' · та же раздача';
            }

            return {
                DONE_PERCENT: DONE_PERCENT,
                slim: slim,
                remember: remember,
                get: get,
                forget: forget,
                watchedPercent: watchedPercent,
                step: step,
                label: label
            };
        })();
    });

    run('list', function (LW) {
        'use strict';

        /*
         * Список раздач: сортировка, фильтры и статистика. Только логика, без интерфейса.
         *
         * Работает с оценёнными раздачами из LW.score (entry: item, info, score, seeds, gb, forecast...).
         * Все функции возвращают новые массивы и ничего не меняют в исходных данных.
         */
        LW.list = (function () {
            // Порядок как в обычном списке Лампы, плюс «лучшие по пожеланиям» (по умолчанию)
            var SORTS = [
                ['best', 'Лучшие по пожеланиям'],
                ['seeds', 'По раздающим'],
                ['size', 'По размеру'],
                ['name', 'По названию'],
                ['tracker', 'По источнику'],
                ['date', 'По дате'],
                ['viewed', 'Просмотренные']
            ];

            // Фильтры: качество, HDR, Dolby Vision, субтитры, перевод, язык, сезон, трекер, год, 3D
            var FILTERS = ['quality', 'hdr', 'dv', 'subs', 'voice', 'lang', 'season', 'tracker', 'year', 'd3'];

            var KEY_LABEL = {
                quality: 'Качество', hdr: 'HDR', dv: 'Dolby Vision', subs: 'Субтитры', voice: 'Перевод',
                lang: 'Язык озвучки', season: 'Сезон', tracker: 'Трекер', year: 'Год', d3: '3D'
            };

            var QUALITY_NAME = { '2160': '4K', '1080': '1080p', '720': '720p', '480': 'SD', '0': 'Не указано' };

            var VOICE_NAME = { dub: 'Дубляж', mvo: 'Многоголосая / закадровая', none: 'Не указан' };

            var MAX_SEASONS = 60; // защита от раздач вроде «сезоны 1-999»

            // ---------------------------------------------------------------- значения для фильтров

            function yesNo(flag) {
                return flag ? 'yes' : 'no';
            }

            // Какие значения этот фильтр видит у раздачи. У раздачи их может быть несколько (языки, сезоны).
            function valuesOf(entry, key) {
                var i = entry.info || {};
                var out = [];
                var n;

                if (key === 'quality') return [String(i.quality || 0)];
                if (key === 'hdr') return [yesNo(i.hdr)];
                if (key === 'dv') return [yesNo(i.dv)];
                if (key === 'subs') return [yesNo(i.subs)];
                if (key === 'd3') return [yesNo(i.d3)];

                if (key === 'voice') {
                    if (i.dub) out.push('dub');
                    if (i.mvo) out.push('mvo');

                    return out.length ? out : ['none'];
                }

                if (key === 'lang') return i.langs && i.langs.length ? i.langs.slice() : ['?'];

                if (key === 'season') {
                    if (!i.seasons) return ['?'];

                    for (n = i.seasons.from; n <= i.seasons.to && out.length < MAX_SEASONS; n++) out.push(String(n));

                    return out.length ? out : ['?'];
                }

                if (key === 'tracker') return [(entry.item && entry.item.Tracker) || '?'];

                if (key === 'year') {
                    (i.years || []).forEach(function (y) {
                        if (out.indexOf(String(y)) < 0) out.push(String(y));
                    });

                    return out.length ? out : ['?'];
                }

                return [];
            }

            function valueLabel(key, value, langNames) {
                if (value === '?') return 'Не указано';

                if (key === 'quality') return QUALITY_NAME[value] || value;
                if (key === 'voice') return VOICE_NAME[value] || value;
                if (key === 'lang') return (langNames && langNames[value]) || value;
                if (key === 'season') return 'Сезон ' + value;
                if (key === 'hdr' || key === 'dv' || key === 'subs' || key === 'd3') return value === 'yes' ? 'Есть' : 'Нет';

                return value;
            }

            function compareValues(key, counts) {
                return function (a, b) {
                    if (a === '?' || b === '?') return a === '?' ? 1 : -1; // «не указано» всегда в конце

                    if (key === 'quality' || key === 'year') return parseInt(b, 10) - parseInt(a, 10);
                    if (key === 'season') return parseInt(a, 10) - parseInt(b, 10);
                    if (key === 'hdr' || key === 'dv' || key === 'subs' || key === 'd3') return a === 'yes' ? -1 : 1;

                    if (counts[b] !== counts[a]) return counts[b] - counts[a];

                    return a < b ? -1 : a > b ? 1 : 0;
                };
            }

            // Что можно выбрать в каждом фильтре и сколько раздач под каждое значение
            function facets(entries) {
                var out = {};

                FILTERS.forEach(function (key) {
                    var counts = {};

                    entries.forEach(function (e) {
                        valuesOf(e, key).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
                    });

                    out[key] = Object.keys(counts).sort(compareValues(key, counts)).map(function (v) {
                        return { value: v, count: counts[v] };
                    });
                });

                return out;
            }

            // ---------------------------------------------------------------- отбор и порядок

            // Мусор: камрипы, чужие фильмы и то, что парсер не смог разобрать. По умолчанию скрыт.
            function isJunk(entry) {
                return !(entry.playable && entry.relevance > 0);
            }

            function visible(entries, showJunk) {
                return showJunk ? entries.slice() : entries.filter(function (e) { return !isJunk(e); });
            }

            function filter(entries, filters) {
                var keys = Object.keys(filters || {}).filter(function (k) {
                    return filters[k] !== null && filters[k] !== undefined && filters[k] !== '';
                });

                if (!keys.length) return entries.slice();

                return entries.filter(function (e) {
                    return keys.every(function (k) { return valuesOf(e, k).indexOf(String(filters[k])) >= 0; });
                });
            }

            function activeCount(filters) {
                return Object.keys(filters || {}).filter(function (k) {
                    return filters[k] !== null && filters[k] !== undefined && filters[k] !== '';
                }).length;
            }

            function timeOf(entry) {
                var t = Date.parse(entry.item && entry.item.PublishDate);

                return isNaN(t) ? 0 : t;
            }

            function titleOf(entry) {
                return ((entry.item && entry.item.Title) || '').toLowerCase();
            }

            function trackerOf(entry) {
                return ((entry.item && entry.item.Tracker) || '~').toLowerCase();
            }

            function isViewed(entry) {
                return !!(entry.item && entry.item.viewed);
            }

            // Сравнение по месту в общем рейтинге: нужно, чтобы порядок не зависел от устойчивости sort() на старых ТВ
            function byPlace(a, b) {
                return (a.place || 0) - (b.place || 0);
            }

            function sort(entries, key) {
                var list = entries.slice();
                var cmp;

                if (key === 'seeds') cmp = function (a, b) { return b.seeds - a.seeds || b.score - a.score; };
                else if (key === 'size') cmp = function (a, b) { return b.gb - a.gb || b.score - a.score; };
                else if (key === 'name') cmp = function (a, b) { var x = titleOf(a), y = titleOf(b); return x < y ? -1 : x > y ? 1 : 0; };
                else if (key === 'tracker') cmp = function (a, b) { var x = trackerOf(a), y = trackerOf(b); return x < y ? -1 : x > y ? 1 : b.seeds - a.seeds; };
                else if (key === 'date') cmp = function (a, b) { return timeOf(b) - timeOf(a); };
                else if (key === 'viewed') cmp = function (a, b) { return (isViewed(b) ? 1 : 0) - (isViewed(a) ? 1 : 0); };
                else cmp = function (a, b) { return b.score - a.score || b.seeds - a.seeds; };

                list.sort(function (a, b) { return cmp(a, b) || byPlace(a, b); });

                return list;
            }

            function sortName(key) {
                var i;

                for (i = 0; i < SORTS.length; i++) {
                    if (SORTS[i][0] === key) return SORTS[i][1];
                }

                return SORTS[0][1];
            }

            // ---------------------------------------------------------------- дата

            function dateLabel(entry) {
                var t = timeOf(entry);

                if (!t) return '';

                var d = new Date(t);
                var dd = d.getDate();
                var mm = d.getMonth() + 1;

                return (dd < 10 ? '0' : '') + dd + '.' + (mm < 10 ? '0' : '') + mm + '.' + d.getFullYear();
            }

            // ---------------------------------------------------------------- статистика

            function median(nums) {
                if (!nums.length) return 0;

                var s = nums.slice().sort(function (a, b) { return a - b; });
                var m = Math.floor(s.length / 2);

                return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
            }

            // Сводка по набору раздач для шапки списка
            function summary(entries) {
                var out = {
                    count: entries.length, hdr: 0, dv: 0, dub: 0, mvo: 0, subs: 0, viewed: 0, smooth: 0,
                    maxSeeds: 0, medianSeeds: 0, minGb: 0, maxGb: 0, quality: [], trackers: [], langs: []
                };
                var q = {};
                var tr = {};
                var lg = {};
                var seeds = [];
                var sizes = [];

                entries.forEach(function (e) {
                    var i = e.info || {};
                    var tracker = (e.item && e.item.Tracker) || '?';

                    q[i.quality || 0] = (q[i.quality || 0] || 0) + 1;
                    tr[tracker] = (tr[tracker] || 0) + 1;

                    (i.langs || []).forEach(function (c) { lg[c] = (lg[c] || 0) + 1; });

                    if (i.hdr) out.hdr++;
                    if (i.dv) out.dv++;
                    if (i.dub) out.dub++;
                    if (i.mvo) out.mvo++;
                    if (i.subs) out.subs++;
                    if (isViewed(e)) out.viewed++;
                    if (e.forecast && (e.forecast.level === 'smooth' || e.forecast.level === 'edge')) out.smooth++;
                    if (e.seeds > out.maxSeeds) out.maxSeeds = e.seeds;

                    seeds.push(e.seeds || 0);
                    if (e.gb > 0) sizes.push(e.gb);
                });

                out.medianSeeds = median(seeds);

                if (sizes.length) {
                    out.minGb = Math.min.apply(null, sizes);
                    out.maxGb = Math.max.apply(null, sizes);
                }

                out.quality = Object.keys(q).map(function (k) { return { value: k, count: q[k] }; })
                    .sort(function (a, b) { return parseInt(b.value, 10) - parseInt(a.value, 10); });

                out.trackers = Object.keys(tr).map(function (k) { return { value: k, count: tr[k] }; })
                    .sort(function (a, b) { return b.count - a.count || (a.value < b.value ? -1 : 1); });

                out.langs = Object.keys(lg).map(function (k) { return { value: k, count: lg[k] }; })
                    .sort(function (a, b) { return b.count - a.count || (a.value < b.value ? -1 : 1); });

                return out;
            }

            return {
                SORTS: SORTS,
                FILTERS: FILTERS,
                KEY_LABEL: KEY_LABEL,
                QUALITY_NAME: QUALITY_NAME,
                valuesOf: valuesOf,
                valueLabel: valueLabel,
                facets: facets,
                isJunk: isJunk,
                visible: visible,
                filter: filter,
                activeCount: activeCount,
                sort: sort,
                sortName: sortName,
                dateLabel: dateLabel,
                summary: summary
            };
        })();
    });

    run('parser', function (LW) {
        'use strict';

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
    });

    run('tune', function (LW) {
        'use strict';

        /*
         * Автонастройка TorrServer. Читает его настройки, предлагает изменения, которые ускоряют старт
         * и дают больше источников, и записывает их. Перед записью сохраняет полную копию, чтобы откатить.
         *
         * Принципы: меняем только то, что сервер сам показал в настройках (разные версии TorrServer
         * отличаются набором полей), ничего не уменьшаем без причины и отправляем настройки целиком,
         * потому что TorrServer при записи заменяет их все, а не только присланные поля.
         *
         * Здесь логика и запросы. Окна: setup.js.
         */
        LW.tune = (function () {
            var STORE_BACKUP = 'lw_ts_backup';
            var STORE_LINE = 'lw_line_peak';
            var TRACKERS_URL = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt';
            var MB = 1048576;
            var START_SECONDS = 8;   // столько секунд предзагрузки на вашей скорости достаточно для ровного старта
            var START_MIN = 32 * MB;
            var START_MAX = 192 * MB;
            var DEFAULT_LINE = 40;   // Мбит/с, если скорость ещё не измеряли
            var CFG = window.lampa_watch_config || {}; // для тестов: сокращает ожидание
            var TIMEOUT = CFG.tuneMs || 6000;
            var VERIFY_DELAY = CFG.verifyDelay === undefined ? 1500 : CFG.verifyDelay;

            var RETRACKERS = { 0: 'не трогать', 1: 'добавлять открытые трекеры', 2: 'удалять трекеры раздачи', 3: 'заменять на свои' };

            function L() {
                return window.Lampa;
            }

            function has(obj, key) {
                return Object.prototype.hasOwnProperty.call(obj, key);
            }

            function num(v) {
                var n = parseFloat(v);

                return isNaN(n) ? 0 : n;
            }

            // ---------------------------------------------------------------- подписи

            function size(bytes) {
                if (bytes >= 1024 * MB) return (Math.round(bytes / (1024 * MB) * 10) / 10) + ' ГБ';

                return Math.round(bytes / MB) + ' МБ';
            }

            function onOff(v) {
                return v ? 'включено' : 'выключено';
            }

            function limitText(v) {
                return num(v) > 0 ? v + ' КБ/с' : 'без ограничений';
            }

            // ---------------------------------------------------------------- план

            // Скорость вашей сети в Мбит/с: лучшее, что мерил плагин при проверке раздач
            function lineMbps() {
                try { return num(L().Storage.get(STORE_LINE, 0)); } catch (e) { return 0; }
            }

            // По настройкам сервера строит план. ctx: { line } (Мбит/с, 0 если неизвестно).
            // Возвращает { changes: [{ key, label, from, to, why, fromText, toText }], notes: [], next }
            function plan(cur, ctx) {
                var next = JSON.parse(JSON.stringify(cur));
                var changes = [];
                var notes = [];
                var line = (ctx && ctx.line) || 0;

                function change(key, label, to, fromText, toText, why) {
                    changes.push({ key: key, label: label, from: next[key], to: to, fromText: fromText, toText: toText, why: why });
                    next[key] = to;
                }

                // встроенный поиск: запасной парсер без Jackett
                if (has(cur, 'EnableRutorSearch') && !cur.EnableRutorSearch) {
                    change('EnableRutorSearch', 'Встроенный поиск Rutor', true, onOff(false), onOff(true),
                        'Поиск прямо в TorrServer работает как запасной парсер, если Jackett недоступен.');
                }

                // трекеры: без них раздача берёт пиров только из DHT, старт дольше, скорость ниже
                if (has(cur, 'RetrackersMode') && (num(cur.RetrackersMode) === 0 || num(cur.RetrackersMode) === 2)) {
                    change('RetrackersMode', 'Трекеры в раздачах', 1, RETRACKERS[num(cur.RetrackersMode)], RETRACKERS[1],
                        num(cur.RetrackersMode) === 2
                            ? 'Сейчас трекеры из раздачи отбрасываются, остаётся только DHT: меньше источников и дольше старт.'
                            : 'К раздаче добавятся открытые трекеры: больше пиров, быстрее старт.');
                }

                if (has(cur, 'TrackersListURL') && !String(cur.TrackersListURL || '').replace(/\s+/g, '')) {
                    change('TrackersListURL', 'Список открытых трекеров', TRACKERS_URL, 'не задан', 'trackers_best.txt',
                        'TorrServer сам подтянет свежий список рабочих трекеров, а не только встроенный старый.');
                }

                [['DisableDHT', 'DHT', 'Без DHT пиры ищутся только через трекеры.'],
                 ['DisablePEX', 'PEX', 'PEX даёт пиров от уже подключённых раздающих.'],
                 ['DisableTCP', 'Соединения TCP', 'Без TCP часть раздающих недоступна.'],
                 ['DisableUTP', 'Соединения uTP', 'Без uTP часть раздающих недоступна.']].forEach(function (r) {
                    if (has(cur, r[0]) && cur[r[0]]) change(r[0], r[1], false, onOff(false), onOff(true), r[2]);
                });

                if (has(cur, 'DownloadRateLimit') && num(cur.DownloadRateLimit) > 0) {
                    change('DownloadRateLimit', 'Ограничение скорости загрузки', 0, limitText(cur.DownloadRateLimit), limitText(0),
                        'Лимит режет скорость и может быть причиной подвисаний.');
                }

                if (has(cur, 'ConnectionsLimit') && num(cur.ConnectionsLimit) > 0 && num(cur.ConnectionsLimit) < 50) {
                    change('ConnectionsLimit', 'Соединений на раздачу', 80, String(cur.ConnectionsLimit), '80',
                        'Мало соединений: на раздаче с большим числом пиров скорость упирается в лимит.');
                }

                if (has(cur, 'CacheSize') && num(cur.CacheSize) > 0 && num(cur.CacheSize) < 128 * MB) {
                    change('CacheSize', 'Размер кеша', 256 * MB, size(num(cur.CacheSize)), size(256 * MB),
                        'Маленький кеш не успевает копить запас для 4K и фильмов большого размера.');
                }

                if (has(cur, 'ReaderReadAHead') && num(cur.ReaderReadAHead) > 0 && num(cur.ReaderReadAHead) < 70) {
                    change('ReaderReadAHead', 'Упреждающее чтение', 95, cur.ReaderReadAHead + '%', '95%',
                        'Чем больше читаем вперёд, тем меньше шанс остановки при просадке скорости.');
                }

                // предзагрузка: доля кеша, которую надо набрать перед стартом. При большом кеше она бывает огромной.
                if (has(cur, 'PreloadCache') && num(next.CacheSize) > 0 && num(cur.PreloadCache) > 0) {
                    preload(cur, next, line, change);
                }

                if (has(cur, 'CacheSize') && !cur.UseDisk && num(next.CacheSize) > 2048 * MB) {
                    notes.push('Кеш ' + size(num(next.CacheSize)) + ' лежит в оперативной памяти компьютера с TorrServer. Если памяти мало, уменьшите его в настройках сервера.');
                }

                if (has(cur, 'DisableUPNP') && cur.DisableUPNP) {
                    notes.push('UPnP выключен: входящие соединения возможны только если порт открыт на роутере вручную.');
                }

                return { changes: changes, notes: notes, next: next, line: line };
            }

            function preload(cur, next, line, change) {
                var cache = num(next.CacheSize);
                var pct = num(cur.PreloadCache);
                var bytes = cache * pct / 100;
                var lineBytes = (line || DEFAULT_LINE) / 8 * MB;
                var target = Math.max(START_MIN, Math.min(START_MAX, lineBytes * START_SECONDS));
                var want;

                if (bytes > target * 1.5) {
                    want = Math.max(1, Math.round(target / cache * 100));
                    if (want >= pct) return;

                    change('PreloadCache', 'Предзагрузка перед стартом', want, pct + '% кеша ≈ ' + size(bytes), want + '% кеша ≈ ' + size(cache * want / 100),
                        'Перед стартом нужно набрать ' + size(bytes) + ', это долгое ожидание. ' + size(cache * want / 100) + ' хватает на ровный старт при вашей скорости.');
                } else if (bytes < START_MIN / 2 && cache >= START_MIN) {
                    want = Math.min(100, Math.ceil(START_MIN / cache * 100));
                    if (want <= pct) return;

                    change('PreloadCache', 'Предзагрузка перед стартом', want, pct + '% кеша ≈ ' + size(bytes), want + '% кеша ≈ ' + size(cache * want / 100),
                        'Предзагрузка слишком мала: запаса на старте не хватит, фильм может сразу подвиснуть.');
                }
            }

            // ---------------------------------------------------------------- запросы

            function baseUrl() {
                var u = '';

                try { u = L().Torserver && L().Torserver.url ? L().Torserver.url() : ''; } catch (e) {}

                if (!u && LW.parser) u = LW.parser.torrUrl();

                return String(u || '').replace(/\/+$/, '');
            }

            function request(body, text, done) {
                var u = baseUrl();
                var net;
                var finished = false;
                var timer;

                function finish(err, data) {
                    if (finished) return;

                    finished = true;
                    clearTimeout(timer);
                    done(err, data);
                }

                if (!u) return finish('Адрес TorrServer не задан в настройках Лампы');

                try {
                    net = new (L().Reguest)();
                    net.timeout(TIMEOUT);
                } catch (e) {
                    return finish('нет сетевого модуля');
                }

                timer = setTimeout(function () {
                    try { net.clear(); } catch (e) {}
                    finish('TorrServer не ответил');
                }, TIMEOUT + 1500);

                try {
                    net.silent(u + '/settings', function (json) { finish(null, json); }, function () { finish('TorrServer не ответил'); },
                        JSON.stringify(body), text ? { dataType: 'text' } : undefined);
                } catch (e) {
                    finish('' + e);
                }
            }

            // Читает настройки сервера: done(err, settings)
            function load(done) {
                request({ action: 'get' }, false, function (err, json) {
                    if (err) return done(err);
                    if (!json || typeof json !== 'object' || typeof json.CacheSize === 'undefined') return done('Это не TorrServer MatriX или версия слишком старая');

                    done(null, json);
                });
            }

            function store(key, value) {
                try { L().Storage.set(key, value); } catch (e) {}
            }

            function loadBackup() {
                try {
                    var b = L().Storage.get(STORE_BACKUP, '');

                    return b && typeof b === 'object' && b.settings ? b : null;
                } catch (e) {
                    return null;
                }
            }

            function hasBackup() {
                return !!loadBackup();
            }

            // Записывает настройки целиком и проверяет, что сервер их принял: done(err)
            function save(settings, keys, done) {
                request({ action: 'set', sets: settings }, true, function (err) {
                    if (err) return done(err);

                    // после записи TorrServer перезапускает торрент-клиент, поэтому проверяем не сразу
                    setTimeout(function () {
                        load(function (e2, got) {
                            var bad = [];

                            if (e2) return done('Настройки отправлены, но проверить их не удалось: ' + e2);

                            keys.forEach(function (k) {
                                if (JSON.stringify(got[k]) !== JSON.stringify(settings[k])) bad.push(k);
                            });

                            done(bad.length ? 'Сервер не принял: ' + bad.join(', ') : null);
                        });
                    }, VERIFY_DELAY);
                });
            }

            // Применяет план. Старые настройки сохраняются для отката. done(err)
            function apply(p, cur, done) {
                var keys = p.changes.map(function (c) { return c.key; });

                if (!keys.length) return done(null);

                store(STORE_BACKUP, { at: new Date().getTime(), url: baseUrl(), settings: cur, keys: keys });

                save(p.next, keys, done);
            }

            // Возвращает настройки сервера, какими они были до подбора. done(err)
            function rollback(done) {
                var b = loadBackup();

                if (!b) return done('Копии нет');

                save(b.settings, b.keys || [], function (err) {
                    if (!err) store(STORE_BACKUP, { at: 0, settings: null });

                    done(err);
                });
            }

            return {
                TRACKERS_URL: TRACKERS_URL,
                lineMbps: lineMbps,
                plan: plan,
                load: load,
                apply: apply,
                rollback: rollback,
                hasBackup: hasBackup,
                loadBackup: loadBackup,
                baseUrl: baseUrl,
                size: size
            };
        })();
    });

    run('failover', function (LW) {
        'use strict';

        /*
         * TorrServer Failover - плагин для Lampa
         *
         * Использует две ссылки на TorrServer, которые уже есть в настройках Лампы
         * (Настройки -> TorrServer -> «Основная ссылка» и «Дополнительная ссылка»).
         * Если основная не отвечает, плагин сам включает дополнительную.
         * Когда основная снова заработает, он возвращается на неё.
         *
         * Как это работает:
         *  - Лампа берёт адрес сервера из настройки torrserver_use_link («Использовать ссылку»).
         *    Плагин переключает именно её, поэтому остальной код Лампы ничего не замечает.
         *  - Сервер проверяется тем же запросом, которым проверяет его сама Лампа (POST /settings).
         *  - Проверка идёт при запуске, раз в минуту, при возврате в приложение,
         *    а также при ошибке подключения к серверу или загрузки «Моих торрентов».
         *  - В настройки TorrServer добавляется переключатель плагина и строка «Статус серверов».
         */
        (function () {
            'use strict';

            if (window.torrserver_failover_loaded) return;
            window.torrserver_failover_loaded = true;

            var PROBE_TIMEOUT = 4000;  // сколько ждём ответа от сервера при проверке, мс
            var CHECK_EVERY   = 60000; // как часто проверять в фоне, мс

            var generation = 0; // растёт при Torserver.clear(): отменяет ожидающие повторы запросов
            var pending    = {};
            var timer      = null;

            // ---------------------------------------------------------------- утилиты

            function tr(key) {
                return Lampa.Lang.translate(key);
            }

            function enabled() {
                return Lampa.Storage.field('torrserver_failover') !== false;
            }

            function normalize(url) {
                url = ((url || '') + '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');

                if (!url) return '';
                if (!/^https?:\/\//i.test(url)) url = (window.location.protocol === 'https:' ? 'https://' : 'http://') + url;

                return url;
            }

            // [основная, дополнительная]
            function links() {
                return [
                    normalize(Lampa.Storage.get('torrserver_url', '')),
                    normalize(Lampa.Storage.get('torrserver_url_two', ''))
                ];
            }

            // какая ссылка включена сейчас: 1 или 2 (так же, как читает Лампа)
            function current() {
                return Lampa.Storage.field('torrserver_use_link') === 'two' ? 2 : 1;
            }

            function playerOpened() {
                return !!(Lampa.Player && typeof Lampa.Player.opened === 'function' && Lampa.Player.opened());
            }

            function modalOpened() {
                try { return !!(window.$ && window.$('.modal').length); } catch (e) { return false; }
            }

            function authHeader() {
                if (!Lampa.Storage.field('torrserver_auth')) return null;

                try {
                    var raw = Lampa.Storage.get('torrserver_login', '') + ':' + Lampa.Storage.value('torrserver_password', '');

                    return 'Basic ' + btoa(unescape(encodeURIComponent(raw)));
                } catch (e) {
                    return null;
                }
            }

            // ------------------------------------------------------------ проверка сервера

            // callback(true), если сервер отвечает так, как нужно Лампе
            function probe(base, callback) {
                var finished = false;
                var guard    = null;
                var xhr      = new XMLHttpRequest();

                function end(ok) {
                    if (finished) return;

                    finished = true;
                    clearTimeout(guard);
                    callback(ok);
                }

                try {
                    var auth = authHeader();

                    xhr.open('POST', base + '/settings', true);
                    xhr.timeout = PROBE_TIMEOUT;

                    if (auth) xhr.setRequestHeader('Authorization', auth);

                    xhr.onload = function () {
                        var ok = false;

                        if (xhr.status === 200) {
                            try { ok = typeof JSON.parse(xhr.responseText).CacheSize !== 'undefined'; } catch (e) { ok = false; }
                        }

                        end(ok);
                    };
                    xhr.onerror = xhr.ontimeout = xhr.onabort = function () { end(false); };

                    // подстраховка для старых веб-вью, где нет xhr.timeout
                    guard = setTimeout(function () {
                        try { xhr.abort(); } catch (e) {}

                        end(false);
                    }, PROBE_TIMEOUT + 1000);

                    xhr.send(JSON.stringify({ action: 'get' }));
                } catch (e) {
                    end(false);
                }
            }

            // Находит первую рабочую ссылку (основная проверяется раньше дополнительной).
            // dead - номер ссылки, которая точно не работает: её не проверяем.
            // callback(1 | 2 | 0), 0 - не работает ни одна.
            function pick(dead, callback) {
                var key = dead || 0;

                if (pending[key]) return pending[key].push(callback);

                pending[key] = [callback];

                var urls  = links();
                var order = [1, 2].filter(function (n) { return n !== dead; });

                function finish(best) {
                    var list = pending[key];

                    delete pending[key];

                    list.forEach(function (fn) { fn(best); });
                }

                (function next(i) {
                    if (i >= order.length) return finish(0);

                    probe(urls[order[i] - 1], function (ok) {
                        if (ok) finish(order[i]);
                        else next(i + 1);
                    });
                })(0);
            }

            // ----------------------------------------------------------------- переключение

            function switchTo(n) {
                Lampa.Storage.set('torrserver_use_link', n === 2 ? 'two' : 'one');

                if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(tr(n === 2 ? 'tsfo_to_two' : 'tsfo_to_one'));
            }

            // В фоне не трогаем ссылку, пока играет плеер, а возвращаться на основную
            // начинаем только когда нет открытых окон (там может быть торрент, добавленный на запасной сервер).
            function allowed(best, background) {
                if (!background) return true;
                if (playerOpened()) return false;
                if (best === 1 && modalOpened()) return false;

                return true;
            }

            // opts: { dead: номер нерабочей ссылки, background: проверка в фоне }
            // callback(best, now): best - рабочая ссылка (0 - никакой), now - включённая после проверки
            function failover(opts, callback) {
                var urls = links();

                callback = callback || function () {};

                if (!enabled() || !urls[0] || !urls[1]) return callback(0, current());

                pick(opts.dead, function (best) {
                    if (best && best !== current() && allowed(best, opts.background)) switchTo(best);

                    callback(best, current());
                });
            }

            // -------------------------------------------------------- перехват Torserver

            function patch() {
                var T = Lampa.Torserver;

                if (!T || T.torrserver_failover) return;

                T.torrserver_failover = true;

                var connected = T.connected;
                var my        = T.my;
                var clear     = T.clear;

                // экран закрыли или запрос сбросили: повторять запрос уже не нужно
                T.clear = function () {
                    generation++;

                    return clear.apply(T, arguments);
                };

                // открытие торрента: сервер не ответил -> пробуем другую ссылку и повторяем
                T.connected = function (success, fail) {
                    var gen    = generation;
                    var active = current();

                    connected.call(T, success, function () {
                        var args = arguments;

                        failover({ dead: active }, function (best, now) {
                            if (gen !== generation) return;

                            if (now !== active) connected.call(T, success, fail);
                            else fail.apply(null, args);
                        });
                    });
                };

                // «Мои торренты»: ошибка (или пустой список) -> проверяем, жив ли сервер
                T.my = function (success, fail) {
                    var gen = generation;

                    my.call(T, success, function () {
                        var args   = arguments;
                        var active = current();

                        failover({}, function (best, now) {
                            if (gen !== generation) return;

                            if (now !== active) my.call(T, success, fail);
                            else fail.apply(null, args);
                        });
                    });
                };
            }

            // ------------------------------------------------------------ фоновые проверки

            function tick() {
                if (document.hidden || playerOpened()) return;

                failover({ background: true });
            }

            function startTimers() {
                if (timer) return;

                timer = setInterval(tick, CHECK_EVERY);

                document.addEventListener('visibilitychange', function () {
                    if (!document.hidden) tick();
                });

                // поменяли ссылки в настройках - сразу проверяем
                if (Lampa.Storage.listener && Lampa.Storage.listener.follow) {
                    Lampa.Storage.listener.follow('change', function (e) {
                        if (e.name === 'torrserver_url' || e.name === 'torrserver_url_two') setTimeout(function () { failover({}); }, 300);
                    });
                }

                setTimeout(tick, 1500);
            }

            // ------------------------------------------------------------------ настройки

            function addLang() {
                Lampa.Lang.add({
                    tsfo_name: {
                        ru: 'Автопереключение серверов',
                        uk: 'Автоперемикання серверів',
                        en: 'Server auto-switch'
                    },
                    tsfo_descr: {
                        ru: 'Если основная ссылка не отвечает, включится дополнительная. Когда основная заработает, плагин вернётся на неё.',
                        uk: 'Якщо основне посилання не відповідає, увімкнеться додаткове. Коли основне запрацює, плагін повернеться на нього.',
                        en: 'If the main link does not respond, the additional one is used. When the main one is back, it switches back.'
                    },
                    tsfo_status: {
                        ru: 'Статус серверов',
                        uk: 'Статус серверів',
                        en: 'Server status'
                    },
                    tsfo_checking: {
                        ru: 'Проверка…',
                        uk: 'Перевірка…',
                        en: 'Checking…'
                    },
                    tsfo_main: { ru: 'Основная', uk: 'Основне', en: 'Main' },
                    tsfo_extra: { ru: 'Дополнительная', uk: 'Додаткове', en: 'Additional' },
                    tsfo_up: { ru: 'работает', uk: 'працює', en: 'online' },
                    tsfo_down: { ru: 'не отвечает', uk: 'не відповідає', en: 'offline' },
                    tsfo_empty: { ru: 'не задана', uk: 'не задано', en: 'not set' },
                    tsfo_active: { ru: 'Сейчас', uk: 'Зараз', en: 'Active' },
                    tsfo_to_two: {
                        ru: 'TorrServer: основная ссылка не отвечает, включена дополнительная',
                        uk: 'TorrServer: основне посилання не відповідає, увімкнено додаткове',
                        en: 'TorrServer: main link is down, switched to the additional one'
                    },
                    tsfo_to_one: {
                        ru: 'TorrServer: основная ссылка снова работает, включена основная',
                        uk: 'TorrServer: основне посилання знову працює, увімкнено основне',
                        en: 'TorrServer: main link is back, switched to the main one'
                    }
                });
            }

            // строка «Статус серверов»: пишет в описание, какие ссылки отвечают
            function renderStatus(item) {
                var descr = item.find('.settings-param__descr');
                var urls  = links();
                var names = [tr('tsfo_main'), tr('tsfo_extra')];
                var out   = [tr('tsfo_empty'), tr('tsfo_empty')];
                var left  = 0;

                function show() {
                    descr.text(names[0] + ': ' + out[0] + '  ·  ' + names[1] + ': ' + out[1] + '  ·  ' + tr('tsfo_active') + ': ' + names[current() - 1].toLowerCase());
                }

                [0, 1].forEach(function (i) {
                    if (!urls[i]) return;

                    left++;

                    probe(urls[i], function (ok) {
                        out[i] = ok ? tr('tsfo_up') : tr('tsfo_down');

                        if (!--left) show();
                    });
                });

                if (!left) show();
            }

            function addSettings() {
                Lampa.SettingsApi.addParam({
                    component: 'server',
                    param: {
                        name: 'torrserver_failover',
                        type: 'trigger',
                        default: true
                    },
                    field: {
                        name: tr('tsfo_name'),
                        description: tr('tsfo_descr')
                    },
                    onChange: function () {
                        setTimeout(function () { failover({}); }, 100);
                    }
                });

                Lampa.SettingsApi.addParam({
                    component: 'server',
                    param: {
                        name: 'torrserver_failover_status',
                        type: 'static'
                    },
                    field: {
                        name: tr('tsfo_status'),
                        description: tr('tsfo_checking')
                    },
                    onRender: renderStatus
                });
            }

            // ---------------------------------------------------------------------- старт

            function start() {
                addLang();
                addSettings();
                patch();
                startTimers();
            }

            if (window.appready) start();
            else Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') start();
            });
        })();
    });

    run('hero', function (LW) {
        'use strict';

        /*
         * Герой главной: большой кадр сверху, под ним название, оценка и описание той карточки, на которой стоит фокус.
         * Ряды при этом уходят в нижнюю часть экрана и показываются «окном» (это делает theme.css по классу body.lw-home).
         *
         * Данные берём не из разметки, а из самой Лампы: когда фокус встаёт на карточку, Лампа вызывает
         * Utils.cardImgBackground(данные карточки), чтобы сменить фон. Мы оборачиваем эту функцию: она работает как раньше,
         * а мы заодно получаем название, описание, оценку и кадр. Ничего своего в данные не пишем.
         *
         * Тяжёлого тут нет: один кадр за раз, смена с задержкой (пока фокус бежит по ряду, ничего не грузится),
         * плавность только через opacity. Работает только когда включено новое оформление и открыта главная.
         */
        LW.hero = (function () {
            var api = { delay: 140 };
            var state = { on: false, bound: false, el: null, parts: null, key: '', url: '', layer: 0, t: null, syncT: null };

            function L() {
                return window.Lampa;
            }

            function make(tag, cls) {
                var e = document.createElement(tag);

                if (cls) e.className = cls;

                return e;
            }

            // Открыта ли сейчас главная (а не карточка, поиск, каталог)
            function isHome() {
                try {
                    var a = L().Activity.active();

                    return !!(a && a.component === 'main');
                } catch (e) {
                    return false;
                }
            }

            function build() {
                if (state.el && state.el.parentNode) return state.el;

                var slides = document.querySelector('.wrap__content .activitys');

                if (!slides) return null;

                var el = make('div', 'lw-hero');
                var a = make('div', 'lw-hero__img');
                var b = make('div', 'lw-hero__img');
                var text = make('div', 'lw-hero__text');
                var p = { kicker: make('div', 'lw-hero__kicker'), title: make('div', 'lw-hero__title'), meta: make('div', 'lw-hero__meta'), desc: make('div', 'lw-hero__desc'), imgs: [a, b] };

                text.appendChild(p.kicker);
                text.appendChild(p.title);
                text.appendChild(p.meta);
                text.appendChild(p.desc);
                el.appendChild(a);
                el.appendChild(b);
                el.appendChild(make('div', 'lw-hero__shade'));
                el.appendChild(text);
                slides.parentNode.insertBefore(el, slides);

                state.el = el;
                state.parts = p;
                state.key = '';

                return el;
            }

            // body.lw-home: главная открыта и герой включён. По нему тема сдвигает ряды вниз.
            function sync() {
                var home = state.on && isHome();

                document.body.classList.toggle('lw-home', home);

                if (home) build();
            }

            function later() {
                clearTimeout(state.syncT);
                state.syncT = setTimeout(sync, 60); // Лампа переключает активность чуть позже самого события
            }

            function kicker(d) {
                var tv = !!(d.first_air_date || d.name || d.media_type === 'tv');
                var year = String(d.release_date || d.first_air_date || '').slice(0, 4);

                return (tv ? 'Сериал' : 'Фильм') + (year ? ' · ' + year : '');
            }

            function imageUrl(path) {
                try {
                    if (L().TMDB && L().TMDB.image) return L().TMDB.image('t/p/w1280' + path);
                } catch (e) { /* возьмём прямой адрес */ }

                return 'https://image.tmdb.org/t/p/w1280' + path;
            }

            // Кадр меняем через два слоя и opacity: новый догружается, потом плавно проявляется поверх старого
            function image(path) {
                if (!path) return;

                var url = imageUrl(path);

                if (url === state.url) return;

                state.url = url;

                var im = new Image();

                im.onload = function () {
                    if (state.url !== url || !state.parts) return;

                    var imgs = state.parts.imgs;
                    var next = imgs[state.layer ? 0 : 1];

                    next.style.backgroundImage = 'url("' + url + '")';
                    next.classList.add('is-on');
                    imgs[state.layer].classList.remove('is-on');
                    state.layer = state.layer ? 0 : 1;
                };
                im.src = url;
            }

            function paint(d) {
                if (!state.on || !isHome() || !build()) return;

                var p = state.parts;

                p.kicker.textContent = kicker(d);
                p.title.textContent = d.title || d.name || '';
                p.desc.textContent = d.overview || '';
                p.meta.textContent = '';

                if (d.vote_average > 0) {
                    var chip = make('span', 'lw-hero__chip');

                    chip.textContent = '★ ' + Number(d.vote_average).toFixed(1);
                    p.meta.appendChild(chip);
                }

                image(d.backdrop_path);
            }

            function show(d) {
                if (!state.on || !d || typeof d !== 'object' || !(d.title || d.name)) return;
                if (!isHome()) {
                    if (document.body.classList.contains('lw-home')) sync();

                    return;
                }

                if (!document.body.classList.contains('lw-home')) sync();

                var key = String(d.id) + '|' + (d.backdrop_path || '');

                if (key === state.key) return;

                state.key = key;
                clearTimeout(state.t);
                state.t = setTimeout(function () { paint(d); }, api.delay);
            }

            // Оборачиваем функции Лампы, которыми она берёт кадр карточки для фона. Возвращают они то же самое.
            function wrap() {
                var U = L() && L().Utils;

                ['cardImgBackground', 'cardImgBackgroundBlur'].forEach(function (name) {
                    var orig = U && U[name];

                    if (typeof orig !== 'function' || orig.lwHero) return;

                    var fn = function (d) {
                        var r = orig.apply(this, arguments);

                        try { show(d); } catch (e) { /* герой не должен ломать фон Лампы */ }

                        return r;
                    };

                    fn.lwHero = true;
                    U[name] = fn;
                });
            }

            function bind() {
                if (state.bound) return;

                state.bound = true;

                try { L().Listener.follow('activity', later); } catch (e) { /* без событий синхронизируем при фокусе */ }
            }

            function on() {
                state.on = true;
                wrap();
                bind();
                sync();
            }

            function off() {
                state.on = false;
                clearTimeout(state.t);
                document.body.classList.remove('lw-home');

                if (state.el && state.el.parentNode) state.el.parentNode.removeChild(state.el);

                state.el = null;
                state.parts = null;
                state.key = '';
                state.url = '';
            }

            api.on = on;
            api.off = off;
            api.sync = sync;
            api.show = show;
            api.isHome = isHome;
            api.kicker = kicker;

            return api;
        })();
    });

    run('theme', function (LW) {
        'use strict';

        /*
         * Оформление: графитовый фон, светлая выбранная кнопка как в Apple TV, без blur и тяжёлых теней.
         *
         * Тема лежит поверх настоящей разметки Лампы и включается классом body.lw-theme.
         * Сам CSS живёт в src/theme.css и при сборке вшивается сюда строкой.
         * Выпускается как бета: по умолчанию выключено, включается в Настройки → Lampa Watch.
         *
         * Страховка: если Лампа с оформлением не дожила до 8 секунд три раза подряд,
         * оформление выключается само, и Лампа работает как раньше.
         *
         * Защита OLED: через N секунд без нажатий плитки приглушаются, через 10 с прячется верхняя строка.
         */
        LW.theme = (function () {
            var CSS = "body.lw-theme{--bg:#0e1218;--bg2:#151c26;--s1:#1b2430;--s2:#26313f;--paper:rgba(246,248,252,.95);--onpaper:#0b1220;--tint:rgba(70,120,255,.17);--edge:#eef2f8;--mid:#1d4fe0;--deep:#0a2478;--word:#7eaeff;--glow:rgba(255,255,255,.22);--soft:rgba(255,255,255,.13);--faint:rgba(255,255,255,.05);--ink:#f2f4f8;--dim:rgba(242,244,248,.66);--line:rgba(255,255,255,.1);--ok:#5fe39a;--warn:#ffd25a;--lag:#ff9d4d;--bad:#ff6b6b;background:var(--bg)!important;color:var(--ink)}body.lw-theme.lw-lime{--mid:#8bb300;--deep:#3b4d00;--word:#c5ec3c;--tint:rgba(165,210,0,.13)}body.lw-theme .background{display:none}body.lw-theme #app{background:radial-gradient(60% 55% at 86% 0%,var(--tint),transparent 70%),radial-gradient(44% 44% at 0% 100%,var(--tint),transparent 74%),var(--bg)}body.lw-theme .menu__item.focus,body.lw-theme .menu__item.traverse,body.lw-theme .menu__item.hover, body.lw-theme .head__action.focus,body.lw-theme .head__action.hover, body.lw-theme .items-line__more.focus, body.lw-theme .full-start__button.focus, body.lw-theme .simple-button.focus, body.lw-theme .selectbox-item.focus, body.lw-theme .settings-folder.focus, body.lw-theme .settings-param.focus, body.lw-theme .torrent-item.focus, body.lw-theme .modal__button.focus, body.lw-theme .player-panel .button.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.04) 70%);color:var(--ink);box-shadow:inset 0 0 0 1px var(--edge)}body.lw-theme .head{background:none}body.lw-theme .head__title{font-size:1.05em;font-weight:400;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}body.lw-theme .head__action,body.lw-theme .head__menu-icon,body.lw-theme .head__backward{border-radius:50%}body.lw-theme .head__action.focus svg,body.lw-theme .head__action.hover svg{color:var(--ink)}body.lw-theme .head__time-now{font-weight:300;letter-spacing:-.02em}body.lw-theme .wrap__left{background:linear-gradient(90deg,var(--bg) 72%,rgba(14,18,24,0))}body.lw-theme .menu__item{border-radius:1em;font-weight:300}body.lw-theme .menu__item.focus .menu__ico [stroke],body.lw-theme .menu__item.traverse .menu__ico [stroke],body.lw-theme .menu__item.hover .menu__ico [stroke]{stroke:var(--ink)}body.lw-theme .menu__item.focus .menu__ico path[fill],body.lw-theme .menu__item.focus .menu__ico rect[fill],body.lw-theme .menu__item.focus .menu__ico circle[fill],body.lw-theme .menu__item.traverse .menu__ico path[fill],body.lw-theme .menu__item.hover .menu__ico path[fill]{fill:var(--ink)}body.lw-theme .menu__item.focus .menu__ico>img,body.lw-theme .menu__item.traverse .menu__ico>img,body.lw-theme .menu__item.hover .menu__ico>img{filter:none}body.lw-theme .menu__split{background:var(--line)}body.lw-theme .scroll__body{counter-reset:lwrow}body.lw-theme .items-line__title{font-size:1.05em;font-weight:400;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}body.lw-theme .items-line__title::before{counter-increment:lwrow;content:counter(lwrow,decimal-leading-zero);margin-right:.8em;color:var(--word)}body.lw-theme .items-line__more{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}body.lw-theme .card__view{border-radius:1.1em}body.lw-theme .card__img{border-radius:1.1em}body.lw-theme .card__vote{background:rgba(0,0,0,.62);border-radius:2em;font-size:1.05em;font-weight:400}body.lw-theme .card__title{font-weight:300;color:var(--ink)}body.lw-theme .card__age{color:var(--dim)}body.lw-theme .card.focus .card__view::after,body.lw-theme .card.hover .card__view::after{border:1px solid var(--edge);border-radius:1.4em;top:-.35em;left:-.35em;right:-.35em;bottom:-.35em;box-shadow:0 0 1.4em var(--glow)}body.lw-theme .full-start__background{opacity:.38}body.lw-theme .full-start-new__title{font-weight:300;letter-spacing:-.035em}body.lw-theme .full-start-new__tagline,body.lw-theme .full-start-new__details{color:var(--dim)}body.lw-theme .full-start__button{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:2em}body.lw-theme .full-start__button.button--play{background:linear-gradient(120deg,var(--deep),var(--mid));border-color:rgba(255,255,255,.18)}body.lw-theme .full-start__button.focus{border-color:transparent}body.lw-theme .full-start__button.button--play.focus{background:linear-gradient(120deg,var(--deep),var(--mid));box-shadow:inset 0 0 0 1px var(--edge)}body.lw-theme .full-start__rate,body.lw-theme .full-start__status{border-radius:2em}body.lw-theme .full-descr__text{color:var(--dim);font-weight:300}body.lw-theme .full-descr__text.focus{background:none;box-shadow:inset 0 0 0 1px var(--line)}body.lw-theme .settings__layer{background:rgba(0,0,0,.6);-webkit-backdrop-filter:none;backdrop-filter:none}body.lw-theme .settings__content,body.lw-theme.glass--style .settings__content{background:linear-gradient(180deg,var(--faint),var(--bg2) 40%),var(--bg2)!important;-webkit-backdrop-filter:none;backdrop-filter:none;border-left:1px solid var(--line)}body.lw-theme .settings__title{font-weight:300;letter-spacing:-.02em}body.lw-theme .settings-folder,body.lw-theme .settings-param{border-radius:1em}body.lw-theme .settings-param__value{color:var(--word)}body.lw-theme .settings-param__descr{color:var(--dim)}body.lw-theme .selectbox__layer,body.lw-theme .modal{-webkit-backdrop-filter:none;backdrop-filter:none}body.lw-theme .selectbox__layer{background:rgba(0,0,0,.6)}body.lw-theme .modal{background:rgba(0,0,0,.72)}body.lw-theme .selectbox__content,body.lw-theme .modal__content,body.lw-theme.glass--style .selectbox__content,body.lw-theme.glass--style .modal__content{background:linear-gradient(155deg,var(--soft),var(--bg2) 55%),var(--bg2)!important;-webkit-backdrop-filter:none;backdrop-filter:none;border:1px solid rgba(255,255,255,.09);border-radius:1.4em}body.lw-theme .selectbox__title,body.lw-theme .modal__title{font-weight:300;letter-spacing:-.02em}body.lw-theme .selectbox-item{border-radius:1em}body.lw-theme .selectbox-item__subtitle{color:var(--dim)}body.lw-theme .torrent-item{border-radius:1.4em;background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.025) 60%);border:1px solid rgba(255,255,255,.09)}body.lw-theme .torrent-item.focus{border-color:var(--edge)}body.lw-theme .torrent-item__title{font-weight:300}body.lw-theme .torrent-item__seeds span{color:#5fe39a}body.lw-theme .simple-button{border-radius:2em;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12)}body.lw-theme .full-start-new__buttons .lw-watch-btn span,body.lw-theme .full-start-new__buttons .lw-next-btn span{display:inline}body.lw-theme .lw-watch-btn,body.lw-theme .lw-next-btn{background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.03));border-color:var(--edge);color:var(--ink)}body.lw-theme .lw-watch-btn svg,body.lw-theme .lw-next-btn svg{color:var(--word)}body.lw-theme .lw-watch-btn.focus,body.lw-theme .lw-next-btn.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.06));box-shadow:inset 0 0 0 .09em var(--edge)}body.lw-theme .lw-next-btn{background:linear-gradient(155deg,var(--mid),var(--deep))}body.lw-theme .lw-next-btn.focus{background:linear-gradient(155deg,var(--mid),var(--deep));box-shadow:inset 0 0 0 .09em var(--edge),0 0 0 .12em var(--glow)}body.lw-theme .modal__footer{flex-wrap:wrap;gap:.7em;padding-top:1.4em}body.lw-theme .modal__button{margin:0;padding:.85em 1.5em;border-radius:2em;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);font-weight:300;color:var(--ink)}body.lw-theme .modal__button+.modal__button{margin-left:0}body.lw-theme .modal__button:first-child{background:linear-gradient(120deg,var(--deep),var(--mid));border-color:rgba(255,255,255,.18)}body.lw-theme .modal__button.focus{border-color:transparent;box-shadow:inset 0 0 0 .09em var(--edge)}body.lw-theme .lw-box{padding:.2em .1em 0}body.lw-theme .lw-kicker{margin-bottom:.6em;font-size:.8em;letter-spacing:.24em;color:var(--word);opacity:1}body.lw-theme .lw-title{font-size:1.9em;font-weight:300;letter-spacing:-.03em;line-height:1.15;margin-bottom:.4em}body.lw-theme .lw-line{color:var(--dim);opacity:1}body.lw-theme .lw-h{margin:1.2em 0 .5em;font-size:.8em;letter-spacing:.22em;color:var(--word);opacity:1}body.lw-theme .lw-note{border:1px solid var(--line);border-radius:1em;background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.02));color:var(--dim)}body.lw-theme .lw-stats,body.lw-theme .lw-legend,body.lw-theme .lw-chips,body.lw-theme .lw-empty{color:var(--dim);opacity:1}body.lw-theme .lw-bar,body.lw-theme .lw-qrow__bar{height:.35em;border-radius:1em;background:rgba(255,255,255,.1)}body.lw-theme .lw-bar i,body.lw-theme .lw-qrow__bar i{border-radius:1em;background:linear-gradient(90deg,var(--mid),var(--edge))}body.lw-theme .lw-box--wishes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.6em;counter-reset:lwq}body.lw-theme .lw-row{display:block;margin:0;padding:.75em 1.1em .8em;border-radius:1.1em;background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.025) 70%);border:1px solid var(--line);color:var(--ink)}body.lw-theme .lw-row__name{font-size:.78em;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}body.lw-theme .lw-row__name::before{counter-increment:lwq;content:counter(lwq,decimal-leading-zero);margin-right:.8em;color:var(--word)}body.lw-theme .lw-row__val{margin:.2em 0 0;text-align:left;font-size:1.35em;font-weight:300;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}body.lw-theme .lw-row.focus,body.lw-theme .lw-tool.focus,body.lw-theme .lw-item.focus,body.lw-theme .lw-more.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.05) 70%);border-color:var(--edge);box-shadow:inset 0 0 0 .09em var(--edge);color:var(--ink)}body.lw-theme .lw-row.focus .lw-row__name{color:var(--word)}body.lw-theme .lw-badge{padding:.12em .75em;border:1px solid var(--line);border-radius:2em;background:none;color:var(--dim)}body.lw-theme .lw-badge--hot,body.lw-theme .lw-item.focus .lw-badge--hot{border-color:var(--edge);background:none;color:var(--edge)}body.lw-theme .lw-item.focus .lw-badge{background:none;color:var(--ink)}body.lw-theme .lw-verdict{padding:.8em 1.1em;border:1px solid;border-radius:1.1em;color:var(--dim)}body.lw-theme .lw-verdict b{font-size:1.15em;font-weight:400;color:var(--ink)}body.lw-theme .lw-verdict--smooth{background:rgba(95,227,154,.08);border-color:rgba(95,227,154,.45)}body.lw-theme .lw-verdict--smooth b{color:var(--ok)}body.lw-theme .lw-verdict--edge{background:rgba(255,210,90,.08);border-color:rgba(255,210,90,.45)}body.lw-theme .lw-verdict--edge b{color:var(--warn)}body.lw-theme .lw-verdict--lag{background:rgba(255,157,77,.09);border-color:rgba(255,157,77,.5)}body.lw-theme .lw-verdict--lag b{color:var(--lag)}body.lw-theme .lw-verdict--bad{background:rgba(255,107,107,.09);border-color:rgba(255,107,107,.5)}body.lw-theme .lw-verdict--bad b{color:var(--bad)}body.lw-theme .lw-checks{display:flex;flex-wrap:wrap;margin:.2em -.2em .4em}body.lw-theme .lw-check{margin:.2em;padding:.2em .85em;border:1px solid var(--line);border-radius:2em;font-size:.95em}body.lw-theme .lw-check--ok::before{color:var(--ok)}body.lw-theme .lw-check--miss::before{color:var(--bad)}body.lw-theme .lw-check--better::before{color:var(--warn)}body.lw-theme .lw-card{border:1px solid var(--line);border-radius:1.1em;background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.025))}body.lw-theme .lw-card b{font-weight:300;letter-spacing:-.03em}body.lw-theme .lw-card span,body.lw-theme .lw-qrow__name,body.lw-theme .lw-qrow__n{color:var(--dim);opacity:1}body.lw-theme .lw-tool,body.lw-theme .lw-more{border:1px solid rgba(255,255,255,.12);border-radius:2em;background:rgba(255,255,255,.07)}body.lw-theme .lw-tool b{font-weight:400;color:var(--word)}body.lw-theme .lw-item{border:1px solid var(--line);border-radius:1.1em;background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.025) 70%)}body.lw-theme .lw-item__title{font-weight:300}body.lw-theme .lw-item__side b{font-weight:400}body.lw-theme .lw-item__meta{color:var(--dim);opacity:1}body.lw-theme .lw-dot{display:flex;align-items:center;justify-content:center;width:1.7em;height:1.7em;font-size:.9em;font-weight:700;color:#000}body.lw-theme .lw-dot--smooth{background:var(--ok)}body.lw-theme .lw-dot--smooth::before{content:\"\\2713\"}body.lw-theme .lw-dot--edge{background:var(--warn)}body.lw-theme .lw-dot--edge::before{content:\"\\2248\"}body.lw-theme .lw-dot--lag{background:var(--lag)}body.lw-theme .lw-dot--lag::before{content:\"!\"}body.lw-theme .lw-dot--bad{background:var(--bad)}body.lw-theme .lw-dot--bad::before{content:\"\\2715\"}body.lw-theme .lw-prow,body.lw-theme .lw-tc{border:1px solid var(--line);border-radius:1em;background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.025) 70%)}body.lw-theme .lw-prow--best{border-color:var(--edge);box-shadow:inset 0 0 0 1px var(--edge)}body.lw-theme .lw-prow__tag{border:1px solid var(--edge);background:none;color:var(--edge)}body.lw-theme .lw-prow--run .lw-prow__dot{background:var(--warn)}body.lw-theme .lw-prow--ok .lw-prow__dot{background:var(--ok)}body.lw-theme .lw-prow--bad .lw-prow__dot{background:var(--bad)}body.lw-theme .lw-prow__info,body.lw-theme .lw-tc__why,body.lw-theme .lw-chg__k{color:var(--dim);opacity:1}body.lw-theme .lw-tc__name{font-weight:400}body.lw-theme .lw-chg{border-bottom-color:var(--line)}body.lw-theme .player-video__overlay{background:linear-gradient(180deg,rgba(0,0,0,.78),rgba(0,0,0,0) 28%,rgba(0,0,0,0) 50%,rgba(0,0,0,.94))}body.lw-theme .player-video__paused,body.lw-theme .player-video__loader{background-color:rgba(0,0,0,.45);border:1px solid var(--line)}body.lw-theme .player-info__title{font-size:2.6em;font-weight:300;letter-spacing:-.035em}body.lw-theme .player-info__name,body.lw-theme .player-info__values{color:var(--dim)}body.lw-theme .player-info__time span,body.lw-theme .player-panel__timenow,body.lw-theme .player-panel__timeend{font-weight:300;font-variant-numeric:tabular-nums}body.lw-theme .player-info__time-end{color:var(--dim)}body.lw-theme .player-info__values .value--name span{font-weight:300;color:var(--ink)}body.lw-theme .player-info__values .value--size span{border:1px solid var(--line);background:none;color:var(--ink)}body.lw-theme .player-info__values .value--pieces span.active{background-color:var(--edge)}body.lw-theme .player-info__values .value--pieces span.red{background-color:var(--bad)}body.lw-theme .player-info__values .value--pieces span.yellow{background-color:var(--warn)}body.lw-theme .player-info__values .value--pieces span.green{background-color:var(--ok)}body.lw-theme .player-panel__timeline{height:.3em;background-color:rgba(255,255,255,.14)}body.lw-theme .player-panel__peding{background-color:rgba(255,255,255,.3)}body.lw-theme .player-panel__position{background:linear-gradient(90deg,var(--mid),var(--edge))}body.lw-theme .player-panel__position>div:after{display:block;background-color:var(--edge);transform:translateY(-50%) translateX(50%) scale(.8)}body.lw-theme .player-panel__timeline.focus{box-shadow:0 0 0 .1em var(--edge)}body.lw-theme .player-panel__time{background:rgba(0,0,0,.75);border:1px solid var(--line);color:var(--ink)}body.lw-theme .player-panel__box-buttons{background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 1px var(--line)}body.lw-theme .player-panel .button.focus,body.lw-theme .player-skip.focus{box-shadow:inset 0 0 0 .09em var(--edge)}body.lw-theme .player-panel__playpause{background:linear-gradient(120deg,var(--deep),var(--mid));border:1px solid rgba(255,255,255,.18)}body.lw-theme .player-panel__playpause:not(.focus){background:linear-gradient(120deg,var(--deep),var(--mid))}body.lw-theme .player-panel__playpause.focus{background:linear-gradient(120deg,var(--deep),var(--mid))}body.lw-theme .player-panel__quality{font-weight:300}body.lw-theme .player-skip{background:rgba(0,0,0,.6);border:1px solid var(--line)}body.lw-theme .player-skip.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.05) 70%);color:var(--ink)}body.lw-theme .player-skip__progress-line{background-color:var(--edge)}body.lw-theme .player-footer-card__title{font-weight:300}body.lw-theme .normalization,body.lw-theme .player-video__paused,body.lw-theme .player-video__loader,body.lw-theme .player-video__noise-text,body.lw-theme .player-panel__time,body.lw-theme .player-skip,body.lw-theme .player-chat__body,body.lw-theme .player-panel__box-buttons,body.lw-theme .player-panel__playpause,body.lw-theme .player-info__values .value--size span,body.lw-theme .noty--style--glass,body.lw-theme .settings-input__content,body.lw-theme .settings-input--free,body.lw-theme .navigation-bar__body,body.lw-theme .discuss-rules,body.lw-theme .bell__item,body.lw-theme .media-loading__status,body.lw-theme .card .card__icons-inner,body.lw-theme .card .card__marker,body.lw-theme .card .card-watched,body.lw-theme .head__action{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}body.lw-theme .search .head-backward__title{font-size:1.05em;font-weight:400;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}body.lw-theme .search__input{font-weight:300;letter-spacing:-.03em;color:var(--ink)}body.lw-theme .search__input.filled::after,body.lw-theme .search-box .search__input.filled::after{border-right-color:var(--edge)}body.lw-theme .simple-keyboard{color:var(--ink)}body.lw-theme .simple-keyboard .hg-button{border-radius:.7em;background:rgba(255,255,255,.055);box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);font-weight:300}body.lw-theme .simple-keyboard .hg-button.hg-activeButton,body.lw-theme .simple-keyboard .hg-button.focus,body.lw-theme .simple-keyboard .hg-button:hover{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.06) 70%);box-shadow:inset 0 0 0 .09em var(--edge);color:var(--ink)}body.lw-theme .simple-keyboard-input{color:var(--ink)}body.lw-theme .search-history-key,body.lw-theme .search-source{border-radius:2em;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line)}body.lw-theme .search-history-key:before{opacity:.55}body.lw-theme .search-source{color:var(--dim)}body.lw-theme .search-source.active{background:linear-gradient(120deg,var(--deep),var(--mid));box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);color:var(--ink)}body.lw-theme .search-history-key.focus,body.lw-theme .search-source.focus,body.lw-theme .search-source.active.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.06) 70%);box-shadow:inset 0 0 0 .09em var(--edge);color:var(--ink)}body.lw-theme .search-source__count{background-color:rgba(0,0,0,.55);color:var(--ink)}body.lw-theme .search-looking__text,body.lw-theme .search-history-empty{color:var(--dim)}body.lw-theme .simple-keyboard-mic{box-shadow:inset 0 0 0 1px var(--line)}body.lw-theme .simple-keyboard-mic.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.06) 70%);box-shadow:inset 0 0 0 .09em var(--edge);color:var(--ink)}body.lw-theme .simple-keyboard-mic.record{background:rgba(255,107,107,.16);box-shadow:inset 0 0 0 .09em var(--bad);color:var(--bad)}body.lw-theme .simple-keyboard-buttons__enter,body.lw-theme .simple-keyboard-buttons__cancel{border-radius:2em;box-shadow:inset 0 0 0 1px var(--line)}body.lw-theme .simple-keyboard-buttons__enter{background:linear-gradient(120deg,var(--deep),var(--mid))}body.lw-theme .simple-keyboard-buttons__enter:hover,body.lw-theme .simple-keyboard-buttons__cancel:hover{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.06) 70%);box-shadow:inset 0 0 0 .09em var(--edge);color:var(--ink)}body.lw-theme .settings-input--free{background:radial-gradient(48% 46% at 92% 0%,var(--tint),transparent 72%),var(--bg)}body.lw-theme .settings-input__content,body.lw-theme.glass--style .settings-input__content{background:var(--bg2)!important;border-left:1px solid var(--line)}body.lw-theme .settings-input--free .settings-input__content,body.lw-theme.glass--style .settings-input--free .settings-input__content{background:none!important;border-left:0}body.lw-theme .settings-input__title{font-weight:300;letter-spacing:-.02em;color:var(--dim)}body.lw-theme .settings-input__input{font-weight:300;letter-spacing:-.03em;border-bottom-color:var(--line)}body.lw-theme .settings-input__input.filled::after{border-right-color:var(--edge)}body.lw-theme .settings-input__links{background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line)}body.lw-theme .settings-input__links.focus{background:linear-gradient(155deg,var(--soft),rgba(255,255,255,.06) 70%);box-shadow:inset 0 0 0 .09em var(--edge);color:var(--ink)}body.lw-theme .lw-dgc{border:1px solid var(--line);border-radius:1.1em;background:linear-gradient(155deg,var(--faint),rgba(255,255,255,.025))}body.lw-theme .lw-dgc[data-level=warn]{border-color:rgba(255,210,90,.4)}body.lw-theme .lw-dgc[data-level=bad]{border-color:rgba(255,107,107,.5)}body.lw-theme .lw-dgc__l{color:var(--dim);opacity:1;letter-spacing:.2em}body.lw-theme .lw-dgc__w{color:var(--ink);opacity:.8}body.lw-theme .lw-dgc__v{font-weight:300;letter-spacing:-.02em;color:var(--ink)}body.lw-theme .lw-dgc__s{color:var(--dim);opacity:1}body.lw-theme .lw-reserve{padding:.8em 1.1em;margin-bottom:.8em;border:1px solid rgba(255,157,77,.5);border-radius:1.1em;background:rgba(255,157,77,.09);color:var(--dim)}body.lw-theme .lw-reserve b{display:block;margin-bottom:.2em;font-size:1.15em;font-weight:400;color:var(--lag)}body.lw-theme .lw-big{font-size:7em;font-weight:200;letter-spacing:-.06em;line-height:1;margin:0 0 .15em;color:var(--ink)}body.lw-theme .lw-big small{font-size:.35em;letter-spacing:0;color:var(--word);opacity:1}body.lw-theme .lw-cards--three .lw-card{flex:1 1 0;min-width:0}body.lw-theme .lw-row,body.lw-theme .lw-item,body.lw-theme .lw-card,body.lw-theme .lw-prow,body.lw-theme .lw-tc,body.lw-theme .lw-dgc,body.lw-theme .torrent-item,body.lw-theme .lw-note{background:var(--s1);border-color:rgba(255,255,255,.07)}body.lw-theme .full-start__button,body.lw-theme .modal__button,body.lw-theme .simple-button,body.lw-theme .lw-watch-btn,body.lw-theme .lw-tool,body.lw-theme .lw-more{background:rgba(255,255,255,.12);border-color:transparent;color:var(--ink)}body.lw-theme .full-start__button.button--play,body.lw-theme .lw-next-btn,body.lw-theme .modal__button:first-child{background:linear-gradient(120deg,var(--deep),var(--mid));border-color:transparent}body.lw-theme .full-start__button,body.lw-theme .modal__button,body.lw-theme .simple-button,body.lw-theme .head__action,body.lw-theme .player-panel .button{transition:transform .18s}body.lw-theme .full-start__button.focus,body.lw-theme .full-start__button.button--play.focus,body.lw-theme .lw-watch-btn.focus,body.lw-theme .lw-next-btn.focus,body.lw-theme .modal__button.focus,body.lw-theme .modal__button:first-child.focus,body.lw-theme .simple-button.focus,body.lw-theme .head__action.focus,body.lw-theme .head__action.hover{background:var(--paper);color:var(--onpaper);box-shadow:none;border-color:transparent;transform:scale(1.05)}body.lw-theme .full-start__button.focus svg,body.lw-theme .lw-watch-btn.focus svg,body.lw-theme .lw-next-btn.focus svg,body.lw-theme .modal__button.focus svg,body.lw-theme .simple-button.focus svg,body.lw-theme .head__action.focus svg,body.lw-theme .head__action.hover svg{color:var(--onpaper)}body.lw-theme .card__view{transition:transform .2s}body.lw-theme .card.focus .card__view,body.lw-theme .card.hover .card__view{transform:scale(1.07)}body.lw-theme .card.focus .card__view::after,body.lw-theme .card.hover .card__view::after{border:.16em solid var(--edge);border-radius:1.3em;top:-.16em;left:-.16em;right:-.16em;bottom:-.16em;box-shadow:none}body.lw-theme .player-video__overlay{background:linear-gradient(180deg,rgba(0,0,0,.72),rgba(0,0,0,0) 26%,rgba(0,0,0,0) 52%,rgba(0,0,0,.9))}body.lw-theme .player-info__title{font-size:2.4em;font-weight:600;letter-spacing:-.03em}body.lw-theme .player-panel__timeline{height:.4em;border-radius:1em;background:rgba(255,255,255,.26)}body.lw-theme .player-panel__peding{background:rgba(255,255,255,.34);border-radius:1em}body.lw-theme .player-panel__position{background:var(--paper);border-radius:1em}body.lw-theme .player-panel__position>div:after{background-color:var(--paper);transform:translateY(-50%) translateX(50%) scale(0);transition:transform .18s}body.lw-theme .player-panel__timeline.focus{box-shadow:none;height:.62em}body.lw-theme .player-panel__timeline.focus .player-panel__position>div:after{transform:translateY(-50%) translateX(50%) scale(1.15)}body.lw-theme .player-panel__box-buttons{background:none;box-shadow:none}body.lw-theme .player-panel .button{background:rgba(255,255,255,.14);border-radius:50%}body.lw-theme .player-panel .button.focus,body.lw-theme .player-panel__playpause.focus{background:var(--paper);color:var(--onpaper);box-shadow:none;transform:scale(1.1)}body.lw-theme .player-panel .button.focus svg,body.lw-theme .player-panel__playpause.focus svg{color:var(--onpaper);fill:currentColor}body.lw-theme .player-panel__playpause,body.lw-theme .player-panel__playpause:not(.focus){background:var(--paper);color:var(--onpaper);border:0}body.lw-theme .player-panel__playpause svg{color:var(--onpaper)}body.lw-theme .player-skip.focus{background:var(--paper);color:var(--onpaper)}body.lw-theme .lw-hero{display:none}body.lw-theme.lw-home .lw-hero{display:block;position:absolute;left:0;top:0;right:0;height:60vh;overflow:hidden;pointer-events:none}body.lw-theme.lw-home .lw-hero__img{position:absolute;left:0;top:0;right:0;bottom:0;background-size:cover;background-position:72% 22%;opacity:0;transition:opacity .5s}body.lw-theme.lw-home .lw-hero__img.is-on{opacity:1}body.lw-theme.lw-home .lw-hero__shade{position:absolute;left:0;top:0;right:0;bottom:0;background:linear-gradient(90deg,var(--bg) 3%,rgba(14,18,24,.68) 38%,rgba(14,18,24,0) 76%),linear-gradient(0deg,var(--bg) 4%,rgba(14,18,24,.55) 22%,rgba(14,18,24,0) 52%),linear-gradient(180deg,rgba(14,18,24,.6),rgba(14,18,24,0) 24%)}body.lw-theme.lw-home .lw-hero__text{position:absolute;left:4.5%;bottom:10vh;width:46%}body.lw-theme.lw-home .lw-hero__kicker{margin-bottom:.8vw;font-size:.95vw;letter-spacing:.18em;text-transform:uppercase;color:var(--word)}body.lw-theme.lw-home .lw-hero__title{margin-bottom:.9vw;font-size:4.4vw;font-weight:300;letter-spacing:-.035em;line-height:1.04;color:var(--ink)}body.lw-theme.lw-home .lw-hero__meta{display:flex;margin-bottom:1vw}body.lw-theme.lw-home .lw-hero__chip{margin-right:.6vw;padding:.25vw .85vw;border-radius:2em;background:rgba(255,255,255,.15);font-size:1vw;color:var(--ink)}body.lw-theme.lw-home .lw-hero__desc{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:1.1vw;line-height:1.5;color:var(--dim)}body.lw-theme.lw-home .activitys{margin-top:44vh;height:48vh}body.lw-theme.lw-home .activity--active .items-line{font-size:.66em}body.lw-theme .lw-hero{transition:opacity .6s}body.lw-theme.lw-idle .lw-hero{opacity:.5}body.lw-theme .full-start-new__left{display:none}body.lw-theme .full-start-new__right{margin-left:0;width:54%}body.lw-theme .full-start__background{opacity:1}body.lw-theme .full-start-new::before{content:\"\";position:absolute;left:0;top:-148px;right:0;bottom:-300px;background:linear-gradient(90deg,var(--bg) 6%,rgba(14,18,24,.72) 38%,rgba(14,18,24,0) 72%),linear-gradient(0deg,var(--bg) 4%,rgba(14,18,24,0) 40%);pointer-events:none;z-index:0}body.lw-theme .full-start-new__body{position:relative;z-index:1}body.lw-theme .head,body.lw-theme .card,body.lw-theme .items-line{transition:opacity .6s}body.lw-theme.lw-idle .card:not(.focus),body.lw-theme.lw-idle .menu__item:not(.focus),body.lw-theme.lw-idle .items-line__title{opacity:.55}body.lw-theme.lw-idle10 .head{opacity:0}";

            var K = { on: 'lw_theme', accent: 'lw_theme_accent', idle: 'lw_theme_idle', fails: 'lw_theme_fails' };
            var STYLE_ID = 'lw-theme-css';
            var MAX_FAILS = 3;     // столько запусков подряд, не дожив до OK_AFTER, выключают оформление
            var OK_AFTER = 8;      // секунд: после этого запуск считается удачным
            var HIDE_BAR = 10;     // секунд до скрытия верхней строки

            var TXT = {
                title: 'Оформление',
                on: 'Новое оформление (бета)',
                onDescr: 'Тёмный графитовый вид в стиле Apple TV для всего приложения. По умолчанию выключено. Если Лампа три раза подряд не запустится с ним, оформление выключится само.',
                accent: 'Цвет акцента',
                blue: 'Синий',
                lime: 'Лайм',
                idle: 'Защита от выгорания',
                idle60: 'Через 60 секунд',
                idle30: 'Через 30 секунд',
                idleOff: 'Выключена',
                idleDescr: 'Когда долго нет нажатий, плитки приглушаются, а верхняя строка прячется.',
                autoOff: 'Новое оформление выключено: Лампа три раза подряд не запустилась с ним. Включить снова можно в настройках Lampa Watch.'
            };

            // Единица времени: 1000 мс. В тестах уменьшается, чтобы не ждать секунды.
            var api = { tick: 1000 };

            var state = { applied: false, bound: false, idleT: null, barT: null, okT: null, last: 0 };

            function store() {
                return window.Lampa && window.Lampa.Storage;
            }

            function read(key, def) {
                try {
                    var v = store().get(key, def);

                    return v === undefined || v === '' || v === null ? def : v;
                } catch (e) {
                    return def;
                }
            }

            function write(key, value) {
                try { store().set(key, value); } catch (e) { /* хранилище недоступно: живём без него */ }
            }

            function isOn() {
                var v = read(K.on, false);

                return v === true || v === 'true';
            }

            // '60s' → 60, '30s' → 30, 'off' и всё непонятное → 0 (защита выключена)
            function idleSeconds(value) {
                var n = parseInt(value, 10);

                return n > 0 ? n : 0;
            }

            function addStyle() {
                if (document.getElementById(STYLE_ID)) return;

                var el = document.createElement('style');

                el.id = STYLE_ID;
                el.textContent = CSS;
                (document.head || document.documentElement).appendChild(el);
            }

            function clearTimers() {
                clearTimeout(state.idleT);
                clearTimeout(state.barT);
                state.idleT = state.barT = null;
            }

            function schedule() {
                clearTimers();

                var sec = idleSeconds(read(K.idle, '60s'));

                if (!sec || !state.applied) return;

                arm('idleT', 'lw-idle', sec);
                arm('barT', 'lw-idle10', Math.min(HIDE_BAR, sec));
            }

            // Во время фильма приглушать нечего: приложение закрыто плеером, а пересчёт стилей сотен карточек под ним мог бы дать пропуск кадра.
            // Пока плеер открыт, таймер просто взводится заново. Признак плеера: его блок .player в документе (класса player--viewing Лампа не ставит).
            function arm(key, cls, sec) {
                state[key] = setTimeout(function () {
                    if (document.querySelector('.player')) return arm(key, cls, sec);

                    document.body.classList.add(cls);
                }, sec * api.tick);
            }

            function wake() {
                if (!state.applied) return;

                var cl = document.body.classList;
                var dim = cl.contains('lw-idle') || cl.contains('lw-idle10');
                var now = Date.now();

                // мышь шлёт события десятками в секунду: если ничего не приглушено, таймеры пересоздаём не чаще раза в 250 мс
                if (!dim && now - state.last < 250 * (api.tick / 1000)) return;

                state.last = now;

                if (dim) {
                    cl.remove('lw-idle');
                    cl.remove('lw-idle10');
                }

                schedule();
            }

            function bind() {
                if (state.bound) return;

                state.bound = true;

                ['keydown', 'mousemove', 'click', 'touchstart', 'wheel'].forEach(function (name) {
                    document.addEventListener(name, wake, true);
                });
            }

            function apply() {
                addStyle();
                state.applied = true;

                var cl = document.body.classList;

                cl.add('lw-theme');
                cl.toggle('lw-lime', read(K.accent, 'blue') === 'lime');
                bind();
                schedule();
                hero(true);
            }

            function remove() {
                state.applied = false;
                clearTimers();
                document.body.classList.remove('lw-theme', 'lw-lime', 'lw-idle', 'lw-idle10');
                hero(false);
            }

            // Герой главной живёт только вместе с оформлением
            function hero(on) {
                try {
                    if (LW.hero) LW.hero[on ? 'on' : 'off']();
                } catch (e) { /* без героя оформление работает */ }
            }

            // Привести вид в соответствие с настройками (после переключателя в Настройках)
            function refresh() {
                if (isOn()) apply();
                else remove();
            }

            function notify(text) {
                try {
                    if (window.Lampa && window.Lampa.Noty) window.Lampa.Noty.show(text);
                } catch (e) { /* уведомление не обязательно */ }
            }

            function start() {
                if (!isOn()) return;

                var fails = parseInt(read(K.fails, 0), 10) || 0;

                if (fails >= MAX_FAILS) {
                    write(K.on, false);
                    write(K.fails, 0);
                    notify(TXT.autoOff);

                    return;
                }

                write(K.fails, fails + 1);
                apply();

                // дожили до OK_AFTER: запуск удачный, счётчик сбоев обнуляем
                state.okT = setTimeout(function () { write(K.fails, 0); }, OK_AFTER * api.tick);
            }

            function addSettings(settingsApi) {
                var c = 'lampa_watch';

                settingsApi.addParam({ component: c, param: { name: 'lw_theme_title', type: 'title' }, field: { name: TXT.title } });

                settingsApi.addParam({
                    component: c,
                    param: { name: K.on, type: 'trigger', default: false },
                    field: { name: TXT.on, description: TXT.onDescr },
                    onChange: function () { setTimeout(refresh, 30); }
                });

                var accent = {};

                accent.blue = TXT.blue;
                accent.lime = TXT.lime;

                settingsApi.addParam({
                    component: c,
                    param: { name: K.accent, type: 'select', values: accent, default: 'blue' },
                    field: { name: TXT.accent },
                    onChange: function () { setTimeout(refresh, 30); }
                });

                var idle = {};

                idle['60s'] = TXT.idle60; // ключи не числами, иначе JS переставит их по возрастанию
                idle['30s'] = TXT.idle30;
                idle.off = TXT.idleOff;

                settingsApi.addParam({
                    component: c,
                    param: { name: K.idle, type: 'select', values: idle, default: '60s' },
                    field: { name: TXT.idle, description: TXT.idleDescr },
                    onChange: function () { setTimeout(schedule, 30); }
                });
            }

            function boot() {
                try {
                    start();
                } catch (e) {
                    if (window.console) console.log('[lampa-watch] оформление: ' + e);
                }
            }

            if (window.appready) boot();
            else window.Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') boot();
            });

            api.start = start;
            api.apply = apply;
            api.remove = remove;
            api.refresh = refresh;
            api.addSettings = addSettings;
            api.isOn = isOn;
            api.idleSeconds = idleSeconds;
            api.keys = K;
            api.MAX_FAILS = MAX_FAILS;
            api.TXT = TXT;

            return api;
        })();
    });

    run('watch', function (LW) {
        'use strict';

        /*
         * Кнопка «Лучшая раздача» на карточке фильма и сериала.
         *
         * Человек выбирает пожелания (качество, HDR, Dolby Vision, язык озвучки, субтитры, сезон),
         * плагин ищет раздачи через парсер самой Лампы, выбирает лучшую (LW.score), запускает её
         * через TorrServer и перед просмотром проверяет скорость (LW.speed): хватит ли её на плавное
         * воспроизведение. Если не хватает, объясняет, что поможет, и предлагает версию полегче.
         *
         * Все окна рассчитаны на пульт: фокус и OK, без мыши и клавиатуры.
         */
        if (window.lampa_watch_loaded) return;
        window.lampa_watch_loaded = true;

        var S = LW.score;
        var SP = LW.speed;
        var LL = LW.list;

        var STORE_WISHES = 'lw_wishes';
        var STORE_LINE = 'lw_line_peak';
        var STORE_SORT = 'lw_sort';
        var STORE_PREFETCH = 'lw_prefetch';
        var PAGE = 40; // сколько раздач показываем сразу, остальные по кнопке «Показать ещё»
        var CFG = window.lampa_watch_config || {}; // для тестов: сокращает паузы
        var PENDING_TTL = 110000; // дольше этого торрент не ждём: Лампа сама сдаётся через 90 секунд
        var MEASURE_MS = CFG.measureMs || 12000;
        var WARMUP_MS = CFG.warmup === undefined ? 3000 : CFG.warmup;
        var TICK_MS = CFG.interval || 1000;
        var SETTLE_MS = CFG.settle === undefined ? 150 : CFG.settle;
        var PREFETCH_DELAY = CFG.prefetchDelay === undefined ? 2000 : CFG.prefetchDelay; // даём карточке отрисоваться, потом ищем
        var PREFETCH_TTL = 10 * 60 * 1000;   // найденное заранее считаем свежим 10 минут
        var MISSING_MS = CFG.missingMs === undefined ? 3500 : CFG.missingMs; // через сколько говорим, что нужной серии в раздаче нет

        var pending = null;       // запуск, начатый нами: ждём список файлов и нажимаем нужный
        var cancelMeasure = null; // остановить идущий замер
        var runId = 0;            // номер поиска: поздний ответ отменённого поиска игнорируется
        var listModal = null;     // параметры открытого окна со списком: по ним его можно перерисовать на месте
        var found = {};           // что парсер вернул заранее: ключ «фильм|сезон|запрос» → { at, json }
        var inflight = {};        // поиски, которые идут прямо сейчас: ключ → ожидающие ответа

        // ---------------------------------------------------------------- тексты и варианты

        var TXT = {
            button: 'Лучшая раздача',
            wishesTitle: 'Что хотим смотреть',
            go: 'Найти и смотреть',
            showList: 'Все раздачи',
            standardList: 'Обычный список Лампы',
            refine: 'Уточнить поиск',
            refineTitle: 'Что искать',
            listKicker: 'Все раздачи',
            sortLabel: 'Сортировка',
            sortTitle: 'Сортировка',
            filters: 'Фильтры',
            filtersTitle: 'Фильтры',
            anyValue: 'Любое',
            junk: 'Камрипы и чужие фильмы',
            junkShown: 'Показаны',
            junkHidden: 'Скрыты',
            resetFilters: 'Сбросить фильтры',
            more: 'Показать ещё',
            emptyFilters: 'Под эти фильтры ничего нет. Сбросьте фильтры или поменяйте их.',
            emptyJunk: 'Подходящих раздач нет. В фильтрах можно показать камрипы и чужие фильмы.',
            legend: 'Цветная точка справа — прикидка по числу раздающих: зелёная пойдёт плавно, жёлтая на грани, оранжевая скорее будет лагать, красная не рекомендуется. Точнее покажет замер при запуске.',
            viewed: 'Смотрели',
            bestMark: 'Лучшая',
            searching: 'Ищу раздачи',
            searchingSub: 'Парсер собирает раздачи, потом я выберу лучшую',
            nothing: 'Ничего не нашлось',
            parserSub: 'Парсер не отвечает или не настроен. Кнопка ниже сама проверит доступные парсеры и подберёт рабочие, потом поиск повторится.',
            nothingSub: 'Парсер ничего не вернул или все раздачи не подошли. Попробуйте поменять пожелания или откройте обычный список.',
            parserError: 'Парсер не ответил',
            fixParser: 'Подобрать парсер',
            best: 'Лучшая раздача',
            chosen: 'Выбранная раздача',
            launch: 'Запустить',
            others: 'Другие раздачи',
            changeWishes: 'Пожелания',
            back: 'Назад',
            checking: 'Проверяю скорость',
            checkingSub: 'TorrServer качает начало файла, смотрю, хватит ли скорости',
            skip: 'Пропустить и запустить',
            anyway: 'Всё равно смотреть',
            watch: 'Смотреть',
            lighter: 'Взять версию полегче',
            lighterShort: 'Версия полегче',
            cancel: 'Отмена',
            otherRelease: 'Другая раздача',
            nextMissing: 'В этой раздаче нет серии ',
            foundAhead: 'Раздачи найдены заранее',
            reserveGo: 'Накопить запас и смотреть',
            now: 'Запустить сразу',
            reserveNeed: 'Нужен запас перед стартом',
            reserveKicker: 'Запас перед стартом',
            reserveTitle: 'Копим запас',
            reserveNow: 'Начать сейчас',
            reserveSaved: 'накоплено',
            reserveSpeed: 'скорость',
            reserveEta: 'до старта',
            reserveCapNote: 'Предел задаёт настройка предзагрузки TorrServer: больше он копить не станет.'
        };

        var OPTIONS = {
            quality: [['2160', '4K'], ['1080', '1080p'], ['720', '720p'], ['any', 'Любое']],
            hdr: [['any', 'Не важно'], ['yes', 'Нужен'], ['no', 'Не нужен']],
            dv: [['any', 'Не важно'], ['yes', 'Нужен'], ['no', 'Не нужен']],
            lang: [['any', 'Любой'], ['ru', 'Русский'], ['uk', 'Украинский'], ['en', 'Английский'], ['orig', 'Оригинал'], ['de', 'Немецкий'], ['fr', 'Французский'], ['es', 'Испанский'], ['it', 'Итальянский'], ['pl', 'Польский'], ['ja', 'Японский'], ['ko', 'Корейский']],
            voice: [['any', 'Любой'], ['dub', 'Дубляж'], ['mvo', 'Многоголосая']],
            subs: [['any', 'Не важно'], ['yes', 'Нужны']],
            seeds: [[1, '1'], [3, '3'], [5, '5'], [10, '10'], [20, '20']],
            instant: [[false, 'Показать выбор'], [true, 'Запускать сразу']]
        };

        var ROW_LABEL = {
            quality: 'Качество', hdr: 'HDR', dv: 'Dolby Vision', lang: 'Язык озвучки', voice: 'Тип озвучки',
            subs: 'Субтитры', seeds: 'Раздающих не меньше', season: 'Сезон', episode: 'Серия', instant: 'После поиска'
        };

        var LANG_NAME = {};

        OPTIONS.lang.forEach(function (o) { LANG_NAME[o[0]] = o[1]; });

        var CHECK_NAME = {
            quality: function (c) { return 'Качество ' + c.wanted; },
            hdr: function (c) { return c.wanted; },
            dv: function (c) { return c.wanted; },
            lang: function (c) { return 'Озвучка: ' + (LANG_NAME[c.wanted] || c.wanted).toLowerCase(); },
            voice: function (c) { return c.wanted === 'dub' ? 'Дубляж' : 'Многоголосая озвучка'; },
            subs: function () { return 'Субтитры'; },
            season: function (c) { return 'Сезон ' + c.wanted; }
        };

        var VERDICT = {
            smooth: { cls: 'smooth', head: 'Пойдёт плавно', mark: '✓' },
            edge: { cls: 'edge', head: 'На грани: возможны подвисания', mark: '≈' },
            lag: { cls: 'lag', head: 'Скорее всего будет лагать', mark: '!' },
            bad: { cls: 'bad', head: 'Не рекомендую: будет лагать', mark: '✕' },
            unknown: { cls: 'edge', head: 'Скорость измерить не удалось', mark: '?' }
        };

        var TIPS = {
            fewSeeds: function () { return 'Мало раздающих: скорость нестабильна. Подождите пару минут или возьмите раздачу, где раздающих больше.'; },
            fewPeers: function () { return 'К раздаче подключилось мало узлов. Проверьте, что в настройках TorrServer включены DHT и обмен узлами (PEX).'; },
            lighter: function () { return 'Возьмите версию полегче, например 1080p вместо 4K: она потянет вашу скорость.'; },
            wait: function (v) { return 'Если запустить и подождать около ' + v.waitMin + ' мин, запас накопится и дальше пойдёт без пауз.'; },
            cache: function () { return 'Увеличьте кэш TorrServer (в его настройках «Размер кэша» 512 МБ и больше): запас буфера сгладит провалы скорости.'; },
            wired: function () { return 'Для такого тяжёлого файла нужна быстрая сеть: проводное подключение или Wi-Fi 5 ГГц и на телевизоре, и на компьютере с TorrServer.'; },
            otherDownloads: function () { return 'Закройте другие загрузки и VPN на компьютере с TorrServer: они забирают скорость.'; },
            reserveCap: function (v, rs) { return 'TorrServer копит запас только до ' + S.formatSize(rs.cap) + ', а нужно около ' + S.formatSize(rs.r.bytes) + '. Увеличьте кеш и предзагрузку в настройках TorrServer (кнопка «Настроить TorrServer»).'; }
        };

        // ---------------------------------------------------------------- вспомогательное

        function L() {
            return window.Lampa;
        }

        function log(msg) {
            try { if (window.console) console.log('[lampa-watch] ' + msg); } catch (e) {}

            // log зовут только при сбоях: они же попадают в «Диагностику»
            if (LW.health) LW.health.note('watch', msg);
        }

        function noty(text) {
            try { L().Noty.show(text); } catch (e) {}
        }

        function shortText(s, n) {
            s = (s || '') + '';

            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        }

        function optionLabel(key, value) {
            var list = OPTIONS[key] || [];
            var i;

            for (i = 0; i < list.length; i++) {
                if (list[i][0] === value) return list[i][1];
            }

            return String(value);
        }

        function loadWishes() {
            var saved = null;

            try { saved = L().Storage.get(STORE_WISHES, ''); } catch (e) {}

            if (typeof saved === 'string') {
                try { saved = JSON.parse(saved); } catch (e2) { saved = null; }
            }

            var w = S.merge(S.DEFAULT_WISHES, saved || {});

            w.season = 0;
            w.episode = 0;

            try { w.line = parseFloat(L().Storage.get(STORE_LINE, 0)) || 0; } catch (e3) { w.line = 0; }

            return w;
        }

        function saveWishes(w) {
            var copy = S.merge(w, {});

            delete copy.season;
            delete copy.episode;
            delete copy.line;

            try { L().Storage.set(STORE_WISHES, JSON.stringify(copy)); } catch (e) {}
        }

        function seasonList(movie) {
            var out = [];

            (movie.seasons || []).forEach(function (s) {
                if (s && s.season_number > 0) out.push({ n: s.season_number, episodes: s.episode_count || 0 });
            });

            if (!out.length && movie.number_of_seasons) {
                var i;

                for (i = 1; i <= movie.number_of_seasons; i++) out.push({ n: i, episodes: 0 });
            }

            return out;
        }

        function searchText(movie, season) {
            var Storage = L().Storage;
            var year = ((movie.first_air_date || movie.release_date || '0000') + '').slice(0, 4);
            var combos = {
                df: movie.original_title || movie.original_name,
                df_year: (movie.original_title || movie.original_name) + ' ' + year,
                df_lg: (movie.original_title || movie.original_name) + ' ' + (movie.title || movie.name),
                df_lg_year: (movie.original_title || movie.original_name) + ' ' + (movie.title || movie.name) + ' ' + year,
                lg: movie.title || movie.name,
                lg_year: (movie.title || movie.name) + ' ' + year,
                lg_df: (movie.title || movie.name) + ' ' + (movie.original_title || movie.original_name),
                lg_df_year: (movie.title || movie.name) + ' ' + (movie.original_title || movie.original_name) + ' ' + year
            };
            var suffix = season > 0 ? ' S' + (season < 10 ? '0' : '') + season : '';
            var base = combos[Storage.field('parse_lang')] || movie.original_title || movie.original_name || movie.title || movie.name;

            return {
                search: base + suffix,
                search_one: (movie.title || movie.name) + suffix,
                search_two: (movie.original_title || movie.original_name || '') + suffix
            };
        }

        function searchObject(movie, season, query) {
            var s = searchText(movie, season);

            if (query) s = { search: query, search_one: query, search_two: query };

            return { url: '', title: L().Lang.translate('title_torrents'), component: 'torrents', search: s.search, search_one: s.search_one, search_two: s.search_two, movie: movie, page: 1 };
        }

        function openStandardList(movie, season) {
            try { L().Modal.close(); } catch (e) {}

            L().Activity.push(searchObject(movie, season));
        }

        function closeModal() {
            try { L().Modal.close(); } catch (e) {}
        }

        function backToContent() {
            try { L().Controller.toggle('content'); } catch (e) {}
        }

        // ---------------------------------------------------------------- оформление

        function addStyle() {
            if (document.getElementById('lw-style')) return;

            var css = [
                '.lw-watch-btn svg{width:1.6em;height:1.6em}',
                '.lw-box{padding:.4em .2em 0}',
                '.lw-kicker{font-size:.85em;letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin-bottom:.5em}',
                '.lw-title{font-size:1.35em;font-weight:600;line-height:1.3;margin-bottom:.7em;word-break:break-word}',
                '.lw-row{display:flex;justify-content:space-between;align-items:center;padding:.8em 1.1em;margin-bottom:.35em;border-radius:.6em;background:rgba(255,255,255,.07);font-size:1.1em}',
                '.lw-row.focus{background:#fff;color:#000}',
                '.lw-row__val{font-weight:600;margin-left:1.2em;text-align:right}',
                '.lw-badges{margin-bottom:.6em}',
                '.lw-badge{display:inline-block;padding:.25em .65em;margin:0 .4em .4em 0;border-radius:.4em;background:rgba(255,255,255,.13);font-size:.95em}',
                '.lw-badge--hot{background:#2f6fe4}',
                '.lw-line{opacity:.75;margin-bottom:.8em}',
                '.lw-verdict{padding:.7em 1em;border-radius:.6em;margin-bottom:.8em;font-size:1.05em;border-left:.3em solid}',
                '.lw-verdict b{display:block;margin-bottom:.2em;font-size:1.1em}',
                '.lw-verdict--smooth{background:rgba(111,207,151,.14);border-color:#6fcf97}',
                '.lw-verdict--edge{background:rgba(242,201,76,.14);border-color:#f2c94c}',
                '.lw-verdict--lag{background:rgba(242,153,74,.16);border-color:#f2994a}',
                '.lw-verdict--bad{background:rgba(235,87,87,.16);border-color:#eb5757}',
                '.lw-check{margin:.15em 0}',
                '.lw-check::before{display:inline-block;width:1.4em;font-weight:700}',
                '.lw-check--ok::before{content:"✓";color:#6fcf97}',
                '.lw-check--miss::before{content:"✕";color:#eb5757}',
                '.lw-check--better::before{content:"↑";color:#f2c94c}',
                '.lw-note{margin:.7em 0;padding:.6em .9em;border-radius:.5em;background:rgba(255,255,255,.07)}',
                '.lw-tips{margin:.6em 0 0;padding-left:1.2em}',
                '.lw-tips li{margin:.4em 0;line-height:1.35}',
                '.lw-stats{opacity:.6;font-size:.9em;margin-top:.8em;line-height:1.5}',
                '.lw-reserve{padding:.7em 1em;border-radius:.6em;margin-bottom:.8em;border-left:.3em solid #f2994a;background:rgba(242,153,74,.16)}',
                '.lw-reserve b{display:block;margin-bottom:.2em;font-size:1.1em}',
                '.lw-big{font-size:5em;font-weight:200;line-height:1;margin:.05em 0 .15em}',
                '.lw-big small{font-size:.4em;margin-left:.1em;opacity:.6}',
                '.lw-cards--three .lw-card{flex:1 1 0;min-width:0}',
                '.lw-bar{height:.5em;border-radius:.25em;background:rgba(255,255,255,.12);overflow:hidden;margin:.9em 0}',
                '.lw-bar i{display:block;height:100%;width:0;background:#2f6fe4;transition:width .4s}',
                '.lw-live{font-size:1.1em;line-height:1.6}',
                '.lw-cards{display:flex;flex-wrap:wrap;margin:.2em -.3em .5em}',
                '.lw-card{flex:1 1 9em;margin:.3em;padding:.6em .9em;border-radius:.6em;background:rgba(255,255,255,.07)}',
                '.lw-card b{display:block;font-size:1.7em;line-height:1.15;font-weight:600}',
                '.lw-card span{opacity:.6;font-size:.85em}',
                '.lw-qrow{display:flex;align-items:center;margin:.25em 0;font-size:.95em}',
                '.lw-qrow__name{width:4.6em;opacity:.75}',
                '.lw-qrow__bar{flex:1;height:.55em;border-radius:.3em;background:rgba(255,255,255,.1);overflow:hidden;margin:0 .8em}',
                '.lw-qrow__bar i{display:block;height:100%;background:#2f6fe4}',
                '.lw-qrow__n{width:2.4em;text-align:right;opacity:.75}',
                '.lw-chips{margin:.5em 0 0;opacity:.85}',
                '.lw-tools{display:flex;flex-wrap:wrap;margin:.6em -.25em .5em}',
                '.lw-tool{margin:.25em;padding:.55em 1em;border-radius:.6em;background:rgba(255,255,255,.1)}',
                '.lw-tool b{font-weight:600}',
                '.lw-tool.focus{background:#fff;color:#000}',
                '.lw-item{display:flex;align-items:center;padding:.7em 1em;margin-bottom:.35em;border-radius:.6em;background:rgba(255,255,255,.07)}',
                '.lw-item.focus,.lw-more.focus{background:#fff;color:#000}',
                '.lw-item__main{flex:1;min-width:0}',
                '.lw-item__title{font-size:1.05em;line-height:1.3;word-break:break-word;margin-bottom:.4em}',
                '.lw-item__side{margin-left:1.1em;text-align:right;white-space:nowrap;line-height:1.35}',
                '.lw-item__side b{font-size:1.1em}',
                '.lw-item__meta{opacity:.65;font-size:.85em}',
                '.lw-item .lw-badge{margin-bottom:0;font-size:.85em}',
                '.lw-item.focus .lw-badge{background:rgba(0,0,0,.12)}',
                '.lw-item.focus .lw-badge--hot{background:#2f6fe4;color:#fff}',
                '.lw-dot{flex:none;width:.8em;height:.8em;margin-left:1em;border-radius:50%}',
                '.lw-dot--smooth{background:#6fcf97}',
                '.lw-dot--edge{background:#f2c94c}',
                '.lw-dot--lag{background:#f2994a}',
                '.lw-dot--bad{background:#eb5757}',
                '.lw-more{padding:.8em 1em;margin-bottom:.35em;border-radius:.6em;background:rgba(255,255,255,.07);text-align:center}',
                '.lw-empty{padding:1.2em .4em;opacity:.7}',
                '.lw-legend{margin-top:.8em;opacity:.5;font-size:.85em;line-height:1.4}',
                // окно ввода Лампы по умолчанию лежит ниже окон (слой 21 против 50), и клавиатуры из «Уточнить поиск» было бы не видно
                '.settings-input{z-index:60}'
            ].join('\n');

            var el = document.createElement('style');

            el.id = 'lw-style';
            el.appendChild(document.createTextNode(css));
            document.head.appendChild(el);
        }

        function h(tag, cls, text) {
            var el = $('<' + tag + '></' + tag + '>');

            if (cls) el.addClass(cls);
            if (text !== undefined) el.text(text);

            return el;
        }

        function openModal(params) {
            params.mask = true;
            params.size = params.size || 'medium';

            L().Modal.open(params);
        }

        // ---------------------------------------------------------------- описание раздачи

        function badgesOf(entry) {
            var i = entry.info;
            var out = [];

            out.push({ t: S.QUALITY_LABEL[i.quality], hot: i.quality === 2160 });

            if (i.dv) out.push({ t: 'Dolby Vision', hot: true });
            if (i.hdr) out.push({ t: 'HDR', hot: true });
            if (i.codec) out.push({ t: i.codec.toUpperCase() });

            if (i.source) out.push({ t: { remux: 'Remux', bluray: 'BluRay', webdl: 'WEB-DL', webrip: 'WEBRip', hdtv: 'HDTV', hdrip: 'HDRip' }[i.source] });

            if (i.dub) out.push({ t: 'Дубляж' });
            else if (i.mvo) out.push({ t: 'Многоголосая' });

            i.langs.forEach(function (c) { out.push({ t: (LANG_NAME[c] || c) }); });

            if (i.subs) out.push({ t: 'Субтитры' });
            if (i.atmos) out.push({ t: 'Atmos / TrueHD' });

            return out;
        }

        function briefOf(entry) {
            var b = badgesOf(entry).slice(0, 3).map(function (x) { return x.t; });

            return b.join(' · ') + ' · ' + (S.formatSize(entry.item.Size) || '?') + ' · ↑' + entry.seeds;
        }

        function forecastBlock(entry) {
            var f = entry.forecast;
            var v = VERDICT[f.level] || VERDICT.unknown;
            var box = h('div', 'lw-verdict lw-verdict--' + v.cls);

            box.append(h('b', '', v.mark + ' Прикидка: ' + v.head.toLowerCase()));
            box.append(h('div', '', 'Фильму нужно около ' + entry.need + ' Мбит/с, раздача по числу раздающих даст порядка ' + entry.est + '. Точнее покажет замер при запуске.'));

            return box;
        }

        // Тяжёлая раздача: прикидка говорит, что скорости не хватит, но запас перед стартом это решает
        function reserveFor(entry, movie) {
            var r = SP.reserve(entry.est, entry.need, SP.runtimeMin(movie));

            return r.needed && r.feasible ? r : null;
        }

        function reserveBlock(r) {
            var box = h('div', 'lw-reserve');

            box.append(h('b', '', TXT.reserveNeed));
            box.append(h('div', '', 'Без запаса будет лагать. Если накопить около ' + S.formatSize(r.bytes) + ' (≈ ' + r.waitMin + ' мин), досмотрите до конца без пауз.'));

            return box;
        }

        function checksBlock(entry, picked) {
            var box = h('div', 'lw-checks');
            var shown = 0;

            entry.checks.forEach(function (c) {
                if (!CHECK_NAME[c.key] || !c.wanted) return;

                var text = CHECK_NAME[c.key](c);
                var cls = c.ok ? 'ok' : c.better ? 'better' : 'miss';

                if (!c.ok && c.got && c.key === 'quality') text += (c.better ? ' (есть ' + c.got + ', выше)' : ' (нашлось ' + c.got + ')');
                else if (!c.ok && c.key !== 'quality') text += ' (нет)';

                box.append(h('div', 'lw-check lw-check--' + cls, text));
                shown++;
            });

            return shown ? box : $();
        }

        function statsLine(stats) {
            var q = Object.keys(stats.quality).map(function (k) { return k + ': ' + stats.quality[k]; }).join(' · ');
            var tr = Object.keys(stats.tracker).sort(function (a, b) { return stats.tracker[b] - stats.tracker[a]; }).slice(0, 4).map(function (k) { return k + ' ' + stats.tracker[k]; }).join(' · ');

            return 'Найдено ' + stats.total + ', подходит ' + stats.usable + (q ? '. ' + q : '') + (tr ? '. Трекеры: ' + tr : '');
        }

        function missedText(picked) {
            var names = picked.missed.map(function (c) {
                var t = CHECK_NAME[c.key] ? CHECK_NAME[c.key](c) : c.key;

                return t.charAt(0).toLowerCase() + t.slice(1);
            });

            if (!names.length) return '';

            return 'Не нашлось: ' + names.join(', ') + '. Взято лучшее из оставшегося.';
        }

        // ---------------------------------------------------------------- кнопка на карточке

        function addButton(e) {
            if (!e || e.type !== 'complite' || !e.data || !e.data.movie) return;
            if (window.lampa_settings && window.lampa_settings.torrents_use === false) return;

            var movie = e.data.movie;
            var root = e.object.activity.render();

            if (root.find('.lw-watch-btn').length) return;

            var btn = $('<div class="full-start__button selector lw-watch-btn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg><span></span></div>');

            btn.find('span').text(TXT.button);
            btn.on('hover:enter', function () { openWishes(movie); });

            var holder = root.find('.full-start-new__buttons');

            if (!holder.length) holder = root.find('.full-start__buttons');

            if (holder.length) {
                var play = holder.find('.button--play');

                if (play.length) play.after(btn);
                else holder.prepend(btn);
            } else {
                root.find('.view--torrent').after(btn);
            }

            root.data('lw-movie', movie);
            paintNext(root, movie);
            prefetchLater(root, movie);
        }

        // ---------------------------------------------------------------- сериал: следующая серия

        // Что предложить для сериала: запись о раздаче, процент просмотра и следующий шаг
        function nextFor(movie) {
            if (!LW.series || !SP.isTv(movie)) return null;

            var rec = LW.series.get(movie);

            if (!rec) return null;

            var eps = 0;

            seasonList(movie).forEach(function (x) { if (x.n === rec.season) eps = x.episodes; });

            var st = LW.series.step(rec, LW.series.watchedPercent(movie, rec.season, rec.episode), eps);

            return st ? { rec: rec, step: st } : null;
        }

        // Кнопка «Серия N · та же раздача» перед «Лучшая раздача»; саму её тогда зовём «Другая раздача»
        function paintNext(root, movie) {
            var watch = root.find('.lw-watch-btn');
            var next = root.find('.lw-next-btn');
            var n = nextFor(movie);

            if (!watch.length) return;

            if (!n) {
                next.remove();
                watch.find('span').text(TXT.button);
                return;
            }

            if (!next.length) {
                next = $('<div class="full-start__button selector lw-next-btn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span></span></div>');
                next.on('hover:enter', function () { playNext(movie); });
                watch.before(next);
            }

            next.find('span').text(LW.series.label(n.step));
            watch.find('span').text(TXT.otherRelease);
        }

        function playNext(movie) {
            var n = nextFor(movie);

            if (!n) return openWishes(movie);

            var w = loadWishes();

            w.season = n.step.season;
            w.episode = n.step.episode;

            var entry = S.evaluate(n.rec.item, w, movie);
            var picked = { wishes: w, best: entry, ranked: [entry], playable: [entry], missed: [], stats: { total: 1, usable: 1, quality: {}, tracker: {} } };

            noty('Серия ' + w.episode + ' · ' + briefOf(entry));
            launch(movie, picked, entry, 'next');
        }

        // Вернулись с просмотра на карточку: надписи на кнопках могли устареть
        function refreshNext() {
            try {
                var root = $('.activity--active');
                var movie = root.data('lw-movie');

                if (movie) paintNext(root, movie);
            } catch (e) {}
        }

        // ---------------------------------------------------------------- пожелания

        function openWishes(movie) {
            var w = loadWishes();
            var tv = SP.isTv(movie);
            var seasons = tv ? seasonList(movie) : [];
            var box = h('div', 'lw-box lw-box--wishes');
            var rows = {};

            if (tv && seasons.length) w.season = seasons[0].n;

            function valueText(key) {
                if (key === 'season') return w.season ? 'Сезон ' + w.season : 'Не важно';
                if (key === 'episode') return w.episode ? 'Серия ' + w.episode : 'Выбрать в списке';

                return optionLabel(key, w[key]);
            }

            function refresh(key) {
                rows[key].find('.lw-row__val').text(valueText(key));
            }

            // другой сезон: выбранная серия от старого сезона уже не годится
            function changed(key) {
                refresh(key);

                if (key === 'season' && rows.episode) {
                    w.episode = 0;
                    refresh('episode');
                }
            }

            function chooseFrom(key, list) {
                // list: [[значение, подпись], ...]; короткие списки листаем по кругу, длинные открываем меню
                if (list.length <= 5) {
                    var idx = 0;
                    var i;

                    for (i = 0; i < list.length; i++) {
                        if (list[i][0] === w[key]) idx = i;
                    }

                    w[key] = list[(idx + 1) % list.length][0];
                    changed(key);

                    return;
                }

                L().Select.show({
                    title: ROW_LABEL[key],
                    items: list.map(function (o) { return { title: o[1], value: o[0], selected: o[0] === w[key] }; }),
                    onSelect: function (a) {
                        w[key] = a.value;
                        changed(key);
                        L().Controller.toggle('modal');
                    },
                    onBack: function () { L().Controller.toggle('modal'); }
                });
            }

            function addRow(key) {
                var row = $('<div class="lw-row selector"><div class="lw-row__name"></div><div class="lw-row__val"></div></div>');

                row.find('.lw-row__name').text(ROW_LABEL[key]);
                rows[key] = row;
                refresh(key);

                row.on('hover:enter', function () {
                    if (key === 'season') {
                        chooseFrom(key, seasons.map(function (s) { return [s.n, 'Сезон ' + s.n]; }).concat([[0, 'Не важно']]));
                    } else if (key === 'episode') {
                        var cur = seasons.filter(function (s) { return s.n === w.season; })[0];
                        var count = (cur && cur.episodes) || 24;
                        var list = [[0, 'Выбрать в списке']];
                        var n;

                        for (n = 1; n <= count; n++) list.push([n, 'Серия ' + n]);

                        chooseFrom(key, list);
                    } else {
                        chooseFrom(key, OPTIONS[key]);
                    }
                });

                box.append(row);
            }

            ['quality', 'hdr', 'dv', 'lang', 'voice', 'subs', 'seeds'].forEach(addRow);

            if (tv && seasons.length) {
                addRow('season');
                addRow('episode');
            }

            addRow('instant');

            openModal({
                title: TXT.wishesTitle,
                html: box,
                buttons: [
                    { name: TXT.go, onSelect: function () { closeModal(); findAndWatch(movie, w); } },
                    { name: TXT.showList, onSelect: function () { closeModal(); findAndWatch(movie, w, 'list'); } }
                ],
                onBack: function () { closeModal(); backToContent(); }
            });
        }

        // ---------------------------------------------------------------- поиск

        // mode: 'best' (по умолчанию) показывает лучшую раздачу, 'list' открывает весь список. query: свой поисковый запрос.
        // repaired: парсер в этом поиске уже подбирали заново, второй раз не пытаемся.
        function findAndWatch(movie, w, mode, query, repaired) {
            var my = ++runId;
            var started = new Date().getTime();

            saveWishes(w);

            // Общая часть: у нас есть ответ парсера (свой или найденный заранее), выбираем лучшую раздачу.
            function onResults(json, ahead) {
                if (my !== runId) return;

                var picked = S.pick((json && json.Results) || [], w, movie);

                picked.seconds = ahead ? 0 : Math.round((new Date().getTime() - started) / 1000);
                picked.ahead = !!ahead;
                picked.query = query || '';

                if (!ahead) closeModal();

                if (mode === 'list' && picked.ranked.length) return openList(movie, picked);

                if (!picked.best) return showNothing(movie, w, '', mode, picked);

                if (w.instant) {
                    noty('Выбрано: ' + briefOf(picked.best));
                    return launch(movie, picked, picked.best);
                }

                showResult(movie, picked, picked.best);
            }

            // Раздачи уже найдены заранее: экран поиска не нужен. После подбора парсера (repaired) старому ответу не верим.
            var ahead = repaired ? null : cachedResults(movie, w.season, query);

            if (ahead) return onResults(ahead, true);

            var box = h('div', 'lw-box');

            box.append(h('div', 'lw-title', TXT.searching));
            box.append(h('div', 'lw-line', TXT.searchingSub));
            box.append($('<div class="lw-bar"><i style="width:60%"></i></div>'));

            openModal({
                title: '',
                html: box,
                size: 'small',
                onBack: function () {
                    runId++;

                    try { L().Parser.clear(); } catch (e) {}

                    closeModal();
                    backToContent();
                }
            });

            function fail(text) {
                if (my !== runId) return;

                closeModal();

                if (LW.health) LW.health.note('parser', text);

                // парсер молчит: подбираем другой сами и повторяем поиск; не вышло или выключено — даём кнопку
                var again = function () { findAndWatch(movie, w, mode, query, true); };

                if (!repaired && LW.setup && LW.setup.autoOn()) {
                    LW.setup.repairParser(function (status) {
                        if (my !== runId) return;

                        if (status === 'applied') {
                            if (LW.health) LW.health.note('parser', text, 'Плагин сам подобрал другой парсер и повторил поиск');

                            return again();
                        }

                        if (status === 'cancel') return backToContent();

                        showNothing(movie, w, text, mode, null, again);
                    });

                    return;
                }

                showNothing(movie, w, text, mode, null, LW.setup ? again : null);
            }

            getResults(movie, w.season, query, !!repaired, function (json) { onResults(json, false); }, function (err) {
                fail(TXT.parserError + (err ? ': ' + shortText(err, 120) : ''));
            });
        }

        // ---------------------------------------------------------------- поиск заранее

        function prefetchOn() {
            var v;

            try { v = L().Storage.get(STORE_PREFETCH, true); } catch (e) { return true; }

            return !(v === false || v === 'false');
        }

        function resultsKey(movie, season, query) {
            return (movie && movie.id ? movie.id : '') + '|' + (season || 0) + '|' + (query || '');
        }

        function cachedResults(movie, season, query) {
            var hit = found[resultsKey(movie, season, query)];

            return hit && new Date().getTime() - hit.at < PREFETCH_TTL ? hit.json : null;
        }

        // Один запрос на ключ. Если такой поиск уже идёт (например, начатый заранее), присоединяемся к нему, а не гоняем парсер ещё раз.
        // fresh: игнорировать идущий поиск (после подбора парсера).
        function getResults(movie, season, query, fresh, ok, fail) {
            var key = resultsKey(movie, season, query);

            if (!fresh && inflight[key]) {
                inflight[key].push({ ok: ok, fail: fail });
                return;
            }

            runSearch(key, movie, season, query, [{ ok: ok, fail: fail }]);
        }

        function runSearch(key, movie, season, query, waiters) {
            inflight[key] = waiters;

            function end(failed, value) {
                var list = inflight[key] || [];
                var t = new Date().getTime();

                delete inflight[key];

                // пустой ответ не запоминаем: парсер мог просто моргнуть
                if (!failed && value && value.Results && value.Results.length) {
                    Object.keys(found).forEach(function (k) { if (t - found[k].at >= PREFETCH_TTL) delete found[k]; });
                    found[key] = { at: t, json: value };
                }

                list.forEach(function (x) { if (failed) x.fail(value); else x.ok(value); });
            }

            try {
                L().Parser.get(searchObject(movie, season, query), function (json) { end(false, json); }, function (err) { end(true, err); });
            } catch (e) {
                log('Parser.get: ' + e);
                end(true, '');
            }
        }

        // Когда карточка открыта, парсер уже можно спросить: к нажатию «Лучшая раздача» ответ будет готов
        function prefetchLater(root, movie) {
            if (!prefetchOn() || !L().Parser) return;

            setTimeout(function () {
                if (!prefetchOn() || Object.keys(inflight).length) return;

                var seasons = SP.isTv(movie) ? seasonList(movie) : [];
                var season = seasons.length ? seasons[0].n : 0;

                if (cachedResults(movie, season, '')) return;

                runSearch(resultsKey(movie, season, ''), movie, season, '', []);
            }, PREFETCH_DELAY);
        }

        // retry: если задан, парсер не ответил, и первой кнопкой идёт «Подобрать парсер»
        function showNothing(movie, w, text, mode, picked, retry) {
            var box = h('div', 'lw-box');
            var buttons = [{ name: TXT.changeWishes, onSelect: function () { closeModal(); openWishes(movie); } }];

            if (retry) {
                buttons.unshift({ name: TXT.fixParser, onSelect: function () {
                    closeModal();

                    LW.setup.openParserSetup({ onDone: function (status) {
                        if (status === 'applied') retry();
                        else if (status === 'cancel' || status === 'none') backToContent();
                        else showNothing(movie, w, text, mode, picked, retry);
                    } });
                } });
            }

            box.append(h('div', 'lw-title', text || TXT.nothing));
            box.append(h('div', 'lw-line', retry ? TXT.parserSub : TXT.nothingSub));

            buttons.push({ name: TXT.refine, onSelect: function () { refineSearch(movie, picked, w, mode); } });

            // что-то нашлось, но всё отсеяно как мусор: даём посмотреть всё как есть
            if (picked && picked.ranked.length) {
                buttons.push({ name: TXT.showList + ' (' + picked.ranked.length + ')', onSelect: function () {
                    picked.view = newView();
                    picked.view.junk = true;
                    closeModal();
                    openList(movie, picked);
                } });
            }

            buttons.push({ name: TXT.standardList, onSelect: function () { openStandardList(movie, w.season); } });

            openModal({ title: '', html: box, buttons: buttons, onBack: function () { closeModal(); backToContent(); } });
        }

        // ---------------------------------------------------------------- результат

        function showResult(movie, picked, entry) {
            var box = h('div', 'lw-box');
            var badges = h('div', 'lw-badges');

            box.append(h('div', 'lw-kicker', entry === picked.best ? TXT.best : TXT.chosen));
            box.append(h('div', 'lw-title', shortText(entry.item.Title, 140)));

            badgesOf(entry).forEach(function (b) { badges.append(h('span', 'lw-badge' + (b.hot ? ' lw-badge--hot' : ''), b.t)); });
            box.append(badges);

            box.append(h('div', 'lw-line', (S.formatSize(entry.item.Size) || '?') + ' · раздающих ' + entry.seeds + ' · ' + (entry.item.Tracker || '?')));
            var heavy = reserveFor(entry, movie);

            box.append(forecastBlock(entry));

            if (heavy) box.append(reserveBlock(heavy));

            box.append(checksBlock(entry, picked));

            var miss = entry === picked.best ? missedText(picked) : '';

            if (miss) box.append(h('div', 'lw-note', miss));

            box.append(h('div', 'lw-stats', statsLine(picked.stats) + '. ' + (picked.ahead ? TXT.foundAhead : 'Поиск занял ' + (picked.seconds || 0) + ' с') + '.'));

            var buttons = [];

            if (heavy) {
                var easy = SP.lighter(picked.ranked, entry.est, entry);

                buttons.push({ name: TXT.reserveGo, onSelect: function () { closeModal(); launch(movie, picked, entry, 'reserve'); } });
                buttons.push({ name: TXT.now, onSelect: function () { closeModal(); launch(movie, picked, entry, 'now'); } });

                if (easy) buttons.push({ name: TXT.lighterShort, onSelect: function () { showResult(movie, picked, easy); } });
            } else {
                buttons.push({ name: TXT.launch, onSelect: function () { closeModal(); launch(movie, picked, entry); } });
            }

            if (picked.playable.length > 1) buttons.push({ name: TXT.others, onSelect: function () { showOthers(movie, picked, entry); } });

            buttons.push({ name: TXT.changeWishes, onSelect: function () { closeModal(); openWishes(movie); } });
            buttons.push({ name: TXT.showList, onSelect: function () { closeModal(); openList(movie, picked); } });

            openModal({ title: '', html: box, buttons: buttons, onBack: function () {
                closeModal();

                // пришли из списка: Назад возвращает в него, на то же место
                if (picked.listOpen) openList(movie, picked);
                else backToContent();
            } });
        }

        function showOthers(movie, picked, current) {
            var items = picked.playable.filter(function (e) { return e !== current; }).slice(0, 10).map(function (e) {
                var v = VERDICT[e.forecast.level] || VERDICT.unknown;

                return { title: shortText(e.item.Title, 90), subtitle: briefOf(e) + ' · ' + v.head.toLowerCase(), entry: e };
            });

            L().Select.show({
                title: TXT.others,
                items: items,
                onSelect: function (a) { closeModal(); showResult(movie, picked, a.entry); },
                onBack: function () { L().Controller.toggle('modal'); }
            });
        }

        // ---------------------------------------------------------------- список раздач

        function loadSort() {
            var v = '';

            try { v = L().Storage.get(STORE_SORT, '') || ''; } catch (e) {}

            return LL.SORTS.some(function (x) { return x[0] === v; }) ? v : 'best';
        }

        function saveSort(v) {
            try { L().Storage.set(STORE_SORT, v); } catch (e) {}
        }

        // Состояние списка живёт в самом результате поиска: после просмотра раздачи список открывается там же, где был
        function newView() {
            return { sort: loadSort(), filters: {}, junk: false, limit: PAGE, focus: null };
        }

        function gbText(n) {
            return (n >= 10 ? n.toFixed(0) : n.toFixed(1)).replace('.', ',');
        }

        function statCard(value, label) {
            var card = h('div', 'lw-card');

            card.append(h('b', '', String(value)));
            card.append(h('span', '', label));

            return card;
        }

        function listStats(shown, base, total) {
            var s = LL.summary(shown);
            var box = h('div', 'lw-statblock');
            var cards = h('div', 'lw-cards');

            cards.append(statCard(shown.length, 'показано из ' + base.length));
            cards.append(statCard(s.smooth, 'потянут по прикидке'));
            cards.append(statCard(s.maxSeeds, 'раздающих максимум, медиана ' + s.medianSeeds));
            cards.append(statCard(s.maxGb ? gbText(s.minGb) + '–' + gbText(s.maxGb) : '—', 'ГБ, разброс размеров'));
            box.append(cards);

            var top = 0;

            s.quality.forEach(function (q) { if (q.count > top) top = q.count; });

            s.quality.forEach(function (q) {
                var row = h('div', 'lw-qrow');
                var bar = h('div', 'lw-qrow__bar');

                bar.append($('<i></i>').css('width', Math.max(4, Math.round(q.count / top * 100)) + '%'));

                row.append(h('div', 'lw-qrow__name', LL.valueLabel('quality', q.value)));
                row.append(bar);
                row.append(h('div', 'lw-qrow__n', String(q.count)));
                box.append(row);
            });

            var chips = [];

            if (s.hdr) chips.push('HDR ' + s.hdr);
            if (s.dv) chips.push('Dolby Vision ' + s.dv);
            if (s.dub) chips.push('Дубляж ' + s.dub);
            if (s.mvo) chips.push('Многоголосая ' + s.mvo);
            if (s.subs) chips.push('Субтитры ' + s.subs);
            if (s.viewed) chips.push(TXT.viewed + ' ' + s.viewed);

            s.trackers.slice(0, 4).forEach(function (t) { chips.push(t.value + ' ' + t.count); });

            if (total > base.length) chips.push('скрыто как мусор ' + (total - base.length));

            if (chips.length) box.append(h('div', 'lw-chips', chips.join(' · ')));

            return box;
        }

        function listRow(movie, picked, entry, index) {
            var row = h('div', 'lw-item selector');
            var main = h('div', 'lw-item__main');
            var side = h('div', 'lw-item__side');
            var badges = h('div', 'lw-item__badges');
            var v = VERDICT[entry.forecast.level] || VERDICT.unknown;
            var date = LL.dateLabel(entry);

            main.append(h('div', 'lw-item__title', shortText(entry.item.Title, 110)));

            if (entry === picked.best) badges.append(h('span', 'lw-badge lw-badge--hot', TXT.bestMark));

            badgesOf(entry).slice(0, 7).forEach(function (b) { badges.append(h('span', 'lw-badge' + (b.hot ? ' lw-badge--hot' : ''), b.t)); });

            if (entry.item.viewed) badges.append(h('span', 'lw-badge', TXT.viewed));

            main.append(badges);

            side.append(h('b', '', S.formatSize(entry.item.Size) || '?'));
            side.append(h('div', '', '↑' + entry.seeds));
            side.append(h('div', 'lw-item__meta', (entry.item.Tracker || '?') + (date ? ' · ' + date : '')));

            row.append(main);
            row.append(side);
            row.append(h('div', 'lw-dot lw-dot--' + v.cls).attr('title', v.head));

            row.on('hover:enter', function () {
                picked.view.focus = { type: 'row', index: index };
                listModal = null;

                closeModal();
                showResult(movie, picked, entry);
            });

            return row;
        }

        function listTool(label, value, onEnter) {
            var el = h('div', 'lw-tool selector');

            el.append(document.createTextNode(label));

            if (value) el.append(h('b', '', value));

            el.on('hover:enter', onEnter);

            return el;
        }

        function buildList(movie, picked) {
            var view = picked.view;
            var base = LL.visible(picked.ranked, view.junk);
            var shown = LL.sort(LL.filter(base, view.filters), view.sort);
            var root = h('div', 'lw-box lw-list');
            var tools = h('div', 'lw-tools');
            var rows = [];
            var sortBtn;
            var filterBtn;
            var active = LL.activeCount(view.filters);
            var focus = null;

            root.append(h('div', 'lw-kicker', TXT.listKicker + (picked.query ? ' · «' + shortText(picked.query, 40) + '»' : '')));
            root.append(h('div', 'lw-title', shortText(movie.title || movie.name || '', 90)));
            root.append(listStats(shown, base, picked.ranked.length));

            sortBtn = listTool(TXT.sortLabel + ': ', LL.sortName(view.sort), function () { pickSort(movie, picked); });
            filterBtn = listTool(TXT.filters, active ? ' · ' + active : '', function () { pickFilters(movie, picked); });

            tools.append(sortBtn);
            tools.append(filterBtn);
            tools.append(listTool(TXT.refine, '', function () { refineSearch(movie, picked, picked.wishes, 'list'); }));
            tools.append(listTool(TXT.standardList, '', function () { listModal = null; picked.listOpen = false; openStandardList(movie, picked.wishes.season); }));
            root.append(tools);

            shown.slice(0, view.limit).forEach(function (entry, i) {
                var row = listRow(movie, picked, entry, i);

                rows.push(row);
                root.append(row);
            });

            if (shown.length > view.limit) {
                var more = h('div', 'lw-more selector', TXT.more + ' (' + (shown.length - view.limit) + ')');

                more.on('hover:enter', function () {
                    view.focus = { type: 'row', index: view.limit };
                    view.limit += PAGE;
                    redrawList(movie, picked);
                });

                root.append(more);
            }

            if (!shown.length) root.append(h('div', 'lw-empty', shown.length === 0 && !base.length ? TXT.emptyJunk : TXT.emptyFilters));

            if (shown.length) root.append(h('div', 'lw-legend', TXT.legend));

            var f = view.focus;

            if (f && f.type === 'tool') focus = f.name === 'filter' ? filterBtn : sortBtn;
            else if (f && f.type === 'row') focus = rows[f.index] || rows[rows.length - 1] || null;
            // по умолчанию фокус на первой кнопке: если сразу встать на раздачу, шапка со статистикой уедет за край

            return { root: root, focus: focus ? focus[0] : undefined };
        }

        // Фокус на панели кнопок: Лампа прокрутила бы окно к ней и спрятала шапку со статистикой, поэтому возвращаем наверх
        function showListTop(view) {
            if (view.focus && view.focus.type === 'row') return;

            try { L().Modal.scroll().reset(); } catch (e) {}
        }

        function openList(movie, picked) {
            if (!picked.view) picked.view = newView();

            picked.listOpen = true;

            var built = buildList(movie, picked);
            var params = {
                title: '',
                html: built.root,
                size: 'large',
                scroll_to_center: true,
                select: built.focus,
                onBack: function () {
                    listModal = null;
                    picked.listOpen = false;

                    closeModal();
                    backToContent();
                }
            };

            listModal = params;
            openModal(params);
            showListTop(picked.view);
        }

        // Перерисовывает список в том же окне (Modal.update). В старой Лампе без него окно создаётся заново.
        function redrawList(movie, picked) {
            var Modal = L().Modal;

            if (listModal && Modal && Modal.update) {
                try {
                    var built = buildList(movie, picked);

                    listModal.select = built.focus;
                    Modal.update(built.root);
                    showListTop(picked.view);

                    return;
                } catch (e) {
                    log('Modal.update: ' + e);
                }
            }

            listModal = null;
            closeModal();
            openList(movie, picked);
        }

        function pickSort(movie, picked) {
            var view = picked.view;

            L().Select.show({
                title: TXT.sortTitle,
                items: LL.SORTS.map(function (x) { return { title: x[1], key: x[0], selected: x[0] === view.sort }; }),
                onSelect: function (a) {
                    view.sort = a.key;
                    view.focus = { type: 'tool', name: 'sort' };
                    saveSort(a.key);
                    redrawList(movie, picked);
                },
                onBack: function () { L().Controller.toggle('modal'); }
            });
        }

        function pickFilters(movie, picked) {
            var view = picked.view;
            var facets = LL.facets(LL.visible(picked.ranked, view.junk));
            var items = [];

            LL.FILTERS.forEach(function (key) {
                var current = view.filters[key];

                // фильтр с одним вариантом ничего не отсеивает: не загромождаем меню
                if (facets[key].length < 2 && !current) return;

                items.push({ title: LL.KEY_LABEL[key], subtitle: current ? LL.valueLabel(key, current, LANG_NAME) : TXT.anyValue, key: key });
            });

            items.push({ title: TXT.junk, subtitle: view.junk ? TXT.junkShown : TXT.junkHidden, key: '_junk' });

            if (LL.activeCount(view.filters)) items.push({ title: TXT.resetFilters, key: '_reset' });

            L().Select.show({
                title: TXT.filtersTitle,
                items: items,
                onSelect: function (a) {
                    view.focus = { type: 'tool', name: 'filter' };
                    view.limit = PAGE;

                    if (a.key === '_junk') {
                        view.junk = !view.junk;
                        redrawList(movie, picked);
                    } else if (a.key === '_reset') {
                        view.filters = {};
                        redrawList(movie, picked);
                    } else {
                        pickFilterValue(movie, picked, a.key, facets[a.key]);
                    }
                },
                onBack: function () { L().Controller.toggle('modal'); }
            });
        }

        function pickFilterValue(movie, picked, key, values) {
            var view = picked.view;
            var current = view.filters[key];
            var items = [{ title: TXT.anyValue, value: '', selected: !current }];

            values.forEach(function (v) {
                items.push({ title: LL.valueLabel(key, v.value, LANG_NAME) + ' · ' + v.count, value: v.value, selected: current === v.value });
            });

            L().Select.show({
                title: LL.KEY_LABEL[key],
                items: items,
                onSelect: function (a) {
                    if (a.value) view.filters[key] = a.value;
                    else delete view.filters[key];

                    view.focus = { type: 'tool', name: 'filter' };
                    redrawList(movie, picked);
                },
                onBack: function () { L().Controller.toggle('modal'); }
            });
        }

        // Свой поисковый запрос, как «Уточнить» в обычном списке Лампы
        function refineSearch(movie, picked, w, mode) {
            var Input = L().Input;

            if (!Input || !Input.edit) {
                noty('В этой версии Лампы нет ввода текста');
                return;
            }

            var current = (picked && picked.query) || searchText(movie, w.season).search;

            Input.edit({ free: true, title: TXT.refineTitle, nosave: true, value: current }, function (value) {
                value = ((value || '') + '').replace(/^\s+|\s+$/g, '');

                if (!value) {
                    try { L().Controller.toggle('modal'); } catch (e) {}
                    return;
                }

                listModal = null;

                if (picked) picked.listOpen = false;

                closeModal();
                findAndWatch(movie, w, mode, value);
            });
        }

        // ---------------------------------------------------------------- запуск

        // mode: 'reserve' — при нехватке скорости сразу копить запас; 'now' и 'next' — без замера скорости
        function launch(movie, picked, entry, mode) {
            var Torrent = L().Torrent;

            if (!Torrent || !Torrent.start) {
                noty('В этой версии Лампы нет запуска торрентов');
                return;
            }

            var element = entry.item;

            element.poster = movie.img;

            if (LW.series && SP.isTv(movie) && picked.wishes && picked.wishes.episode > 0) LW.series.remember(movie, picked.wishes, element);

            pending = { time: new Date().getTime(), movie: movie, picked: picked, entry: entry, wishes: picked.wishes, target: null, started: false, mode: mode || '' };

            // фильм: сразу известно, какой файл главный. Сериал: ищем нужную серию, когда Лампа отрисует список.
            try {
                Torrent.start(element, movie);
            } catch (e) {
                log('Torrent.start: ' + e);
                pending = null;
            }
        }

        function chooseMainFile(items) {
            var best = null;

            (items || []).forEach(function (f) {
                if (!best || (f.length || 0) > (best.length || 0)) best = f;
            });

            return best;
        }

        function onTorrentFile(e) {
            if (!pending) return;

            if (new Date().getTime() - pending.time > PENDING_TTL) {
                pending = null;
                return;
            }

            if (e.type === 'list_open') {
                if (!SP.isTv(pending.movie)) pending.target = chooseMainFile(e.items);
                else if (pending.mode === 'next') missingLater(pending);
            } else if (e.type === 'render') {
                var want = pending.wishes.episode;
                var el = e.element;
                var hit;

                if (pending.started) return;

                if (SP.isTv(pending.movie)) {
                    hit = want > 0 && el.episode === want && (!pending.wishes.season || !el.season || el.season === pending.wishes.season);
                } else {
                    hit = el === pending.target;
                }

                if (hit) {
                    pending.started = true;

                    var p = pending;
                    var item = e.item;

                    // Лампа сначала достроит окно со списком, потом мы запускаем: иначе нажатие уйдёт в пустоту
                    setTimeout(function () { check(p, el, item); }, SETTLE_MS);
                }
            } else if (e.type === 'list_close') {
                if (cancelMeasure) cancelMeasure();

                pending = null;
            }
        }

        // Серии раздачи Лампа рисует сразу после list_open. Если к этому времени нужная не нашлась, говорим об этом и забываем раздачу
        function missingLater(p) {
            setTimeout(function () {
                if (pending !== p || p.started) return;

                noty(TXT.nextMissing + p.wishes.episode + '. Выберите «' + TXT.otherRelease + '»');

                if (LW.series) LW.series.forget(p.movie);
            }, MISSING_MS);
        }

        function measureUrl(url) {
            if (!url || url.indexOf('/stream/') < 0) return null; // транскодирование (gst) не мерим

            return url.replace(/&(?:preload|play)(?=$|&)/, '&preload');
        }

        function makeGet() {
            var Reguest = L().Reguest;

            if (!Reguest) return null;

            var net = new Reguest();

            net.timeout(3000);

            return {
                get: function (url, ok, fail) {
                    net.silent(url, function (json) { ok(json && typeof json === 'object' ? json : {}); }, function () { fail(); });
                },
                clear: function () { try { net.clear(); } catch (e) {} }
            };
        }

        // Замеряем скорость и решаем, запускать ли сразу
        function check(p, element, item) {
            pending = null;

            var url = measureUrl(element.url);
            var net = makeGet();

            if (p.mode === 'now' || p.mode === 'next') return play(item);
            if (!url || !net) return play(item);

            var box = h('div', 'lw-box');
            var live = h('div', 'lw-live', 'Подключаюсь…');
            var bar = $('<div class="lw-bar"><i></i></div>');
            var done = false;

            box.append(h('div', 'lw-line', TXT.checkingSub));
            box.append(bar);
            box.append(live);

            function stop() {
                done = true;

                if (cancelMeasure) cancelMeasure();

                cancelMeasure = null;
                net.clear();
            }

            openModal({
                title: TXT.checking,
                html: box,
                size: 'medium',
                buttons: [
                    { name: TXT.skip, onSelect: function () { stop(); closeModal(); play(item); } }
                ],
                onBack: function () { stop(); closeModal(); }
            });

            cancelMeasure = SP.measure({ url: url, get: net.get, duration: MEASURE_MS, interval: TICK_MS, warmup: WARMUP_MS }, function (res) {
                if (done) return;

                done = true;
                cancelMeasure = null;
                net.clear();

                closeModal();

                if (res.reason === 'cancel') return;

                verdictFlow(p, element, item, res);
            }, function (s) {
                if (done) return;

                bar.find('i').css('width', Math.min(100, Math.round(s.elapsed / MEASURE_MS * 100)) + '%');
                live.text('Скорость ' + s.mbps + ' Мбит/с · подключено узлов ' + s.peers + ' · нужно ' + p.entry.need + ' Мбит/с');
            });
        }

        function rememberLine(res) {
            var prev = 0;

            try { prev = parseFloat(L().Storage.get(STORE_LINE, 0)) || 0; } catch (e) {}

            if (res.maxMbps > prev) {
                try { L().Storage.set(STORE_LINE, res.maxMbps); } catch (e2) {}
            }
        }

        function play(item) {
            try { item.trigger('hover:enter'); } catch (e) { log('play: ' + e); }
        }

        function verdictFlow(p, element, item, res) {
            var entry = p.entry;

            if (res.ok) rememberLine(res);

            if (!res.ok) {
                if (LW.health) LW.health.note('speed', 'Скорость раздачи измерить не удалось', 'Фильм запущен без проверки скорости');

                noty('Скорость измерить не удалось, запускаю как есть');
                return play(item);
            }

            var v = SP.verdict(res.avgMbps, entry.need, SP.runtimeMin(p.movie));

            if (v.level === 'smooth') {
                noty('Скорость ' + res.avgMbps + ' Мбит/с при нужных ' + entry.need + ': пойдёт плавно');
                return play(item);
            }

            var rs = reserveAfterMeasure(p, res);

            // человек уже выбрал «Накопить запас и смотреть»: второй раз не спрашиваем
            if (p.mode === 'reserve' && rs.offer) return startReserve(p, element, item, res, rs);

            showVerdict(p, element, item, res, v, rs);
        }

        // Запас по реальной скорости. offer: стоит предлагать. cap: сколько сервер вообще способен накопить (0 — неизвестно)
        function reserveAfterMeasure(p, res) {
            var r = SP.reserve(res.avgMbps, p.entry.need, SP.runtimeMin(p.movie));
            var cap = res.preloadSize || 0;
            var low = r.needed && cap > 0 && cap < r.bytes * 0.5;

            return { r: r, cap: cap, capLow: low, offer: r.needed && r.feasible && !low };
        }

        function showVerdict(p, element, item, res, v, rs) {
            var entry = p.entry;

            rs = rs || reserveAfterMeasure(p, res);
            var info = VERDICT[v.level] || VERDICT.unknown;
            var box = h('div', 'lw-box');
            var verdictBox = h('div', 'lw-verdict lw-verdict--' + info.cls);

            verdictBox.append(h('b', '', info.mark + ' ' + info.head));
            verdictBox.append(h('div', '', 'Скорость ' + res.avgMbps + ' Мбит/с (пик ' + res.maxMbps + '), фильму нужно около ' + entry.need + '. Подключено узлов: ' + res.peers + ', раздающих: ' + res.seeders + '.'));

            box.append(h('div', 'lw-title', shortText(entry.item.Title, 110)));
            box.append(verdictBox);

            var tipKeys = SP.tips(v, { seeders: res.seeders, peers: res.peers, need: entry.need, have: res.avgMbps });
            var tips = $('<ul class="lw-tips"></ul>');

            // с готовым запасом совет «подождать» заменён блоком ниже; если сервер столько не накопит, говорим об этом
            if (rs.offer) tipKeys = tipKeys.filter(function (k) { return k !== 'wait'; });
            if (rs.capLow) tipKeys.unshift('reserveCap');

            if (rs.offer) box.append(reserveBlock(rs.r));

            tipKeys.slice(0, 4).forEach(function (k) {
                if (TIPS[k]) tips.append(h('li', '', TIPS[k](v, rs)));
            });

            if (tips.children().length) box.append(tips);

            var easier = SP.lighter(p.picked.ranked, res.avgMbps, entry);
            var buttons = [];

            function lighterButton() {
                return {
                    name: TXT.lighter + ': ' + shortText(briefOf(easier), 60),
                    onSelect: function () {
                        closeModal();
                        dropTorrent(function () { launch(p.movie, p.picked, easier); });
                    }
                };
            }

            var anyway = { name: v.level === 'edge' ? TXT.watch : TXT.anyway, onSelect: function () { closeModal(); play(item); } };

            if (rs.offer) buttons.push({ name: TXT.reserveGo, onSelect: function () { closeModal(); startReserve(p, element, item, res, rs); } });

            if (v.level === 'edge') {
                buttons.push(anyway);

                if (easier) buttons.push(lighterButton());
            } else {
                if (easier) buttons.push(lighterButton());

                buttons.push(anyway);
            }

            buttons.push({ name: TXT.back, onSelect: function () { closeModal(); dropTorrent(function () { showResult(p.movie, p.picked, entry); }); } });

            openModal({ title: '', html: box, buttons: buttons, onBack: function () { closeModal(); } });
        }

        function pairSize(a, b) {
            if (b >= 1e9) return gbText(a / 1e9) + ' из ' + gbText(b / 1e9) + ' ГБ';

            return Math.round(a / 1e6) + ' из ' + Math.round(b / 1e6) + ' МБ';
        }

        // ~1 мин 20 с, ~45 с
        function etaText(sec) {
            if (!(sec > 0)) return '—';
            if (sec < 60) return '~' + sec + ' с';

            var m = Math.floor(sec / 60);
            var s = Math.round((sec % 60) / 5) * 5;

            if (s === 60) { m++; s = 0; }

            return '~' + m + ' мин' + (s ? ' ' + s + ' с' : '');
        }

        // Экран «Копим запас»: TorrServer качает начало файла, мы показываем, сколько накоплено, и запускаем плеер сами
        function startReserve(p, element, item, res, rs) {
            var url = measureUrl(element.url);
            var net = makeGet();
            var entry = p.entry;

            if (!url || !net) return play(item);

            var finished = false;
            var box = h('div', 'lw-box lw-box--reserve');
            var big = h('div', 'lw-big');
            var num = h('span', 'lw-big__n', '0');
            var bar = $('<div class="lw-bar"><i style="width:0"></i></div>');
            var cards = h('div', 'lw-cards lw-cards--three');
            var saved = statCard('0', TXT.reserveSaved);
            var speed = statCard('—', TXT.reserveSpeed);
            var eta = statCard('—', TXT.reserveEta);
            var capNote = null;

            big.append(num).append(h('small', '', '%'));
            box.append(big);
            box.append(h('div', 'lw-kicker', TXT.reserveKicker));
            box.append(h('div', 'lw-title', TXT.reserveTitle));
            box.append(h('div', 'lw-line', shortText(entry.item.Title, 90) + '. Как только запаса хватит, плеер запустится сам.'));
            box.append(bar);
            cards.append(saved).append(speed).append(eta);
            box.append(cards);

            function stop() {
                finished = true;

                if (cancelMeasure) cancelMeasure();

                cancelMeasure = null;
                net.clear();
            }

            openModal({
                title: '',
                html: box,
                size: 'large',
                buttons: [
                    { name: TXT.reserveNow, onSelect: function () { stop(); closeModal(); play(item); } },
                    { name: TXT.cancel, onSelect: function () { stop(); closeModal(); dropTorrent(function () {}); } }
                ],
                onBack: function () { stop(); closeModal(); }
            });

            cancelMeasure = SP.accumulate({ url: url, get: net.get, targetBytes: rs.r.bytes, interval: TICK_MS, maxMs: CFG.reserveMaxMs, stallMs: CFG.reserveStallMs }, function (out) {
                if (finished) return;

                finished = true;
                cancelMeasure = null;
                net.clear();
                closeModal();

                if (out.reason === 'cancel') return;

                if (out.reason === 'ready') noty('Запас накоплен: ' + S.formatSize(out.preloaded) + '. Запускаю');
                else noty('Запас перестал расти (' + S.formatSize(out.preloaded) + '), запускаю с тем, что есть');

                play(item);
            }, function (s) {
                if (finished) return;

                num.text(String(s.pct));
                bar.find('i').css('width', s.pct + '%');
                saved.find('b').text(pairSize(s.preloaded, s.target));
                speed.find('b').text(s.mbps + ' Мбит/с');
                eta.find('b').text(etaText(s.etaSec));

                if (s.capped && !capNote) {
                    capNote = h('div', 'lw-note', TXT.reserveCapNote);
                    box.append(capNote);
                }
            });
        }

        // Закрыть окно со списком файлов у Лампы: она сама остановит торрент и вернёт фокус
        function dropTorrent(next) {
            try { L().Controller.back(); } catch (e) { log('back: ' + e); }

            setTimeout(next, 250);
        }

        // ---------------------------------------------------------------- запуск плагина

        function start() {
            var Lampa = L();

            if (!Lampa || !Lampa.Listener) return;

            try {
                addStyle();

                Lampa.Listener.follow('full', addButton);
                Lampa.Listener.follow('torrent_file', onTorrentFile);

                try {
                    if (Lampa.Player && Lampa.Player.listener) Lampa.Player.listener.follow('destroy', function () { setTimeout(refreshNext, 400); });
                } catch (e2) {}
            } catch (e) {
                log('start: ' + e);
            }
        }

        if (window.appready) start();
        else window.Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });

        LW.ui = { h: h, openModal: openModal, closeModal: closeModal, noty: noty, shortText: shortText, log: log };
        LW.watch = { start: start, openWishes: openWishes, addButton: addButton, prefetchOn: prefetchOn, cachedResults: cachedResults, playNext: playNext, refreshNext: refreshNext };
    });

    run('setup', function (LW) {
        'use strict';

        /*
         * Окна и пункты настроек для автоподбора парсера (LW.parser).
         *
         * Настройки → Lampa Watch: кнопка «Подобрать парсер», «Откатить», переключатель автопочинки.
         * Если парсер не ответил при поиске раздачи, watch.js сам зовёт LW.setup.repairParser().
         * Все окна рассчитаны на пульт.
         */
        if (!LW.ui || !LW.parser) return;

        var U = LW.ui;
        var P = LW.parser;
        var T = LW.tune;

        var AUTO_KEY = 'lw_parser_auto';

        var TXT = {
            component: 'Lampa Watch',
            parserTitle: 'Парсер',
            pick: 'Подобрать парсер',
            pickDescr: 'Проверит парсеры и трекеры, выберет самые быстрые и полные и сам впишет их в настройки.',
            now: 'Сейчас',
            rollback: 'Откатить настройки парсера',
            rollbackNone: 'Копии нет: подбор ещё не менял настройки',
            rollbackDone: 'Настройки парсера возвращены',
            rollbackNothing: 'Откатывать нечего',
            copyFrom: 'Копия от',
            auto: 'Чинить парсер автоматически',
            autoDescr: 'Если парсер не отвечает при поиске раздачи, плагин сам подберёт другой и повторит поиск.',
            prefetch: 'Искать раздачи заранее',
            prefetchDescr: 'Когда открыта карточка фильма, плагин заранее спрашивает парсер, и «Лучшая раздача» открывается сразу, без ожидания поиска. Выключите, если парсер платный или медленный.',
            searching: 'Подбираю парсер',
            searchingAuto: 'Парсер не отвечает, подбираю другой',
            searchingSub: 'Проверяю, какие парсеры отвечают на этом устройстве, и сравниваю их по тестовому запросу',
            waiting: 'ждёт',
            checking: 'проверяю…',
            cancel: 'Отмена',
            close: 'Закрыть',
            again: 'Повторить',
            apply: 'Применить',
            found: 'Парсер подобран',
            foundKicker: 'Лучший вариант',
            keep: 'Менять ничего не нужно',
            keepSub: 'Текущий парсер уже работает не хуже остальных.',
            none: 'Рабочий парсер не найден',
            noneSub: 'Ни один из проверенных не ответил. Что можно сделать:',
            tips: [
                'Проверьте, что на устройстве есть интернет.',
                'Если у вас свой Jackett или Prowlarr, проверьте, что он запущен и доступен из этой сети.',
                'Если запущен TorrServer, его встроенный поиск тоже проверяется, но для него нужен адрес TorrServer в настройках.'
            ],
            changes: 'Что изменится',
            checked: 'Проверено',
            mainOne: 'основной',
            mainTwo: 'второй',
            noAnswer: 'нет ответа',
            changed: 'Парсер переключён',
            changedHint: 'Вернуть прежние настройки можно в Настройки → Lampa Watch.',
            applied: 'Парсер настроен',
            seconds: 'с',
            items: 'раздач',
            trackers: 'трекеров',
            score: 'оценка',

            tuneTitle: 'TorrServer',
            tunePick: 'Настроить TorrServer',
            tunePickDescr: 'Прочитает настройки сервера и предложит изменения, которые ускоряют старт и добавляют источников.',
            tuneRollback: 'Откатить настройки TorrServer',
            tuneRollbackNone: 'Копии нет: настройка ещё не меняла сервер',
            tuneRollbackDone: 'Настройки TorrServer возвращены',
            tuneReading: 'Читаю настройки TorrServer',
            tuneReadingSub: 'Смотрю, что стоит на сервере',
            tuneWriting: 'Применяю настройки',
            tuneWritingSub: 'Сервер перезапускает торрент-клиент, это займёт пару секунд',
            tuneErrTitle: 'Не удалось настроить TorrServer',
            tuneKicker: 'Настройка TorrServer',
            tuneNoChanges: 'Сервер уже настроен хорошо',
            tuneNoChangesSub: 'Менять нечего: то, что ускоряет старт и добавляет источников, у вас уже включено.',
            tuneKeptCopy: 'Копия прежних настроек сохранена: вернуть их можно в Настройки → Lampa Watch → «Откатить настройки TorrServer».',
            tuneWarn: 'Применение перезапускает торрент-клиент TorrServer: идущая раздача прервётся. Прежние настройки сохранятся, вернуть их можно в Настройки → Lampa Watch → «Откатить настройки TorrServer».',
            tuneDone: 'TorrServer настроен',
            tuneNotes: 'К сведению',
            server: 'Сервер'
        };

        var KEY_NAME = {
            parser_torrent_type: 'Тип парсера',
            parser_use: 'Использовать парсер',
            parser_use_link: 'Какие ссылки',
            jackett_url: 'Jackett: ссылка', jackett_key: 'Jackett: ключ',
            jackett_url_two: 'Jackett: вторая ссылка', jackett_key_two: 'Jackett: ключ второй',
            prowlarr_url: 'Prowlarr: ссылка', prowlarr_key: 'Prowlarr: ключ',
            prowlarr_url_two: 'Prowlarr: вторая ссылка', prowlarr_key_two: 'Prowlarr: ключ второй',
            torrserver_search_type: 'Поиск TorrServer'
        };

        var VALUE_NAME = {
            parser_torrent_type: { jackett: 'Jackett', prowlarr: 'Prowlarr', torrserver: 'TorrServer' },
            parser_use_link: { one: 'только основная', two: 'только вторая', both: 'обе сразу' },
            parser_use: { 'true': 'да', 'false': 'нет' },
            torrserver_search_type: { rutor: 'Rutor', torznab: 'Torznab', both: 'оба' }
        };

        var runToken = 0;

        // ---------------------------------------------------------------- оформление

        function addStyle() {
            if (document.getElementById('lw-setup-style')) return;

            var css = [
                '.lw-prow{display:flex;align-items:center;padding:.55em .9em;margin-bottom:.3em;border-radius:.55em;background:rgba(255,255,255,.07)}',
                '.lw-prow__dot{flex:none;width:.75em;height:.75em;margin-right:.85em;border-radius:50%;background:rgba(255,255,255,.3)}',
                '.lw-prow--run .lw-prow__dot{background:#f2c94c}',
                '.lw-prow--ok .lw-prow__dot{background:#6fcf97}',
                '.lw-prow--bad .lw-prow__dot{background:#eb5757}',
                '.lw-prow--best{box-shadow:inset 0 0 0 .14em #2f6fe4}',
                '.lw-prow__name{flex:1;min-width:0;word-break:break-all}',
                '.lw-prow__tag{display:inline-block;margin-left:.6em;padding:.05em .5em;border-radius:.35em;background:#2f6fe4;font-size:.75em}',
                '.lw-prow__info{margin-left:1em;opacity:.7;font-size:.9em;text-align:right}',
                '.lw-chg{display:flex;justify-content:space-between;padding:.35em 0;border-bottom:1px solid rgba(255,255,255,.08)}',
                '.lw-chg__k{opacity:.7}',
                '.lw-chg__v{text-align:right;word-break:break-all;margin-left:1em}',
                '.lw-chg__v s{opacity:.5;margin-right:.5em}',
                '.lw-h{margin:1em 0 .4em;opacity:.55;font-size:.85em;letter-spacing:.06em;text-transform:uppercase}',
                '.lw-tc{padding:.6em .9em;margin-bottom:.35em;border-radius:.55em;background:rgba(255,255,255,.07)}',
                '.lw-tc__top{display:flex;justify-content:space-between;align-items:baseline}',
                '.lw-tc__name{font-weight:600}',
                '.lw-tc__val{text-align:right;margin-left:1em}',
                '.lw-tc__val s{opacity:.5;margin-right:.5em}',
                '.lw-tc__why{opacity:.65;font-size:.9em;margin-top:.25em;line-height:1.35}'
            ].join('\n');

            var el = document.createElement('style');

            el.id = 'lw-setup-style';
            el.appendChild(document.createTextNode(css));
            document.head.appendChild(el);
        }

        // ---------------------------------------------------------------- вспомогательное

        function autoOn() {
            try {
                var v = window.Lampa.Storage.get(AUTO_KEY, true);

                return !(v === false || v === 'false');
            } catch (e) {
                return true;
            }
        }

        function secs(ms) {
            return (Math.round(ms / 100) / 10).toFixed(1);
        }

        // 1 раздача, 2 раздачи, 5 раздач
        function plural(n, one, few, many) {
            var a = Math.abs(n) % 100;
            var b = a % 10;

            if (a > 10 && a < 20) return many;
            if (b > 1 && b < 5) return few;

            return b === 1 ? one : many;
        }

        function shown(key, v) {
            var map = VALUE_NAME[key];
            var s = v === undefined || v === null ? '' : String(v);

            if (/_key/.test(key)) return s ? '••••' : 'пусто';
            if (map && map[s]) return map[s];

            return s || 'пусто';
        }

        function when(ts) {
            var d = new Date(ts);
            var p = function (n) { return (n < 10 ? '0' : '') + n; };

            return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        }

        function infoOf(res) {
            if (!res.ok) return res.error || TXT.noAnswer;
            if (res.rating < 15) return secs(res.ms) + ' ' + TXT.seconds + ' · пусто по тестовому запросу';

            return secs(res.ms) + ' ' + TXT.seconds + ' · ' + res.ev.relevant + ' ' + plural(res.ev.relevant, 'раздача', 'раздачи', 'раздач') + ' · ' + res.ev.trackers.length + ' ' + plural(res.ev.trackers.length, 'трекер', 'трекера', 'трекеров') + ' · ' + TXT.score + ' ' + res.rating;
        }

        function nameOf(c) {
            return (P.TYPE_NAME[c.type] && c.type !== 'torrserver' ? P.TYPE_NAME[c.type] + ' · ' : '') + P.labelOf(c);
        }

        function resultRows(out, plan) {
            var box = $('<div></div>');

            out.results.forEach(function (r) {
                var tag = '';
                var row = U.h('div', 'lw-prow lw-prow--' + (r.ok && r.rating >= 15 ? 'ok' : 'bad'));
                var name = U.h('div', 'lw-prow__name', nameOf(r.cand));

                if (plan && plan.primary === r) tag = TXT.mainOne;
                else if (plan && plan.secondary === r) tag = TXT.mainTwo;

                if (tag) {
                    row.addClass('lw-prow--best');
                    name.append(U.h('span', 'lw-prow__tag', tag));
                }

                row.append(U.h('div', 'lw-prow__dot'));
                row.append(name);
                row.append(U.h('div', 'lw-prow__info', infoOf(r)));
                box.append(row);
            });

            return box;
        }

        // ---------------------------------------------------------------- окно проверки

        // opts: { auto: true — сразу применить найденное, back: имя контроллера, куда вернуть фокус по окончании
        // (Лампа сама его не возвращает, если окно открыто не поверх другого окна), onDone(status) — 'applied' | 'kept' | 'none' | 'cancel' }
        function openParserSetup(opts) {
            opts = opts || {};

            var mine = ++runToken;
            var box = U.h('div', 'lw-box');
            var bar = $('<div class="lw-bar"><i style="width:3%"></i></div>');
            var list = U.h('div', 'lw-list');
            var rows = {};
            var doneCalled = false;

            function finish(status) {
                if (doneCalled) return;

                doneCalled = true;

                if (opts.back) {
                    try { window.Lampa.Controller.toggle(opts.back); } catch (e) {}
                }

                if (opts.onDone) opts.onDone(status);
            }

            function cancelIt() {
                runToken++;

                try { P.cancel(); } catch (e) {}

                U.closeModal();
                finish('cancel');
            }

            box.append(U.h('div', 'lw-title', opts.auto ? TXT.searchingAuto : TXT.searching));
            box.append(U.h('div', 'lw-line', TXT.searchingSub));
            box.append(bar);
            box.append(list);

            U.openModal({ title: '', html: box, size: 'large', buttons: [{ name: TXT.cancel, onSelect: cancelIt }], onBack: cancelIt });

            function setRow(c, cls, info) {
                var r = rows[c.id];

                if (!r) return;

                r.row.removeClass('lw-prow--run lw-prow--ok lw-prow--bad').addClass(cls);
                r.info.text(info);
            }

            P.run({
                onList: function (cands) {
                    cands.forEach(function (c) {
                        var row = U.h('div', 'lw-prow');
                        var info = U.h('div', 'lw-prow__info', TXT.waiting);

                        row.append(U.h('div', 'lw-prow__dot'));
                        row.append(U.h('div', 'lw-prow__name', nameOf(c)));
                        row.append(info);
                        list.append(row);

                        rows[c.id] = { row: row, info: info };
                    });
                },
                onStart: function (c) { setRow(c, 'lw-prow--run', TXT.checking); },
                onResult: function (res, n, total) {
                    setRow(res.cand, res.ok && res.rating >= 15 ? 'lw-prow--ok' : 'lw-prow--bad', infoOf(res));
                    bar.find('i').css('width', Math.max(3, Math.round(100 * n / total)) + '%');
                }
            }, function (out) {
                if (mine !== runToken) return;

                U.closeModal();

                if (!out.plan) return showNone(out, opts, finish);
                if (opts.auto) return autoApply(out, finish);

                showFound(out, opts, finish);
            });
        }

        function autoApply(out, finish) {
            var changes = P.apply(out.plan);

            if (!changes.length) return finish('kept');

            U.noty(TXT.changed + ': ' + P.describe(out.plan));
            U.noty(TXT.changedHint);
            refreshSettings();
            finish('applied');
        }

        function showNone(out, opts, finish) {
            var box = U.h('div', 'lw-box');
            var tips = $('<ul class="lw-tips"></ul>');

            box.append(U.h('div', 'lw-title', TXT.none));
            box.append(U.h('div', 'lw-line', TXT.noneSub));

            TXT.tips.forEach(function (t) { tips.append(U.h('li', '', t)); });
            box.append(tips);

            box.append(U.h('div', 'lw-h', TXT.checked + ': ' + out.results.length));
            box.append(resultRows(out, null));

            function again() {
                U.closeModal();
                openParserSetup(opts);
            }

            function close() {
                U.closeModal();
                finish('none');
            }

            U.openModal({ title: '', html: box, size: 'large', buttons: [{ name: TXT.again, onSelect: again }, { name: TXT.close, onSelect: close }], onBack: close });
        }

        function changesBlock(plan) {
            var box = $('<div></div>');

            box.append(U.h('div', 'lw-h', TXT.changes));

            plan.changes.forEach(function (c) {
                var v = U.h('div', 'lw-chg__v');

                if (String(c.from) !== '' ) v.append($('<s></s>').text(shown(c.key, c.from)));

                v.append(document.createTextNode(shown(c.key, c.to)));

                box.append($('<div class="lw-chg"></div>').append(U.h('div', 'lw-chg__k', KEY_NAME[c.key] || c.key)).append(v));
            });

            return box;
        }

        function showFound(out, opts, finish) {
            var plan = out.plan;
            var box = U.h('div', 'lw-box');
            var badges = U.h('div', 'lw-badges');
            var p = plan.primary;
            var buttons = [];

            box.append(U.h('div', 'lw-kicker', plan.changed ? TXT.foundKicker : TXT.keep));
            box.append(U.h('div', 'lw-title', P.describe(plan)));

            if (plan.type !== 'torrserver') {
                badges.append(U.h('span', 'lw-badge lw-badge--hot', secs(p.ms) + ' ' + TXT.seconds));
                badges.append(U.h('span', 'lw-badge', p.ev.relevant + ' ' + plural(p.ev.relevant, 'раздача', 'раздачи', 'раздач')));
                badges.append(U.h('span', 'lw-badge', p.ev.trackers.length + ' ' + plural(p.ev.trackers.length, 'трекер', 'трекера', 'трекеров')));
                box.append(badges);
                box.append(U.h('div', 'lw-line', p.ev.trackers.join(', ')));
            }

            if (!plan.changed) box.append(U.h('div', 'lw-note', TXT.keepSub));
            else box.append(changesBlock(plan));

            box.append(U.h('div', 'lw-h', TXT.checked + ': ' + out.results.length));
            box.append(resultRows(out, plan));

            function close() {
                U.closeModal();
                finish(plan.changed ? 'cancel' : 'kept');
            }

            if (plan.changed) {
                buttons.push({ name: TXT.apply, onSelect: function () {
                    P.apply(plan);
                    U.closeModal();
                    U.noty(TXT.applied + ': ' + P.describe(plan));
                    refreshSettings();
                    finish('applied');
                } });
            }

            buttons.push({ name: TXT.close, onSelect: close });

            U.openModal({ title: '', html: box, size: 'large', buttons: buttons, onBack: close });
        }

        // Для watch.js: парсер не ответил при поиске. Подбираем другой молча (кроме окна хода проверки).
        function repairParser(done) {
            openParserSetup({ auto: true, onDone: done });
        }

        // ---------------------------------------------------------------- окна настройки TorrServer

        var tuneToken = 0;

        function busyModal(title, sub, onCancel) {
            var box = U.h('div', 'lw-box');

            box.append(U.h('div', 'lw-title', title));
            box.append(U.h('div', 'lw-line', sub));
            box.append($('<div class="lw-bar"><i style="width:60%"></i></div>'));

            // пока идёт запись на сервер, закрывать окно нельзя: оборвём на середине
            U.openModal({ title: '', html: box, size: 'small', buttons: onCancel ? [{ name: TXT.cancel, onSelect: onCancel }] : [], onBack: onCancel || function () {} });
        }

        function tuneChangesBlock(plan) {
            var box = $('<div></div>');

            plan.changes.forEach(function (c) {
                var val = U.h('div', 'lw-tc__val');

                val.append($('<s></s>').text(c.fromText));
                val.append(document.createTextNode(c.toText));

                box.append($('<div class="lw-tc"></div>')
                    .append($('<div class="lw-tc__top"></div>').append(U.h('div', 'lw-tc__name', c.label)).append(val))
                    .append(U.h('div', 'lw-tc__why', c.why)));
            });

            return box;
        }

        // opts: { back: контроллер для возврата фокуса, onDone(status) — 'applied' | 'kept' | 'error' | 'cancel' }
        function openTune(opts) {
            opts = opts || {};

            var mine = ++tuneToken;
            var doneCalled = false;

            function finish(status) {
                if (doneCalled) return;

                doneCalled = true;

                if (opts.back) {
                    try { window.Lampa.Controller.toggle(opts.back); } catch (e) {}
                }

                if (opts.onDone) opts.onDone(status);
            }

            function cancelIt() {
                tuneToken++;
                U.closeModal();
                finish('cancel');
            }

            function showError(err, written) {
                var box = U.h('div', 'lw-box');

                if (LW.health) LW.health.note('tune', TXT.tuneErrTitle + ': ' + err);

                box.append(U.h('div', 'lw-title', TXT.tuneErrTitle));
                box.append(U.h('div', 'lw-line', err));

                if (written && T.hasBackup()) box.append(U.h('div', 'lw-note', TXT.tuneKeptCopy));

                function close() {
                    U.closeModal();
                    finish('error');
                }

                U.openModal({ title: '', html: box, buttons: [{ name: TXT.again, onSelect: function () { U.closeModal(); openTune(opts); } }, { name: TXT.close, onSelect: close }], onBack: close });
            }

            function showPlan(cur, plan) {
                var box = U.h('div', 'lw-box');
                var n = plan.changes.length;
                var buttons = [];

                function close() {
                    U.closeModal();
                    finish(n ? 'cancel' : 'kept');
                }

                box.append(U.h('div', 'lw-kicker', TXT.tuneKicker));
                box.append(U.h('div', 'lw-title', n ? 'Предлагаю ' + n + ' ' + plural(n, 'изменение', 'изменения', 'изменений') : TXT.tuneNoChanges));
                box.append(U.h('div', 'lw-line', TXT.server + ': ' + P.hostOf(T.baseUrl())));

                if (n) box.append(tuneChangesBlock(plan));
                else box.append(U.h('div', 'lw-note', TXT.tuneNoChangesSub));

                if (plan.notes.length) {
                    box.append(U.h('div', 'lw-h', TXT.tuneNotes));
                    plan.notes.forEach(function (t) { box.append(U.h('div', 'lw-note', t)); });
                }

                if (n) {
                    box.append(U.h('div', 'lw-stats', TXT.tuneWarn));

                    buttons.push({ name: TXT.apply, onSelect: function () {
                        U.closeModal();
                        busyModal(TXT.tuneWriting, TXT.tuneWritingSub);

                        T.apply(plan, cur, function (err) {
                            if (mine !== tuneToken) return;

                            U.closeModal();

                            if (err) return showError(err, true);

                            U.noty(TXT.tuneDone + ': ' + n + ' ' + plural(n, 'изменение', 'изменения', 'изменений'));
                            refreshSettings();
                            finish('applied');
                        });
                    } });
                }

                buttons.push({ name: TXT.close, onSelect: close });

                U.openModal({ title: '', html: box, size: 'large', buttons: buttons, onBack: close });
            }

            busyModal(TXT.tuneReading, TXT.tuneReadingSub, cancelIt);

            T.load(function (err, cur) {
                if (mine !== tuneToken) return;

                U.closeModal();

                if (err) return showError(err);

                showPlan(cur, T.plan(cur, { line: T.lineMbps() }));
            });
        }

        function doTuneRollback() {
            if (!T.hasBackup()) return U.noty(TXT.rollbackNothing);

            U.noty(TXT.tuneWriting + '…');

            T.rollback(function (err) {
                U.noty(err ? TXT.tuneErrTitle + ': ' + err : TXT.tuneRollbackDone);
                refreshSettings();
            });
        }

        // ---------------------------------------------------------------- настройки Лампы

        var settingItems = {};

        function refreshSettings() {
            var b = P.loadBackup();

            if (settingItems.pick) settingItems.pick.find('.settings-param__descr').text(TXT.now + ': ' + P.currentLabel());
            if (settingItems.rollback) settingItems.rollback.find('.settings-param__descr').text(b ? TXT.copyFrom + ' ' + when(b.at) + ' (' + (b.summary || '') + ')' : TXT.rollbackNone);

            if (T) {
                var tb = T.loadBackup();
                var addr = T.baseUrl();

                if (settingItems.tune) settingItems.tune.find('.settings-param__descr').text(TXT.tunePickDescr + (addr ? ' ' + TXT.server + ': ' + P.hostOf(addr) + '.' : ''));
                if (settingItems.tuneRollback) settingItems.tuneRollback.find('.settings-param__descr').text(tb ? TXT.copyFrom + ' ' + when(tb.at) : TXT.tuneRollbackNone);
            }
        }

        function doRollback() {
            if (!P.hasBackup()) return U.noty(TXT.rollbackNothing);

            P.rollback();
            U.noty(TXT.rollbackDone);
            refreshSettings();
        }

        function addSettings() {
            var api = window.Lampa.SettingsApi;

            if (!api) return;

            api.addComponent({
                component: 'lampa_watch',
                name: TXT.component,
                icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8.5 11.2l1.8 1.8 3.4-3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            });

            // «Диагностика и обновление» первой строкой: с неё начинают, когда что-то не работает
            if (LW.health) LW.health.addSettings(api);

            api.addParam({ component: 'lampa_watch', param: { name: 'lw_parser_title', type: 'title' }, field: { name: TXT.parserTitle } });

            api.addParam({
                component: 'lampa_watch',
                param: { name: 'lw_parser_pick', type: 'button' },
                field: { name: TXT.pick, description: TXT.pickDescr },
                onRender: function (item) { settingItems.pick = item; refreshSettings(); },
                onChange: function () { openParserSetup({ back: 'settings_component', onDone: function () { refreshSettings(); } }); }
            });

            api.addParam({
                component: 'lampa_watch',
                param: { name: 'lw_parser_rollback', type: 'button' },
                field: { name: TXT.rollback, description: TXT.rollbackNone },
                onRender: function (item) { settingItems.rollback = item; refreshSettings(); },
                onChange: doRollback
            });

            api.addParam({
                component: 'lampa_watch',
                param: { name: AUTO_KEY, type: 'trigger', default: true },
                field: { name: TXT.auto, description: TXT.autoDescr }
            });

            api.addParam({
                component: 'lampa_watch',
                param: { name: 'lw_prefetch', type: 'trigger', default: true },
                field: { name: TXT.prefetch, description: TXT.prefetchDescr }
            });

            if (!T) return;

            api.addParam({ component: 'lampa_watch', param: { name: 'lw_tune_title', type: 'title' }, field: { name: TXT.tuneTitle } });

            api.addParam({
                component: 'lampa_watch',
                param: { name: 'lw_tune_pick', type: 'button' },
                field: { name: TXT.tunePick, description: TXT.tunePickDescr },
                onRender: function (item) { settingItems.tune = item; refreshSettings(); },
                onChange: function () { openTune({ back: 'settings_component', onDone: function () { refreshSettings(); } }); }
            });

            api.addParam({
                component: 'lampa_watch',
                param: { name: 'lw_tune_rollback', type: 'button' },
                field: { name: TXT.tuneRollback, description: TXT.tuneRollbackNone },
                onRender: function (item) { settingItems.tuneRollback = item; refreshSettings(); },
                onChange: doTuneRollback
            });
        }

        // Раздел «Оформление» (бета). Он нужен и тогда, когда TorrServer-настройка недоступна, поэтому вызывается отдельно
        function addThemeSettings() {
            var api = window.Lampa.SettingsApi;

            if (api && LW.theme) LW.theme.addSettings(api);
        }

        function start() {
            try {
                addStyle();
                addSettings();
                addThemeSettings();
            } catch (e) {
                if (window.console) console.log('[lampa-watch] настройки: ' + e);
            }
        }

        if (window.appready) start();
        else window.Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });

        LW.setup = { openParserSetup: openParserSetup, repairParser: repairParser, openTune: openTune, autoOn: autoOn, start: start };
    });

})();
