/*
 * Lampa Watch 1.1.0
 * Подбор лучшей раздачи, прогноз «будет ли лагать», автопереключение TorrServer.
 * Файл собран из src/ командой node build.js. Править нужно исходники, а не этот файл.
 */
(function () {
    'use strict';

    if (window.lampa_watch_bundle) return;
    window.lampa_watch_bundle = true;

    var LW = { version: '1.1.0' };

    // Каждый модуль в своей оболочке: сбой одного не мешает остальным
    function run(name, fn) {
        try { fn(LW); } catch (e) { if (window.console) console.log("[lampa-watch] модуль " + name + ": " + e); }
    }

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
                measure: measure
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
    });

})();
