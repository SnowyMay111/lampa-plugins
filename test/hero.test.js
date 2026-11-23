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
        Activity: { active: () => ({ component: state.component }) },
        Listener: { follow: (name, fn) => listeners.push({ name, fn }) },
        TMDB: { image: (u) => 'https://img.test/' + u }
    };

    const LW = {};

    new Function('LW', 'window', 'document', 'Image', CODE)(LW, win, win.document, FakeImage);
    LW.hero.delay = 5;

    return { LW, H: LW.hero, win, doc: win.document, body: win.document.body, U: win.Lampa.Utils, calls, listeners, loads, state };
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

    await test('сборка: модуль hero стоит раньше theme и вшит в бандл', () => {
        const bundle = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'lampa_watch.js'), 'utf8');

        assert.ok(bundle.indexOf('LW.hero = ') >= 0 && bundle.indexOf('LW.hero = ') < bundle.indexOf('LW.theme = '));
    });

    let bad = 0;

    results.forEach(([ok, name]) => { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); });
    console.log('\n' + (results.length - bad) + '/' + results.length + ' passed');
    process.exit(bad ? 1 : 0);
})();
