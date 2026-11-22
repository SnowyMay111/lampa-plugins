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

var STORE_WISHES = 'lw_wishes';
var STORE_LINE = 'lw_line_peak';
var CFG = window.lampa_watch_config || {}; // для тестов: сокращает паузы
var PENDING_TTL = 110000; // дольше этого торрент не ждём: Лампа сама сдаётся через 90 секунд
var MEASURE_MS = CFG.measureMs || 12000;
var WARMUP_MS = CFG.warmup === undefined ? 3000 : CFG.warmup;
var TICK_MS = CFG.interval || 1000;
var SETTLE_MS = CFG.settle === undefined ? 150 : CFG.settle;

var pending = null;       // запуск, начатый нами: ждём список файлов и нажимаем нужный
var cancelMeasure = null; // остановить идущий замер
var runId = 0;            // номер поиска: поздний ответ отменённого поиска игнорируется

// ---------------------------------------------------------------- тексты и варианты

var TXT = {
    button: 'Лучшая раздача',
    wishesTitle: 'Что хотим смотреть',
    go: 'Найти и смотреть',
    showList: 'Показать список',
    searching: 'Ищу раздачи',
    searchingSub: 'Парсер собирает раздачи, потом я выберу лучшую',
    nothing: 'Ничего не нашлось',
    nothingSub: 'Парсер ничего не вернул или все раздачи не подошли. Попробуйте поменять пожелания или откройте обычный список.',
    parserError: 'Парсер не ответил',
    best: 'Лучшая раздача',
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
    cancel: 'Отмена'
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
    otherDownloads: function () { return 'Закройте другие загрузки и VPN на компьютере с TorrServer: они забирают скорость.'; }
};

// ---------------------------------------------------------------- вспомогательное

function L() {
    return window.Lampa;
}

function log(msg) {
    try { if (window.console) console.log('[lampa-watch] ' + msg); } catch (e) {}
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

function searchObject(movie, season) {
    var s = searchText(movie, season);

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
        '.lw-bar{height:.5em;border-radius:.25em;background:rgba(255,255,255,.12);overflow:hidden;margin:.9em 0}',
        '.lw-bar i{display:block;height:100%;width:0;background:#2f6fe4;transition:width .4s}',
        '.lw-live{font-size:1.1em;line-height:1.6}'
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
}

// ---------------------------------------------------------------- пожелания

function openWishes(movie) {
    var w = loadWishes();
    var tv = SP.isTv(movie);
    var seasons = tv ? seasonList(movie) : [];
    var box = h('div', 'lw-box');
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
            { name: TXT.showList, onSelect: function () { saveWishes(w); openStandardList(movie, w.season); } }
        ],
        onBack: function () { closeModal(); backToContent(); }
    });
}

// ---------------------------------------------------------------- поиск

function findAndWatch(movie, w) {
    var my = ++runId;
    var started = new Date().getTime();

    saveWishes(w);

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
        showNothing(movie, w, text);
    }

    try {
        L().Parser.get(searchObject(movie, w.season), function (json) {
            if (my !== runId) return;

            var picked = S.pick((json && json.Results) || [], w, movie);

            picked.seconds = Math.round((new Date().getTime() - started) / 1000);

            closeModal();

            if (!picked.best) return showNothing(movie, w, '');

            if (w.instant) {
                noty('Выбрано: ' + briefOf(picked.best));
                return launch(movie, picked, picked.best);
            }

            showResult(movie, picked, picked.best);
        }, function (err) {
            fail(TXT.parserError + (err ? ': ' + shortText(err, 120) : ''));
        });
    } catch (e) {
        log('Parser.get: ' + e);
        fail(TXT.parserError);
    }
}

function showNothing(movie, w, text) {
    var box = h('div', 'lw-box');

    box.append(h('div', 'lw-title', text || TXT.nothing));
    box.append(h('div', 'lw-line', TXT.nothingSub));

    openModal({
        title: '',
        html: box,
        buttons: [
            { name: TXT.changeWishes, onSelect: function () { closeModal(); openWishes(movie); } },
            { name: TXT.showList, onSelect: function () { openStandardList(movie, w.season); } }
        ],
        onBack: function () { closeModal(); backToContent(); }
    });
}

