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
