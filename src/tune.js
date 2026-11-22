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
