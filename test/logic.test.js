// Проверка подбора раздач и прогноза скорости. Запуск: node test/logic.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = vm.createContext({ LW: {}, console, setTimeout, clearTimeout, Date, Math, JSON, parseInt, parseFloat, isNaN, RegExp, Object });

['speed.js', 'score.js', 'series.js', 'list.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f }));

const { score, speed, list, series } = ctx.LW;
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name + '\n      ' + e.message]); }
}

const GB = 1e9;
const fightClub = { original_title: 'Fight Club', title: 'Бойцовский клуб', release_date: '1999-10-15', runtime: 139, original_language: 'en' };
const R = (Title, gb, Seeders, Tracker) => ({ Title, Size: gb * GB, Seeders, Peers: Seeders + 5, Tracker: Tracker || 'RuTracker' });

const A = R('Fight Club / Бойцовский клуб (1999) UHD BDRemux 2160p HEVC HDR10 Dolby Vision | Dub, MVO, Original', 58, 40);
const B = R('Fight Club (1999) 2160p UHD BluRay x265 HDR10 Rus', 28, 12);
const C = R('Бойцовский клуб / Fight Club (1999) BDRip 1080p AVC Дубляж', 12, 150);
const D = R('Fight Club (1999) 4K WEB-DL 2160p SDR', 20, 2);
const E = R('Fight Club 2 (2022) WEB-DL 1080p', 6, 80);
const F = R('Fight Club (1999) CAMRip', 1.4, 300);
const G = R('Бойцовский клуб (1999) BDRip 720p Украинский дубляж', 4, 20);
const H = R('Fight Club (1999) 1080p 3D HSBS', 14, 60);
const I = R('Gone Girl (2014) 2160p HDR', 40, 100);
const ALL = [A, B, C, D, E, F, G, H, I];

