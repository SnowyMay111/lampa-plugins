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
