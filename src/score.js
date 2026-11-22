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
