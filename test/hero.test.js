// Проверка героя главной: подмена функции Лампы, разметка, смена кадра, выключение
// Запуск: NODE_PATH=<папка с node_modules, где есть jsdom> node test/hero.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'hero.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
    const dom = new JSDOM('<!doctype html><html><body><div class="wrap__content"><div class="activitys"></div></div></body></html>');
    const win = dom.window;
    const calls = { bg: [], blur: [] };
    const listeners = [];
    const loads = [];
    const state = { component: 'main' };
    const pushes = [];
    const notes = [];
    const favs = { book: false, calls: [] };
    const ctrl = { active: 'items_line', log: [], controllers: {}, set: null, focus: null };

    // Картинки в jsdom не грузятся: подставляем свою, которая «догружается» по команде теста
    function FakeImage() {
        const self = this;

        Object.defineProperty(self, 'src', { set: (v) => { self.url = v; loads.push(self); } });
    }

    win.Lampa = {
        Utils: {
            cardImgBackground: function (d) { calls.bg.push(d); return 'bg:' + d.id; },
            cardImgBackgroundBlur: function (d) { calls.blur.push(d); return 'blur:' + d.id; }
        },
        Activity: { active: () => ({ component: state.component }), push: (o) => pushes.push(o) },
        Favorite: { check: () => ({ book: favs.book }), toggle: (where, card) => { favs.calls.push([where, card.id]); favs.book = !favs.book; return favs.book; } },
        Noty: { show: (t) => notes.push(t) },
        Controller: {
            add: (n, o) => { ctrl.controllers[n] = o; },
            toggle: (n) => { ctrl.active = n; ctrl.log.push(n); },
            enabled: () => ({ name: ctrl.active }),
            collectionSet: (el) => { ctrl.set = el; },
            collectionFocus: (t) => { ctrl.focus = t; }
        },
        Listener: { follow: (name, fn) => listeners.push({ name, fn }) },
        TMDB: { image: (u) => 'https://img.test/' + u }
    };

    const LW = {};

    new Function('LW', 'window', 'document', 'Image', CODE)(LW, win, win.document, FakeImage);
    LW.hero.delay = 5;

    return { LW, H: LW.hero, win, doc: win.document, body: win.document.body, U: win.Lampa.Utils, calls, listeners, loads, state, pushes, notes, favs, ctrl, C: win.Lampa.Controller };
}

const movie = { id: 1, title: 'Сердце зверя', overview: 'Описание фильма', vote_average: 7.94, release_date: '2026-11-01', backdrop_path: '/a.jpg' };
const serial = { id: 2, name: 'Сериал', overview: 'Про сериал', vote_average: 8.1, first_air_date: '2024-05-05', backdrop_path: '/b.jpg', media_type: 'tv' };

const results = [];

async function test(name, fn) {
    try {
        await fn();
        results.push([true, name]);
    } catch (e) {
        results.push([false, name + '\n      ' + (e && e.stack || e)]);
    }
}