(async () => {
    // ----------------------------------------------------------- разбор названий
    await test('разбор: 4K, HDR, Dolby Vision, ремукс, HEVC, дубляж, оригинал', () => {
        const i = score.parse(A.Title, fightClub);
        assert.strictEqual(i.quality, 2160);
        assert.ok(i.hdr && i.dv && i.dub && i.mvo && i.orig);
        assert.strictEqual(i.source, 'remux');
        assert.strictEqual(i.codec, 'hevc');
        assert.deepStrictEqual(plain(i.langs).sort(), ['en', 'ru']);
    });

    await test('разбор: HDRip и HDRezka не считаются HDR, DVO не считается Dolby Vision', () => {
        assert.strictEqual(score.parse('Movie 2020 HDRip 720p').hdr, false);
        assert.strictEqual(score.parse('Movie 2020 1080p HDRezka Studio').hdr, false);
        assert.strictEqual(score.parse('Movie 2020 1080p DVO').dv, false);
        assert.strictEqual(score.parse('Movie 2020 2160p HDR10+ DV').hdr, true);
        assert.strictEqual(score.parse('Movie 2020 2160p HDR10+ DV').dv, true);
    });

    await test('разбор: языки озвучки', () => {
        assert.deepStrictEqual(plain(score.parse('Фильм 2020 1080p Украинский дубляж').langs), ['uk']);
        assert.deepStrictEqual(plain(score.parse('Фильм 2020 1080p Дубляж').langs), ['ru']);
        assert.deepStrictEqual(plain(score.parse('Film 2020 1080p German DL').langs), ['de']);
        assert.deepStrictEqual(plain(score.parse('Фильм 2020 1080p Rus Ukr Eng').langs).sort(), ['en', 'ru', 'uk']);
        // оригинал = язык оригинала фильма
        assert.deepStrictEqual(plain(score.parse('Дарк S01 1080p Original', { original_language: 'de' }).langs), ['de']);
        assert.deepStrictEqual(plain(score.parse('Film 2020 1080p Original').langs), ['en']);
    });

    await test('разбор: сезоны', () => {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(score.parse('Dark S02 1080p').seasons)), { from: 2, to: 2 });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(score.parse('Тьма / Dark (Сезон: 1-3) 1080p').seasons)), { from: 1, to: 3 });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(score.parse('Тьма 2 сезон 1080p').seasons)), { from: 2, to: 2 });
        assert.strictEqual(score.parse('Dark S01E05 1080p').seasons.from, 1);
        assert.strictEqual(score.parse('Film 2020 1080p').seasons, null);
        assert.strictEqual(score.parse('Dark S01 [Серии: 1-8 из 8] 1080p').pack.complete, true);
        assert.strictEqual(score.parse('Dark S01 [Серии: 1-5 из 8] 1080p').pack.complete, false);
    });

    // ----------------------------------------------------------- подбор фильма
    await test('4K + HDR + Dolby Vision: выигрывает 4K ремукс с HDR и DV', () => {
        const r = score.pick(ALL, { quality: '2160', hdr: 'yes', dv: 'yes' }, fightClub);
        assert.strictEqual(r.best.item, A);
        assert.deepStrictEqual(plain(r.missed), []);
    });

    await test('нет 4K: берётся лучшая 1080p, и в missed видно, чего не нашлось', () => {
        const r = score.pick(ALL.filter((x) => x !== A && x !== B && x !== D), { quality: '2160', hdr: 'yes' }, fightClub);
        assert.strictEqual(r.best.item, C);
        assert.deepStrictEqual(plain(r.missed.map((m) => m.key)).sort(), ['hdr', 'quality']);
    });

    await test('есть 4K без HDR и 1080p с HDR: при желании «4K + HDR» берётся 4K', () => {
        const k4 = R('Fight Club (1999) 2160p WEB-DL x265 SDR', 25, 30);
        const hd = R('Fight Club (1999) 1080p BluRay HDR10 x265', 14, 30);
        const r = score.pick([k4, hd], { quality: '2160', hdr: 'yes' }, fightClub);
        assert.strictEqual(r.best.item, k4);
        assert.deepStrictEqual(plain(r.missed.map((m) => m.key)), ['hdr']);
    });

    await test('желаемая 1080p: выигрывает точная 1080p, а не тяжёлая 4K', () => {
        const r = score.pick(ALL, { quality: '1080' }, fightClub);
        assert.strictEqual(r.best.item, C);
    });

    await test('мусор не выбирается: CAM, 3D, чужой фильм, продолжение другого года', () => {
        const r = score.pick(ALL, { quality: '1080' }, fightClub);
        const places = r.ranked.map((e) => e.item);
        assert.ok(places.indexOf(E) > places.indexOf(C));
        assert.ok(places.indexOf(H) > places.indexOf(C));
        assert.ok(!r.playable.some((e) => e.item === F), 'CAM играбельный');
        assert.ok(!r.playable.some((e) => e.item === I), 'чужой фильм играбельный');
    });

    await test('раздача без раздающих не выбирается, даже если качество идеальное', () => {
        const dead = R('Fight Club (1999) 2160p HDR Dolby Vision Remux', 50, 0);
        const r = score.pick([dead, C], { quality: '2160', hdr: 'yes', dv: 'yes' }, fightClub);
        assert.strictEqual(r.best.item, C);
    });

    await test('если подходящих нет вообще, best = null', () => {
        assert.strictEqual(score.pick([F, I], {}, fightClub).best, null);
        assert.strictEqual(score.pick([], {}, fightClub).best, null);
    });

    await test('«без HDR» отодвигает HDR-раздачи', () => {
        const hdr = R('Fight Club (1999) 2160p BluRay HDR10 x265', 30, 60);
        const sdr = R('Fight Club (1999) 2160p BluRay SDR x265', 30, 60);
        assert.strictEqual(score.pick([hdr, sdr], { quality: '2160', hdr: 'no' }, fightClub).best.item, sdr);
    });

    // ----------------------------------------------------------- язык озвучки
    await test('язык озвучки: украинская 720p обходит русскую 1080p, когда выбран украинский', () => {
        const r = score.pick([C, G], { quality: '1080', lang: 'uk' }, fightClub);
        assert.strictEqual(r.best.item, G);
    });

    await test('язык озвучки: русский выбирает русскую раздачу, украинскую нет', () => {
        const r = score.pick([G, C], { quality: '1080', lang: 'ru' }, fightClub);
        assert.strictEqual(r.best.item, C);
    });

    await test('язык озвучки: английский, когда он вообще есть только в одной раздаче', () => {
        const en = R('Fight Club (1999) 1080p BluRay x264 English DTS', 10, 25, 'Rutor');
        assert.strictEqual(score.pick([C, en], { quality: '1080', lang: 'en' }, fightClub).best.item, en);
    });

    await test('язык озвучки: «оригинал» у японского фильма означает японский', () => {
        const anime = { original_title: 'Spirited Away', title: 'Унесённые призраками', release_date: '2001-07-20', runtime: 125, original_language: 'ja' };
        const ru = R('Унесённые призраками / Spirited Away (2001) BDRip 1080p Дубляж', 10, 50);
        const jp = R('Spirited Away (2001) BDRip 1080p Original Japanese + Sub', 10, 50);
        assert.strictEqual(score.pick([ru, jp], { quality: '1080', lang: 'orig' }, anime).best.item, jp);
    });

    await test('тип озвучки: при русском языке дубляж предпочтительнее многоголосой', () => {
        const dub = R('Fight Club (1999) BDRip 1080p Дубляж', 10, 40);
        const mvo = R('Fight Club (1999) BDRip 1080p MVO', 10, 40);
        assert.strictEqual(score.pick([mvo, dub], { quality: '1080', lang: 'ru', voice: 'dub' }, fightClub).best.item, dub);
        assert.strictEqual(score.pick([mvo, dub], { quality: '1080', lang: 'ru', voice: 'mvo' }, fightClub).best.item, mvo);
    });

    await test('субтитры по желанию выигрывают при прочих равных', () => {
        const a = R('Fight Club (1999) BDRip 1080p x264', 10, 40);
        const b = R('Fight Club (1999) BDRip 1080p x264 + Sub', 10, 40);
        assert.strictEqual(score.pick([a, b], { quality: '1080', subs: 'yes' }, fightClub).best.item, b);
    });

    // ----------------------------------------------------------- сериалы
    const dark = { name: 'Тьма', original_name: 'Dark', first_air_date: '2017-12-01', number_of_seasons: 3, episode_run_time: [55], original_language: 'de' };

    await test('сериал: выбирается раздача нужного сезона', () => {
        const s1 = R('Тьма / Dark (2017) S01 WEB-DL 1080p Rus', 30, 50);
        const s2 = R('Тьма / Dark (2019) S02 WEB-DL 1080p Rus', 30, 50);
        const s3 = R('Тьма / Dark (2020) S03 WEB-DL 1080p Rus', 30, 50);
        const r = score.pick([s1, s2, s3], { quality: '1080', season: 2 }, dark);
        assert.strictEqual(r.best.item, s2);
    });

    await test('сериал: пакет «Сезон: 1-3» подходит под второй сезон, а раздача другого сезона нет', () => {
        const all = R('Тьма / Dark (2017-2020) (Сезон: 1-3) WEB-DL 1080p', 90, 30);
        const s1 = R('Тьма / Dark (2017) S01 WEB-DL 1080p', 30, 90);
        const r = score.pick([s1, all], { quality: '1080', season: 2 }, dark);
        assert.strictEqual(r.best.item, all);
    });

    await test('сериал: год раздачи не сверяется с годом выхода сериала', () => {
        const s3 = R('Тьма / Dark (2020) S03 WEB-DL 1080p', 30, 50);
        assert.strictEqual(score.pick([s3], { quality: '1080', season: 3 }, dark).best.item, s3);
    });

    await test('сериал: полный сезон (серии 1-8 из 8) лучше неполного', () => {
        const full = R('Тьма / Dark S01 [Серии: 1-8 из 8] WEB-DL 1080p', 30, 40);
        const part = R('Тьма / Dark S01 [Серии: 1-5 из 8] WEB-DL 1080p', 20, 40);
        assert.strictEqual(score.pick([part, full], { quality: '1080', season: 1 }, dark).best.item, full);
    });

    await test('фильм: раздача сериала с S01 не выбирается как фильм', () => {
        const serial = R('Fight Club (1999) S01E01 1080p', 2, 100);
        assert.strictEqual(score.pick([serial, C], { quality: '1080' }, fightClub).best.item, C);
    });

    // ----------------------------------------------------------- прогноз скорости
    await test('нужный битрейт: 12 ГБ на 139 минут около 11,5 Мбит/с', () => {
        assert.ok(Math.abs(speed.need(12, 1080, fightClub) - 11.5) < 0.2);
    });

    await test('нужный битрейт у сериала: типичный для качества, а не по размеру пакета', () => {
        assert.strictEqual(speed.need(90, 1080, { name: 'X', runtime: 50 }), speed.TYPICAL[1080]);
    });

    await test('вердикт: плавно, на грани, лагает, не рекомендую', () => {
        assert.strictEqual(speed.verdict(30, 12, 139).level, 'smooth');
        assert.strictEqual(speed.verdict(15, 12, 139).level, 'edge');
        assert.strictEqual(speed.verdict(9, 12, 139).level, 'lag');
        assert.strictEqual(speed.verdict(3, 12, 139).level, 'bad');
        assert.strictEqual(speed.verdict(undefined, 12, 139).level, 'unknown');
    });

    await test('вердикт: сколько ждать, чтобы потом смотреть без пауз', () => {
        const v = speed.verdict(8, 10, 100); // отношение 0,8: нужно накопить 25% длины
        assert.strictEqual(v.waitMin, 25);
        assert.strictEqual(speed.verdict(20, 10, 100).waitMin, 0);
    });

    await test('прикидка: 10 раздающих около 8 Мбит/с, потолок по линии', () => {
        assert.strictEqual(speed.estimate(10), 8);
        assert.strictEqual(speed.estimate(1000), 100);
        assert.strictEqual(speed.estimate(1000, 30), 30);
        assert.strictEqual(speed.estimate(0), 0);
    });

    await test('прогноз по прикидке отражён в записи: у тяжёлого ремукса с 40 раздающими риск лагов', () => {
        const e = score.evaluate(A, {}, fightClub);
        assert.ok(e.forecast.level === 'bad' || e.forecast.level === 'lag');
        assert.ok(e.parts.some((p) => p.key === 'lag'));
        const light = score.evaluate(C, {}, fightClub);
        assert.strictEqual(light.forecast.level, 'smooth');
    });

    await test('известная скорость линии учитывается в прикидке', () => {
        const slow = score.evaluate(C, { line: 5 }, fightClub);
        const fast = score.evaluate(C, { line: 200 }, fightClub);
        assert.ok(slow.est < fast.est);
        assert.ok(slow.score < fast.score);
    });

    await test('подсказки: при плохом вердикте есть «взять полегче», при плавном подсказок нет', () => {
        const bad = speed.tips(speed.verdict(3, 12, 139), { seeders: 2, peers: 3, need: 50 });
        assert.deepStrictEqual(plain(bad.slice(0, 3)), ['fewSeeds', 'fewPeers', 'lighter']);
        assert.ok(bad.indexOf('wired') >= 0 && bad.indexOf('otherDownloads') >= 0);
        assert.deepStrictEqual(plain(speed.tips(speed.verdict(30, 12, 139), {})), []);
        assert.ok(speed.tips(speed.verdict(10, 12, 139), {}).indexOf('wait') >= 0);
    });

    await test('лёгкая раздача: самая высокая по оценке из тех, что потянет замеренная скорость', () => {
        const ranked = score.rank(ALL, { quality: '2160', hdr: 'yes', dv: 'yes' }, fightClub);
        const current = ranked.filter((e) => e.item === A)[0];
        const l = speed.lighter(ranked, 20, current);
        assert.ok(l && l !== current && l.need * 1.3 <= 20);
        assert.ok(l.playable && l.relevance > 0);
    });

    await test('лёгкая раздача: если ничего не тянет, берётся самая лёгкая, а не ничего', () => {
        const ranked = score.rank([A, C], {}, fightClub);
        const current = ranked.filter((e) => e.item === A)[0];
        assert.strictEqual(speed.lighter(ranked, 1, current).item, C);
    });

    // ----------------------------------------------------------- замер
    await test('замер: усредняет скорость после разогрева и переводит в Мбит/с', async () => {
        const calls = [];
        const get = (url, ok) => { calls.push(url); setTimeout(() => ok({ download_speed: 5e6, active_peers: 12, connected_seeders: 7, preloaded_bytes: 10, preload_size: 1000 }), 1); };
        const res = await new Promise((done) => speed.measure({ url: 'http://s/stream/x?link=h&index=1&preload', get, duration: 160, interval: 15, warmup: 40 }, done));
        assert.ok(res.ok);
        assert.strictEqual(res.avgMbps, 40);
        assert.strictEqual(res.peers, 12);
        assert.strictEqual(res.seeders, 7);
        assert.strictEqual(res.reason, 'time');
        assert.ok(calls[0].indexOf('&preload') > 0, 'первый запрос запускает предзагрузку');
        assert.ok(calls.slice(1).every((u) => u.indexOf('&stat') > 0 && u.indexOf('&preload') < 0), 'дальше только статистика');
    });

    await test('замер: заканчивается сразу, когда начало файла уже загружено', async () => {
        const get = (url, ok) => setTimeout(() => ok({ download_speed: 2e6, preloaded_bytes: 99, preload_size: 100 }), 1);
        const res = await new Promise((done) => speed.measure({ url: 'u&preload', get, duration: 5000, interval: 10, warmup: 0 }, done));
        assert.strictEqual(res.reason, 'preloaded');
    });

    await test('замер: ошибки сети не роняют, в итоге ok=false', async () => {
        const get = (url, ok, fail) => setTimeout(fail, 1);
        const res = await new Promise((done) => speed.measure({ url: 'u&preload', get, duration: 60, interval: 10 }, done));
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'error');
    });

    await test('замер: отмена останавливает опрос и отдаёт результат ровно один раз', async () => {
        let n = 0;
        let finished = 0;
        const get = (url, ok) => { n++; setTimeout(() => ok({ download_speed: 1e6 }), 1); };
        const cancel = speed.measure({ url: 'u&preload', get, duration: 5000, interval: 10 }, () => { finished++; });
        await sleep(35);
        cancel();
        const after = n;
        await sleep(60);
        assert.strictEqual(finished, 1);
        assert.strictEqual(n, after);
    });

    await test('замер: быстрая загрузка даёт скорость и по объёму, если сэмплов мало', async () => {
        const get = (url, ok) => setTimeout(() => ok({ download_speed: 0, preloaded_bytes: 50e6, preload_size: 50e6 }), 1);
        const res = await new Promise((done) => speed.measure({ url: 'u&preload', get, duration: 5000, interval: 10, warmup: 0 }, done));
        assert.ok(res.ok && res.avgMbps > 0);
    });


    // ----------------------------------------------------------- список: сортировка, фильтры, статистика
    const listed = () => score.rank(ALL.map((x, n) => Object.assign({}, x, { PublishDate: '2026-0' + (1 + (n % 9)) + '-1' + n + 'T10:00:00Z' })), score.DEFAULT_WISHES, fightClub);
    const titles = (arr) => arr.map((e) => e.item.Title.slice(0, 22));

    await test('список: мусор (камрип, 3D-«чужой», другой фильм) по умолчанию скрыт', () => {
        const all = listed();
        const shown = list.visible(all, false);
        assert.ok(shown.length < all.length);
        assert.ok(shown.every((e) => e.playable && e.relevance > 0));
        assert.strictEqual(list.visible(all, true).length, all.length);
        assert.ok(!shown.some((e) => /CAMRip/.test(e.item.Title)));
    });

    await test('список: сортировка по раздающим, размеру, названию, источнику, дате, просмотренным', () => {
        const all = listed();
        const bySeeds = list.sort(all, 'seeds');
        assert.ok(bySeeds.every((e, i) => i === 0 || bySeeds[i - 1].seeds >= e.seeds));
        const bySize = list.sort(all, 'size');
        assert.ok(bySize.every((e, i) => i === 0 || bySize[i - 1].gb >= e.gb));
        const byName = list.sort(all, 'name');
        assert.ok(byName.every((e, i) => i === 0 || byName[i - 1].item.Title.toLowerCase() <= e.item.Title.toLowerCase()));
        const byDate = list.sort(all, 'date');
        assert.ok(byDate.every((e, i) => i === 0 || Date.parse(byDate[i - 1].item.PublishDate) >= Date.parse(e.item.PublishDate)));

        const marked = all.map((e, i) => { e.item.viewed = i === 3; return e; });
        assert.strictEqual(list.sort(marked, 'viewed')[0], marked[3]);

        // без ключа и с неизвестным ключом — порядок рейтинга
        assert.deepStrictEqual(titles(list.sort(all, 'best')), titles(all));
        assert.deepStrictEqual(titles(list.sort(all, 'нет такого')), titles(all));
    });

    await test('список: сортировка не меняет исходный массив и устойчива при равных значениях', () => {
        const all = listed();
        const before = titles(all);
        list.sort(all, 'tracker');
        assert.deepStrictEqual(titles(all), before);
        // все раздачи с одного трекера: порядок по раздающим, затем по месту
        const same = list.sort(all.filter((e) => e.item.Tracker === 'RuTracker'), 'tracker');
        assert.ok(same.every((e, i) => i === 0 || same[i - 1].seeds >= e.seeds));
    });

    await test('список: фильтры по качеству, HDR, Dolby Vision, озвучке, языку, трекеру, году', () => {
        const all = listed();
        const q = list.filter(all, { quality: '2160' });
        assert.ok(q.length >= 3 && q.every((e) => e.info.quality === 2160));
        const hdr = list.filter(all, { hdr: 'yes' });
        assert.ok(hdr.length && hdr.every((e) => e.info.hdr));
        assert.ok(list.filter(all, { dv: 'yes' }).every((e) => e.info.dv));
        assert.ok(list.filter(all, { voice: 'dub' }).every((e) => e.info.dub));
        assert.ok(list.filter(all, { lang: 'uk' }).every((e) => e.info.langs.indexOf('uk') >= 0));
        assert.ok(list.filter(all, { d3: 'yes' }).every((e) => e.info.d3));
        assert.ok(list.filter(all, { year: '2022' }).every((e) => e.info.years.indexOf(2022) >= 0));
        // несколько фильтров сразу: пересечение
        const both = list.filter(all, { quality: '2160', hdr: 'yes', dv: 'yes' });
        assert.ok(both.length >= 1 && both.every((e) => e.info.quality === 2160 && e.info.hdr && e.info.dv));
        // пустые значения не фильтруют
        assert.strictEqual(list.filter(all, { quality: null, hdr: '' }).length, all.length);
        assert.strictEqual(list.activeCount({ quality: '2160', hdr: null, dv: '' }), 1);
    });

    await test('список: сезоны раздачи с диапазоном попадают в каждый свой сезон', () => {
        const pack = score.evaluate({ Title: 'Dark / Тьма (Сезон: 1-3) 1080p', Size: 30 * GB, Seeders: 20, Peers: 25, Tracker: 'Kinozal' }, score.DEFAULT_WISHES, { original_name: 'Dark', name: 'Тьма', first_air_date: '2017-12-01', number_of_seasons: 3 });
        assert.deepStrictEqual(plain(list.valuesOf(pack, 'season')), ['1', '2', '3']);
        assert.strictEqual(list.filter([pack], { season: '2' }).length, 1);
        assert.strictEqual(list.filter([pack], { season: '4' }).length, 0);
        const huge = score.evaluate({ Title: 'Show (Сезон: 1-999) 1080p', Size: 30 * GB, Seeders: 5, Peers: 5, Tracker: 'x' }, score.DEFAULT_WISHES, {});
        assert.ok(list.valuesOf(huge, 'season').length <= 60);
    });

    await test('список: варианты фильтра с числом раздач, «не указано» в конце', () => {
        const f = list.facets(listed());
        assert.strictEqual(f.quality[0].value, '2160'); // лучшее качество первым
        const total = f.quality.reduce((n, v) => n + v.count, 0);
        assert.strictEqual(total, ALL.length);
        assert.deepStrictEqual(plain(f.hdr.map((v) => v.value)), ['yes', 'no']);
        assert.strictEqual(f.year[f.year.length - 1].value === '?' || f.year[0].value >= f.year[f.year.length - 1].value, true);
        assert.strictEqual(list.valueLabel('quality', '2160'), '4K');
        assert.strictEqual(list.valueLabel('voice', 'dub'), 'Дубляж');
        assert.strictEqual(list.valueLabel('lang', 'uk', { uk: 'Украинский' }), 'Украинский');
        assert.strictEqual(list.valueLabel('season', '2'), 'Сезон 2');
        assert.strictEqual(list.valueLabel('hdr', 'no'), 'Нет');
        assert.strictEqual(list.valueLabel('tracker', '?'), 'Не указано');
    });

    await test('список: сводка для шапки (качество, HDR, трекеры, раздающие, размеры)', () => {
        const shown = list.visible(listed(), false);
        const s = list.summary(shown);
        assert.strictEqual(s.count, shown.length);
        assert.strictEqual(s.quality[0].value, '2160');
        assert.ok(s.hdr >= 2 && s.dv >= 1 && s.dub >= 1);
        assert.strictEqual(s.maxSeeds, Math.max.apply(null, shown.map((e) => e.seeds)));
        assert.ok(s.medianSeeds > 0 && s.medianSeeds <= s.maxSeeds);
        assert.ok(s.minGb > 0 && s.maxGb >= s.minGb);
        assert.ok(s.trackers[0].value === 'RuTracker' && s.trackers[0].count === shown.length);
        const empty = list.summary([]);
        assert.strictEqual(empty.count, 0);
        assert.strictEqual(empty.maxGb, 0);
        assert.deepStrictEqual(plain(empty.quality), []);
    });

    await test('список: дата в виде дд.мм.гггг и пустая строка, если даты нет', () => {
        const e = score.evaluate(Object.assign({}, A, { PublishDate: '2026-03-07T10:00:00Z' }), score.DEFAULT_WISHES, fightClub);
        assert.ok(/^\d{2}\.03\.2026$/.test(list.dateLabel(e)) || /^\d{2}\.\d{2}\.2026$/.test(list.dateLabel(e)));
        assert.strictEqual(list.dateLabel(score.evaluate(A, score.DEFAULT_WISHES, fightClub)), '');
    });

    // ----------------------------------------------------------- запас перед стартом
    await test('запас: скорости хватает, запас не нужен; не хватает, считаем объём и ожидание', () => {
        assert.strictEqual(speed.reserve(12, 10, 100).needed, false);
        assert.strictEqual(speed.reserve(0, 10, 100).needed, false);
        assert.strictEqual(speed.reserve(8, 10.4, 0).needed, false, 'без длины фильма не гадаем');

        const r = speed.reserve(8, 10, 100);
        // недобор 2 Мбит/с * 6000 с * 125000 Б * 1,1 запаса на колебания
        assert.strictEqual(r.needed, true);
        assert.strictEqual(r.bytes, Math.round(2 * 6000 * 125000 * 1.1));
        assert.strictEqual(r.waitSec, Math.ceil(r.bytes / (8 * 125000)));
        assert.strictEqual(r.waitMin, Math.round(r.waitSec / 60));
        assert.strictEqual(r.feasible, true);
    });

    await test('запас: ждать дольше часа бессмысленно, такой запас не предлагаем', () => {
        const r = speed.reserve(2, 10, 100);

        assert.strictEqual(r.needed, true);
        assert.strictEqual(r.feasible, false);
        assert.ok(r.waitMin > 60);
    });

    await test('запас: сервер копит не больше своей предзагрузки, это ограничение честно возвращается', () => {
        assert.deepStrictEqual(plain(speed.reserveTarget(4e9, 0)), { bytes: 4e9, capped: false });
        assert.deepStrictEqual(plain(speed.reserveTarget(4e9, 1e12)), { bytes: 4e9, capped: false });
        assert.deepStrictEqual(plain(speed.reserveTarget(4e9, 1e9)), { bytes: 1e9, capped: true });
    });

    const fakeGet = (seq) => {
        let i = 0;
        const calls = [];

        return { calls, get: (url, ok) => { calls.push(url); const r = seq[Math.min(i++, seq.length - 1)]; setTimeout(() => ok(r), 1); } };
    };

    await test('накопление: опрашивает &stat, считает процент и скорость, по готовности говорит «ready»', async () => {
        const g = fakeGet([
            { preloaded_bytes: 1e9, preload_size: 1e12, download_speed: 2e6, active_peers: 10 },
            { preloaded_bytes: 2e9, preload_size: 1e12, download_speed: 2e6, active_peers: 12 },
            { preloaded_bytes: 4.1e9, preload_size: 1e12, download_speed: 2e6, active_peers: 12 }
        ]);
        const seen = [];
        const out = await new Promise((done) => speed.accumulate({ url: 'http://ts/stream/x?link=A&index=1&preload', get: g.get, targetBytes: 4e9, interval: 2 }, done, (s) => seen.push(plain(s))));

        assert.strictEqual(out.reason, 'ready');
        assert.ok(g.calls.every((u) => u.indexOf('&stat') > 0 && u.indexOf('&preload') < 0), g.calls.join(' '));
        assert.strictEqual(seen[0].pct, 25);
        assert.strictEqual(seen[1].pct, 50);
        assert.strictEqual(seen[0].mbps, 16);
        assert.ok(seen[0].etaSec > 0);
    });

    await test('накопление: предел предзагрузки сервера ниже нужного, копим до предела и говорим об этом', async () => {
        const g = fakeGet([{ preloaded_bytes: 9.9e8, preload_size: 1e9, download_speed: 1e6, active_peers: 5 }]);
        const seen = [];
        const out = await new Promise((done) => speed.accumulate({ url: 'u&preload', get: g.get, targetBytes: 4e9, interval: 2 }, done, (s) => seen.push(plain(s))));

        assert.strictEqual(out.reason, 'ready');
        assert.strictEqual(out.capped, true);
        assert.strictEqual(out.target, 1e9);
        assert.strictEqual(seen[0].capped, true);
    });

    await test('накопление: перестало расти (застой), вышло время, отмена', async () => {
        const stuck = fakeGet([{ preloaded_bytes: 1e8, preload_size: 1e12, download_speed: 1e6, active_peers: 3 }]);
        const a = await new Promise((done) => speed.accumulate({ url: 'u&preload', get: stuck.get, targetBytes: 4e9, interval: 2, stallMs: 30 }, done));

        assert.strictEqual(a.reason, 'stalled');
        assert.strictEqual(a.preloaded, 1e8);

        let n = 0;
        const slow = { get: (url, ok) => setTimeout(() => ok({ preloaded_bytes: ++n * 1e6, preload_size: 1e12, download_speed: 1e6, active_peers: 3 }), 1) };
        const b = await new Promise((done) => speed.accumulate({ url: 'u&preload', get: slow.get, targetBytes: 4e9, interval: 2, maxMs: 40, stallMs: 1e6 }, done));

        assert.strictEqual(b.reason, 'time');

        let cancel;
        const c = await new Promise((done) => { cancel = speed.accumulate({ url: 'u&preload', get: slow.get, targetBytes: 4e9, interval: 2, maxMs: 1e6, stallMs: 1e6 }, done); setTimeout(() => cancel(), 10); });

        assert.strictEqual(c.reason, 'cancel');
    });

    await test('накопление: нет ответов от сервера, ждём до конца времени, а не падаем', async () => {
        const dead = { get: (url, ok, fail) => setTimeout(fail, 1) };
        const out = await new Promise((done) => speed.accumulate({ url: 'u&preload', get: dead.get, targetBytes: 4e9, interval: 2, maxMs: 30 }, done));

        assert.strictEqual(out.reason, 'time');
    });

    // ----------------------------------------------------------- сериал: следующая серия
    await test('сериал: серия не досмотрена, предлагаем её же; досмотрена, следующую; конец сезона, ничего', () => {
        const rec = { season: 2, episode: 6 };

        assert.deepStrictEqual(plain(series.step(rec, 40, 8)), { season: 2, episode: 6, resume: true });
        assert.deepStrictEqual(plain(series.step(rec, 90, 8)), { season: 2, episode: 7, resume: false });
        assert.strictEqual(series.step({ season: 2, episode: 8 }, 100, 8), null);
        assert.deepStrictEqual(plain(series.step({ season: 2, episode: 8 }, 100, 0)), { season: 2, episode: 9, resume: false }, 'число серий неизвестно, предлагаем следующую');
        assert.strictEqual(series.step(null, 100, 8), null);
        assert.strictEqual(series.step({ season: 1, episode: 0 }, 100, 8), null);
    });

    await test('сериал: подпись на кнопке', () => {
        assert.strictEqual(series.label({ episode: 7, resume: false }), 'Серия 7 · та же раздача');
        assert.strictEqual(series.label({ episode: 6, resume: true }), 'Серия 6 · продолжить · та же раздача');
    });

    await test('сериал: из записи парсера в хранилище попадают только простые поля', () => {
        const el = { Title: 'Dark S02', Size: 3e10, Seeders: 5, viewed: true, fn() {}, nested: { a: 1 }, list: [1, 2] };
        const out = plain(series.slim(el));

        assert.deepStrictEqual(out, { Title: 'Dark S02', Size: 3e10, Seeders: 5, viewed: true });
    });

    results.forEach(([ok, name]) => console.log((ok ? 'PASS  ' : 'FAIL  ') + name));
    const failed = results.filter((r) => !r[0]).length;
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
