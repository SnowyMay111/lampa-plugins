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