(async function () {
    await test('включение: обе функции Лампы работают как раньше и возвращают то же самое', () => {
        const e = makeEnv();

        e.H.on();
        assert.strictEqual(e.U.cardImgBackground(movie), 'bg:1');
        assert.strictEqual(e.U.cardImgBackgroundBlur(serial), 'blur:2');
        assert.strictEqual(e.calls.bg.length, 1);
        assert.strictEqual(e.calls.blur.length, 1);
    });

    await test('повторное включение не оборачивает функцию второй раз', () => {
        const e = makeEnv();

        e.H.on();

        const first = e.U.cardImgBackground;

        e.H.on();
        assert.strictEqual(e.U.cardImgBackground, first);
        e.U.cardImgBackground(movie);
        assert.strictEqual(e.calls.bg.length, 1, 'исходная функция вызвана один раз');
    });

    await test('главная: герой появляется перед рядами, на body класс lw-home, тексты на месте', async () => {
        const e = makeEnv();

        e.H.on();
        assert.ok(e.body.classList.contains('lw-home'));
        e.U.cardImgBackground(movie);
        await sleep(30);

        const hero = e.doc.querySelector('.lw-hero');

        assert.ok(hero, 'герой создан');
        assert.strictEqual(hero.nextElementSibling.className, 'activitys', 'стоит прямо перед рядами');
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, 'Сердце зверя');
        assert.strictEqual(e.doc.querySelector('.lw-hero__kicker').textContent, 'Фильм · 2026');
        assert.strictEqual(e.doc.querySelector('.lw-hero__desc').textContent, 'Описание фильма');
        assert.strictEqual(e.doc.querySelector('.lw-hero__chip').textContent, '★ 7.9');
    });

    await test('сериал: подпись «Сериал · год»', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(serial);
        await sleep(30);
        assert.strictEqual(e.doc.querySelector('.lw-hero__kicker').textContent, 'Сериал · 2024');
    });

    await test('пока фокус бежит по карточкам, рисуется только последняя', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        e.U.cardImgBackground(serial);
        await sleep(30);
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, 'Сериал');
        assert.strictEqual(e.loads.length, 1, 'кадр грузится один, не по каждой карточке');
    });

    await test('та же карточка второй раз ничего не перерисовывает', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        await sleep(30);
        e.doc.querySelector('.lw-hero__title').textContent = 'метка';
        e.U.cardImgBackground(movie);
        await sleep(30);
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, 'метка');
    });

    await test('не главная: герой не рисуется, класс lw-home снимается', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        await sleep(30);
        assert.ok(e.body.classList.contains('lw-home'));

        e.state.component = 'full';
        e.U.cardImgBackground(serial);
        await sleep(30);
        assert.ok(!e.body.classList.contains('lw-home'), 'класс снят');
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, 'Сердце зверя', 'тексты не тронуты');
    });

    await test('разделы с рядами (Фильмы, Сериалы, Мультфильмы) тоже получают героя, а сетки и поиск нет', async () => {
        const e = makeEnv();

        e.H.on();
        e.state.component = 'category';
        assert.strictEqual(e.H.isHome(), true);
        e.U.cardImgBackground(movie);
        await sleep(30);
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, 'Сердце зверя');

        ['category_full', 'favorite', 'full', 'actor', 'search'].forEach((c) => {
            e.state.component = c;
            assert.strictEqual(e.H.isHome(), false, c);
        });
    });

    await test('событие activity: класс возвращается, когда снова открыта главная', async () => {
        const e = makeEnv();

        e.H.on();
        assert.ok(e.listeners.some((l) => l.name === 'activity'), 'подписка на события активности');

        e.state.component = 'full';
        e.listeners[0].fn({ type: 'start' });
        await sleep(100);
        assert.ok(!e.body.classList.contains('lw-home'));

        e.state.component = 'main';
        e.listeners[0].fn({ type: 'start' });
        await sleep(100);
        assert.ok(e.body.classList.contains('lw-home'));
    });

    await test('текст идёт как текст: разметка в названии не создаёт элементов', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground({ id: 9, title: '<img src=x onerror=alert(1)>', overview: '<b>жирный</b>', backdrop_path: '/c.jpg' });
        await sleep(30);
        assert.strictEqual(e.doc.querySelectorAll('.lw-hero img, .lw-hero b').length, 0);
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, '<img src=x onerror=alert(1)>');
    });

    await test('кадр: адрес берётся у Лампы, новый проявляется поверх старого через два слоя', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        await sleep(30);
        assert.strictEqual(e.loads[0].url, 'https://img.test/t/p/w1280/a.jpg');
        e.loads[0].onload();

        const imgs = e.doc.querySelectorAll('.lw-hero__img');

        assert.ok(imgs[1].classList.contains('is-on') && !imgs[0].classList.contains('is-on'), 'первый кадр во втором слое');
        assert.ok(/a\.jpg/.test(imgs[1].style.backgroundImage));

        e.U.cardImgBackground(serial);
        await sleep(30);
        e.loads[1].onload();
        assert.ok(imgs[0].classList.contains('is-on') && !imgs[1].classList.contains('is-on'), 'второй кадр сменил первый');
    });

    await test('устаревший кадр не показывается, если фокус успел уйти дальше', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        await sleep(30);
        e.U.cardImgBackground(serial);
        await sleep(30);
        e.loads[0].onload(); // догрузился старый
        assert.strictEqual(e.doc.querySelectorAll('.lw-hero__img.is-on').length, 0, 'старый кадр отброшен');
        e.loads[1].onload();
        assert.strictEqual(e.doc.querySelectorAll('.lw-hero__img.is-on').length, 1);
    });

    await test('без кадра у карточки: тексты обновляются, картинка не трогается', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground({ id: 5, title: 'Без кадра', overview: 'нет' });
        await sleep(30);
        assert.strictEqual(e.doc.querySelector('.lw-hero__title').textContent, 'Без кадра');
        assert.strictEqual(e.loads.length, 0);
    });

    await test('выключение: герой и класс убраны, функции Лампы по-прежнему работают', async () => {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        await sleep(30);
        e.H.off();
        assert.strictEqual(e.doc.querySelector('.lw-hero'), null);
        assert.ok(!e.body.classList.contains('lw-home'));
        assert.strictEqual(e.U.cardImgBackground(serial), 'bg:2');
        await sleep(30);
        assert.strictEqual(e.doc.querySelector('.lw-hero'), null, 'после выключения герой не возвращается');
    });

    // ---- кнопки героя и пульт ----
    const enter = (e, el) => el.dispatchEvent(new e.win.Event('hover:enter'));
    const focusEv = (e, el) => el.dispatchEvent(new e.win.Event('hover:focus'));

    async function ready() {
        const e = makeEnv();

        e.H.on();
        e.U.cardImgBackground(movie);
        await sleep(30);

        return e;
    }

    await test('кнопки: «Подробнее» и «В закладки» — обычные .selector Лампы внутри героя', async () => {
        const e = await ready();
        const btns = e.doc.querySelectorAll('.lw-hero .lw-hero__btn.selector');

        assert.strictEqual(btns.length, 2);
        assert.strictEqual(btns[0].textContent, 'Подробнее');
        assert.strictEqual(btns[1].textContent, '+ В закладки');
    });

    await test('кнопки появляются только когда в герое есть карточка (класс is-ready)', async () => {
        const e = makeEnv();

        e.H.on();
        e.H.sync();
        assert.ok(e.doc.querySelector('.lw-hero'), 'каркас героя есть');
        assert.ok(!e.doc.querySelector('.lw-hero').classList.contains('is-ready'), 'карточки ещё нет: кнопки скрыты');

        e.U.cardImgBackground(movie);
        await sleep(30);
        assert.ok(e.doc.querySelector('.lw-hero').classList.contains('is-ready'));
    });

    await test('«Подробнее»: открывает карточку той же записью, что и Лампа (фильм и сериал)', async () => {
        const e = await ready();

        enter(e, e.doc.querySelector('.lw-hero__btn--main'));
        assert.strictEqual(e.pushes.length, 1);
        assert.strictEqual(e.pushes[0].component, 'full');
        assert.strictEqual(e.pushes[0].id, 1);
        assert.strictEqual(e.pushes[0].method, 'movie');
        assert.strictEqual(e.pushes[0].source, 'tmdb');
        assert.strictEqual(e.pushes[0].card, movie);

        e.U.cardImgBackground(serial);
        await sleep(30);
        enter(e, e.doc.querySelector('.lw-hero__btn--main'));
        assert.strictEqual(e.pushes[1].method, 'tv');
        assert.strictEqual(e.pushes[1].id, 2);
    });

    await test('«В закладки»: ставит и снимает закладку, подпись и уведомление меняются', async () => {
        const e = await ready();
        const fav = e.doc.querySelectorAll('.lw-hero__btn')[1];

        enter(e, fav);
        assert.deepStrictEqual(e.favs.calls[0], ['book', 1]);
        assert.strictEqual(fav.textContent, '✓ В закладках');
        assert.strictEqual(e.notes[0], 'Добавлено в закладки');

        enter(e, fav);
        assert.strictEqual(fav.textContent, '+ В закладки');
        assert.strictEqual(e.notes[1], 'Убрано из закладок');
    });

    await test('подпись закладки берётся с текущей карточки, а не с прошлой', async () => {
        const e = await ready();
        const fav = e.doc.querySelectorAll('.lw-hero__btn')[1];

        e.favs.book = true;
        e.U.cardImgBackground(serial);
        await sleep(30);
        assert.strictEqual(fav.textContent, '✓ В закладках');
    });

    await test('пульт: из первого ряда «вверх» ведёт на кнопки героя, а не в шапку', async () => {
        const e = await ready();

        e.ctrl.active = 'items_line';
        e.C.toggle('head');
        assert.strictEqual(e.ctrl.active, 'lw_hero');
        assert.ok(e.ctrl.controllers.lw_hero, 'контроллер героя зарегистрирован');

        e.ctrl.controllers.lw_hero.toggle();
        assert.strictEqual(e.ctrl.set, e.doc.querySelector('.lw-hero'), 'навигация только по кнопкам героя');
    });

    await test('пульт: с героя «вверх» в шапку, «вниз» и «назад» в ряды, из шапки «вниз» снова на героя', async () => {
        const e = await ready();
        const c = e.ctrl.controllers.lw_hero;

        e.ctrl.active = 'lw_hero';
        c.up();
        assert.strictEqual(e.ctrl.active, 'head', 'из героя в шапку');

        e.C.toggle('content');
        assert.strictEqual(e.ctrl.active, 'lw_hero', 'из шапки вниз снова на героя');

        c.down();
        assert.strictEqual(e.ctrl.active, 'content', 'вниз из героя в ряды');

        e.ctrl.active = 'lw_hero';
        c.back();
        assert.strictEqual(e.ctrl.active, 'content', 'назад из героя в ряды');
    });

    await test('пульт: вправо-влево между кнопками, влево с первой в меню', async () => {
        const e = await ready();
        const c = e.ctrl.controllers.lw_hero;
        const [more, fav] = e.doc.querySelectorAll('.lw-hero__btn');

        focusEv(e, more);
        c.right();
        assert.strictEqual(e.ctrl.focus, fav, 'вправо на «В закладки»');

        focusEv(e, fav);
        c.right();
        assert.strictEqual(e.ctrl.focus, fav, 'правее нет кнопки, фокус на месте');
        c.left();
        assert.strictEqual(e.ctrl.focus, more, 'влево на «Подробнее»');

        focusEv(e, more);
        c.left();
        assert.strictEqual(e.ctrl.active, 'menu', 'влево с первой кнопки в меню');
    });

    await test('пульт: вне главной, из меню и пока героя нет всё идёт как у Лампы', async () => {
        const e = makeEnv();

        e.H.on();
        e.C.toggle('head'); // героя ещё нет: карточка не выбрана
        assert.strictEqual(e.ctrl.active, 'head');

        e.U.cardImgBackground(movie);
        await sleep(30);

        e.ctrl.active = 'menu';
        e.C.toggle('head');
        assert.strictEqual(e.ctrl.active, 'head', 'из меню в шапку без героя');

        e.ctrl.active = 'items_line';
        e.state.component = 'full';
        e.C.toggle('head');
        assert.strictEqual(e.ctrl.active, 'head', 'на странице фильма шапка как раньше');
    });

    await test('пульт: подмена Controller.toggle ставится один раз и после выключения ничего не меняет', async () => {
        const e = await ready();
        const first = e.C.toggle;

        e.H.on();
        assert.strictEqual(e.C.toggle, first, 'повторное включение не оборачивает второй раз');

        e.ctrl.active = 'lw_hero';
        e.H.off();
        assert.strictEqual(e.ctrl.active, 'content', 'если фокус был на герое, он возвращается в ряды');

        e.ctrl.active = 'items_line';
        e.C.toggle('head');
        assert.strictEqual(e.ctrl.active, 'head', 'после выключения шапка как у Лампы');
    });

    await test('сборка: модуль hero стоит раньше theme и вшит в бандл', () => {
        const bundle = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'lampa_watch.js'), 'utf8');

        assert.ok(bundle.indexOf('LW.hero = ') >= 0 && bundle.indexOf('LW.hero = ') < bundle.indexOf('LW.theme = '));
    });

    let bad = 0;

    results.forEach(([ok, name]) => { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); });
    console.log('\n' + (results.length - bad) + '/' + results.length + ' passed');
    process.exit(bad ? 1 : 0);
})();