// ---------------------------------------------------------------- результат

function showResult(movie, picked, entry) {
    var box = h('div', 'lw-box');
    var badges = h('div', 'lw-badges');

    box.append(h('div', 'lw-kicker', TXT.best));
    box.append(h('div', 'lw-title', shortText(entry.item.Title, 140)));

    badgesOf(entry).forEach(function (b) { badges.append(h('span', 'lw-badge' + (b.hot ? ' lw-badge--hot' : ''), b.t)); });
    box.append(badges);

    box.append(h('div', 'lw-line', (S.formatSize(entry.item.Size) || '?') + ' · раздающих ' + entry.seeds + ' · ' + (entry.item.Tracker || '?')));
    box.append(forecastBlock(entry));
    box.append(checksBlock(entry, picked));

    var miss = entry === picked.best ? missedText(picked) : '';

    if (miss) box.append(h('div', 'lw-note', miss));

    box.append(h('div', 'lw-stats', statsLine(picked.stats) + '. Поиск занял ' + (picked.seconds || 0) + ' с.'));

    var buttons = [
        { name: TXT.launch, onSelect: function () { closeModal(); launch(movie, picked, entry); } }
    ];

    if (picked.playable.length > 1) buttons.push({ name: TXT.others, onSelect: function () { showOthers(movie, picked, entry); } });

    buttons.push({ name: TXT.changeWishes, onSelect: function () { closeModal(); openWishes(movie); } });
    buttons.push({ name: TXT.showList, onSelect: function () { openStandardList(movie, picked.wishes.season); } });

    openModal({ title: '', html: box, buttons: buttons, onBack: function () { closeModal(); backToContent(); } });
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

// ---------------------------------------------------------------- запуск

function launch(movie, picked, entry) {
    var Torrent = L().Torrent;

    if (!Torrent || !Torrent.start) {
        noty('В этой версии Лампы нет запуска торрентов');
        return;
    }

    var element = entry.item;

    element.poster = movie.img;

    pending = { time: new Date().getTime(), movie: movie, picked: picked, entry: entry, wishes: picked.wishes, target: null, started: false };

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
        noty('Скорость измерить не удалось, запускаю как есть');
        return play(item);
    }

    var v = SP.verdict(res.avgMbps, entry.need, SP.runtimeMin(p.movie));

    if (v.level === 'smooth') {
        noty('Скорость ' + res.avgMbps + ' Мбит/с при нужных ' + entry.need + ': пойдёт плавно');
        return play(item);
    }

    showVerdict(p, element, item, res, v);
}

function showVerdict(p, element, item, res, v) {
    var entry = p.entry;
    var info = VERDICT[v.level] || VERDICT.unknown;
    var box = h('div', 'lw-box');
    var verdictBox = h('div', 'lw-verdict lw-verdict--' + info.cls);

    verdictBox.append(h('b', '', info.mark + ' ' + info.head));
    verdictBox.append(h('div', '', 'Скорость ' + res.avgMbps + ' Мбит/с (пик ' + res.maxMbps + '), фильму нужно около ' + entry.need + '. Подключено узлов: ' + res.peers + ', раздающих: ' + res.seeders + '.'));

    box.append(h('div', 'lw-title', shortText(entry.item.Title, 110)));
    box.append(verdictBox);

    var tipKeys = SP.tips(v, { seeders: res.seeders, peers: res.peers, need: entry.need, have: res.avgMbps });
    var tips = $('<ul class="lw-tips"></ul>');

    tipKeys.slice(0, 4).forEach(function (k) {
        if (TIPS[k]) tips.append(h('li', '', TIPS[k](v)));
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
    } catch (e) {
        log('start: ' + e);
    }
}

if (window.appready) start();
else window.Lampa.Listener.follow('app', function (e) {
    if (e.type === 'ready') start();
});

LW.watch = { start: start, openWishes: openWishes, addButton: addButton };
